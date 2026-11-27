// Home WISP routers (canvas: AdminHomeRouters, #340; owner 26 Nov): the
// reconcile pass and what the page shows.
//
// Every 5 minutes, after a Home change fails, and on Reconcile now, the pass
// re-checks each registered router's entitlement and removes stale sharing
// exceptions. It decides here, from the server's records and the Home users
// the router lists (`ndahi:home:<voucher>:<generation>`), and acts through the
// Home worker's existing operations (revoke, retry), never by itself. It is
// router work: it runs only while Home is on (NDAHI_HOME_ENABLED), with the
// on-site plan in docs/operations/home-wisp-reconcile-onsite-test.md.
//
// - Stale: the router still holds a Home user whose subscription has ended,
//   was revoked, or belongs to an older router generation -> revoke.
// - Withheld: the subscription is active but its last Home change failed or
//   waits for review -> retry it (sharing stays withheld until it succeeds).
// A MAC alone never authorises sharing: only a linked, active subscription on
// its registered router does (home-wisp.mjs).
import { ensureHome, currentHome, usable, queueHome } from "./home.mjs";

export const RECONCILE_EVERY_MS = 5 * 60_000;
const COMMENT = /^ndahi:home:([^:]+):(.+)$/;
const maskMac = (mac) => `••:••:••:${String(mac || "").toUpperCase().split(":").slice(-3).join(":")}`;
const pending = (o) => ["queued", "processing", "retry"].includes(o.status);

// The Home subscription a customer's router shares: their newest Home voucher.
const homeVoucher = (s, customerId) => s.vouchers.filter((v) => v.customerId === customerId && (v.accessMode === "home" || v.accessType === "home_wisp_unlimited"))
  .sort((a, b) => (Date.parse(b.activatedAt || b.createdAt) || 0) - (Date.parse(a.activatedAt || a.createdAt) || 0))[0];

// What to do, from the records and the router's Home users (null: not read).
export function planHomeReconcile(s, routerUsers, now) {
  ensureHome(s);
  const stale = [], retry = [], checked = new Set();
  for (const link of s.homeConnections.filter((h) => h.status === "linked")) {
    const v = homeVoucher(s, link.customerId);
    checked.add(link.customerId);
    if (!v) continue;
    const ops = s.homeOperations.filter((o) => o.customerId === link.customerId);
    const failed = ops.filter((o) => ["retry", "needs_review"].includes(o.status) && o.kind !== "revoke");
    if (usable(v, now) && v.homeStatus !== "revoked" && failed.length) retry.push(...failed.map((o) => ({ customerId: link.customerId, operationId: o.id })));
  }
  for (const user of routerUsers || []) {
    const match = COMMENT.exec(String(user.comment || ""));
    if (!match) continue;
    const [, voucherId, generation] = match, v = s.vouchers.find((x) => x.id === voucherId);
    const link = v && currentHome(s, v.customerId);
    const current = v && link && usable(v, now) && String(v.homeGeneration) === generation && v.homeStatus !== "revoked";
    if (current) continue;
    stale.push({ voucherId, customerId: v?.customerId || null, generation, revoking: Boolean(v?.customerId && s.homeOperations.some((o) => o.customerId === v.customerId && o.kind === "revoke" && pending(o))) });
  }
  return { checked: checked.size, stale, retry };
}

// Queues the fixes and records the run. Returns what the page reports.
export function applyHomeReconcile(s, plan, now, { trigger = "schedule", routerRead = true } = {}) {
  ensureHome(s);
  for (const item of plan.stale) if (item.customerId && !item.revoking) queueHome(s, "revoke", item.customerId, now, { reason: "stale_exception", voucherId: item.voucherId });
  for (const { operationId } of plan.retry) {
    const op = s.homeOperations.find((o) => o.id === operationId);
    if (op && ["retry", "needs_review"].includes(op.status)) Object.assign(op, { status: "queued", attempts: 0, nextAttemptAt: new Date(now).toISOString() });
  }
  const run = { at: new Date(now).toISOString(), trigger, checked: plan.checked, stale: plan.stale.length, retried: plan.retry.length, routerRead };
  s.homeUsageObservations.push({ id: `reconcile:${run.at}`, type: "reconcile.completed", customerId: null, ...run });
  return run;
}

