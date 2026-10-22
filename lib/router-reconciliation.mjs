import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";
import { approvalPolicy } from "./wifi-approval.mjs";
import { hasSecondaryApprovals } from "./secondary-approval-expiry.mjs";

const timestamp = (now) => now().toISOString();
const positive = (value, fallback, max) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : fallback;
};
// Dead-lettered commands are deliberately included here: reconciliation must
// not silently reset one back to "queued" every pass, which would erase its
// attempt history and suppress the one-time dead-letter alert (NET-003) on a
// problem that is still unresolved. An operator's explicit replay is what
// should give it a fresh cycle.
const inFlight = (s, id) => ["queued", "processing", "retry", "dead_letter"].includes(
  (s.routerCommands || []).find((c) => c?.id === id)?.status,
);
const record = (s, now, type, meta) => {
  s.events.unshift({ id: randomUUID(), type, at: timestamp(now), meta });
  s.events = s.events.slice(0, 500);
};

export function routerReconciliationConfig(env = {}) {
  return {
    enabled: env.NETWORK_RECONCILIATION_ENABLED === "true" ||
      (env.NETWORK_RECONCILIATION_ENABLED !== "false" &&
        env.NODE_ENV === "production" && env.BOOTSTRAP_MODE !== "true"),
    intervalMs: positive(env.NETWORK_RECONCILIATION_INTERVAL_SECONDS, 300, 86400) * 1000,
  };
}

// Router reads deliberately run outside the state transaction, mirroring the
// payment reconciler. Drift found against the app's own voucher/session
// status is repaired through the same durable, idempotent command queue used
// elsewhere (NET-001) rather than calling the router directly.
export function createRouterReconciler({ store, router, now = () => new Date(), requireScopedDisconnect = false }) {
  async function reconcileOnce() {
    if (typeof router.readState !== "function") return { skipped: true };
    const state = await router.readState();
    const routerVouchers = new Map((state?.vouchers || []).map((v) => [v.voucherId, v.enabled === true])),
      stalePolicies = new Set((state?.vouchers || []).filter((v) => v.sessionPolicyReady === false).map((v) => v.voucherId)),
      publicPolicies = new Set((state?.vouchers || []).filter((v) => v.approvalPolicyReady !== true).map((v) => v.voucherId)),
      routerSessions = new Map((state?.sessions || []).map((x) => [x.deviceId, x.active === true]));
    return store.transaction((s) => {
      let issues = 0;
      for (const v of s.vouchers) {
        const shouldBeEnabled = v.status === "active",
          actuallyEnabled = routerVouchers.get(v.id) === true,
          issue = shouldBeEnabled && !actuallyEnabled ? "missing_on_router"
            : shouldBeEnabled && (stalePolicies.has(v.id) || approvalPolicy(s) && publicPolicies.has(v.id)) ? "session_policy_outdated"
            : !shouldBeEnabled && actuallyEnabled ? "still_enabled_on_router" : null;
        if (issue) {
          const action = ["missing_on_router", "session_policy_outdated"].includes(issue) ? "sync_voucher" : "disconnect_voucher";
          if (!inFlight(s, `router:${action}:${v.id}`)) enqueueRouterCommand(s, { action, targetId: v.id }, now);
        }
        const previous = v.networkReconciliation?.issue || null;
        v.networkReconciliation = { checkedAt: timestamp(now), issue: issue || null };
        if (issue && issue !== previous) {
          issues++;
          record(s, now, "network.reconciliation_issue", { voucherId: v.id, issue });
        } else if (!issue && previous) {
          record(s, now, "network.reconciliation_resolved", { voucherId: v.id });
        } else if (issue) issues++;
      }
      // Old browser UUIDs are not physical identities. In live mode presence
      // comes from usage/device readings, and only an explicit scoped request
      // may disconnect an observed session. Never retarget an old intent.
      const legacy = !requireScopedDisconnect && s.networkSetup?.runtimeRouterEnabled !== true;
      for (const x of (legacy && Array.isArray(state?.sessions) ? s.sessions : [])) {
        const shouldBeActive = x.status === "online",
          actuallyActive = routerSessions.get(x.deviceId) === true;
        if (shouldBeActive && !actuallyActive) {
          x.status = "inactive";
          x.disconnectedAt = timestamp(now);
          issues++;
          record(s, now, "network.reconciliation_issue", { deviceId: x.deviceId, issue: "session_not_on_router" });
        } else if (!shouldBeActive && actuallyActive) {
          issues++;
          if (!inFlight(s, `router:disconnect_device:${x.deviceId}`)) {
            enqueueRouterCommand(s, { action: "disconnect_device", targetId: x.deviceId }, now);
          }
        }
      }
      return { issues };
    });
  }
  let running;
  return function run() {
    if (running) return running;
    running = reconcileOnce().finally(() => { running = undefined; });
    return running;
  };
}

// Data quotas are only enforced across concurrent devices when usage is read
// regularly. Default to once a minute; 0 disables automatic reads.
export function routerUsageSyncConfig(env = {}) {
  return {
    enabled: env.NETWORK_USAGE_SYNC_SECONDS !== "0",
    intervalMs: positive(env.NETWORK_USAGE_SYNC_SECONDS, 60, 3600) * 1000,
  };
}

// Queues a usage read only against a real router with active vouchers. A
// dead-lettered read waits for an operator replay, like reconciliation.
export function createUsageSyncScheduler({ store, env = {}, now = () => new Date() }) {
  const id = "router:sync_usage:global";
  const due = (s) => (s.networkSetup?.runtimeRouterEnabled === true || (env.MIKROTIK_MODE === "live" && Boolean(env.MIKROTIK_API_URL))) &&
    (s.vouchers.some((v) => v.status === "active") || env.WIFI_SECONDARY_EXPIRY_ENABLED === "true" && hasSecondaryApprovals(s)) && !inFlight(s, id);
  return async function schedule() {
    if (!due(await store.snapshot())) return { queued: false };
    return store.transaction((s) => {
      if (!due(s)) return { queued: false };
      enqueueRouterCommand(s, { action: "sync_usage" }, now);
      return { queued: true };
    });
  };
}
