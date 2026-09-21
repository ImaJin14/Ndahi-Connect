import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";

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
export function createRouterReconciler({ store, router, now = () => new Date() }) {
  async function reconcileOnce() {
    if (typeof router.readState !== "function") return { skipped: true };
    const state = await router.readState();
    const routerVouchers = new Map((state?.vouchers || []).map((v) => [v.voucherId, v.enabled === true])),
      routerSessions = new Map((state?.sessions || []).map((x) => [x.deviceId, x.active === true]));
    return store.transaction((s) => {
      let issues = 0;
      for (const v of s.vouchers) {
        const shouldBeEnabled = v.status === "active",
          actuallyEnabled = routerVouchers.get(v.id) === true,
          issue = shouldBeEnabled && !actuallyEnabled ? "missing_on_router"
            : !shouldBeEnabled && actuallyEnabled ? "still_enabled_on_router" : null;
        if (issue) {
          const action = issue === "missing_on_router" ? "sync_voucher" : "disconnect_voucher";
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
      for (const x of s.sessions) {
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