const lastRun = (s) => (s.homeUsageObservations || []).filter((o) => o.type === "reconcile.completed").sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null;
export const reconcileDue = (s, now) => { const run = lastRun(s); return !run || +new Date(now) - Date.parse(run.at) >= RECONCILE_EVERY_MS; };

// The page (canvas: AdminHomeRouters): metrics, a row per registered router
// (and recently removed ones), and recent changes.
export function homeRoutersView(s, now) {
  ensureHome(s);
  const at = +new Date(now), run = lastRun(s), names = new Map(s.customers.map((c) => [c.id, c.name || ""]));
  const rows = [];
  for (const link of s.homeConnections.filter((h) => h.status === "linked" || Date.parse(h.updatedAt || h.revokedAt || 0) > at - 7 * 864e5)) {
    if (rows.some((r) => r.customerId === link.customerId)) continue;
    const v = homeVoucher(s, link.customerId), active = Boolean(v && usable(v, now)) && link.status === "linked";
    const ops = s.homeOperations.filter((o) => o.customerId === link.customerId);
    // Withheld until a failed change succeeds, including while its retry waits in the queue.
    const failing = ops.some((o) => o.kind !== "revoke" && (["retry", "needs_review"].includes(o.status) || (pending(o) && o.errorCode)));
    const online = Boolean(v?.homeOnlineSince) && active;
    const sharing = !active ? "removed" : failing || !["authorized", "synced", "active"].includes(v.homeStatus || "") ? "withheld" : online ? "sharing" : "idle";
    const customer = s.customers.find((c) => c.id === link.customerId);
    // Removed by staff (Revoke) or by the subscription ending ("Expired 08:00").
    const revokedAt = v?.status === "revoked" ? v.revokedAt || customer?.homeRevokedAt || null : customer?.homeRevokedAt || null;
    rows.push({ customerId: link.customerId, name: names.get(link.customerId) || "", mac: maskMac(link.mac), endsAt: v?.expiresAt || null, ended: !active,
      router: !active ? "disconnected" : online ? "online" : "offline", sharing, checkedAt: run?.at || null, revocable: active,
      ...(!active ? (revokedAt ? { revokedAt } : { expiredAt: v?.expiresAt || null }) : {}) });
  }
  const recent = [
    ...(s.homeUsageObservations || []).filter((o) => o.type === "authorization.cutoff_confirmed").map((o) => ({ kind: "cutoff", at: o.at, customer: names.get(o.customerId) || "", reason: o.reason || null })),
    ...(s.homeOperations || []).filter((o) => o.kind === "replace" && o.status === "processed").map((o) => ({ kind: "replaced", at: o.processedAt || o.updatedAt || o.createdAt, customer: names.get(o.customerId) || "",
      from: o.previousMac ? maskMac(o.previousMac).slice(-8) : null, to: o.mac ? maskMac(o.mac).slice(-8) : null })),
    ...(s.homeUsageObservations || []).filter((o) => o.type === "reconcile.completed").map((o) => ({ kind: "reconciled", at: o.at, checked: o.checked, stale: o.stale, trigger: o.trigger })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6);
  return {
    lastReconciledAt: run?.at || null, everyMinutes: RECONCILE_EVERY_MS / 60_000,
    // As drawn, "sharing now" counts idle routers too (sharing applies when they reconnect).
    metrics: { registered: rows.filter((r) => !r.ended).length, sharing: rows.filter((r) => ["sharing", "idle"].includes(r.sharing)).length, withheld: rows.filter((r) => r.sharing === "withheld").length, stale: run?.stale ?? 0 },
    rows, recent,
  };
}
