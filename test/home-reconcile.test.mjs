// Home WISP routers (AdminHomeRouters, #340; owner 26 Nov): the reconcile pass
// decides from the records and the Home users a router lists, and acts only
// through the Home worker's revoke and retry operations. These check the
// decisions and the page's view; the router itself is checked on-site
// (docs/operations/home-wisp-reconcile-onsite-test.md), never with a mock router.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { planHomeReconcile, applyHomeReconcile, homeRoutersView, reconcileDue, RECONCILE_EVERY_MS } from "../lib/home-reconcile.mjs";

const now = new Date("2030-01-10T09:00:00.000Z"), day = 864e5;
const t = (ms) => new Date(+now + ms).toISOString();
function state() {
  const s = { customers: [], vouchers: [], homeConnections: [], homeOperations: [], homeUsageObservations: [], homeChallenges: [] };
  const add = (id, opts) => {
    s.customers.push({ id, name: id.toUpperCase(), homeConnectionId: `h-${id}`, ...(opts.revokedAt ? { homeRevokedAt: opts.revokedAt } : {}) });
    s.homeConnections.push({ id: `h-${id}`, customerId: id, mac: `AA:BB:CC:00:00:0${s.customers.length}`, status: opts.linked === false ? "revoked" : "linked", generation: 2, updatedAt: t(-3600e3) });
    s.vouchers.push({ id: `v-${id}`, customerId: id, accessType: "home_wisp_unlimited", accessMode: "home", status: opts.status || "active", activatedAt: t(-5 * day),
      expiresAt: opts.expiresAt || t(20 * day), homeStatus: opts.homeStatus || "authorized", homeGeneration: 2, quotaBytes: null, usedBytes: 0, ...(opts.online ? { homeOnlineSince: t(-3600e3) } : {}) });
    if (opts.failed) s.homeOperations.push({ id: `op-${id}`, customerId: id, kind: "activate", status: "retry", attempts: 3, errorCode: "HOME_ROUTER_UNAVAILABLE" });
  };
  add("sharing", { online: true });
  add("idle", {});
  add("withheld", { online: true, failed: true });
  add("ended", { expiresAt: t(-day), status: "expired", homeStatus: "authorized" });
  add("gone", { linked: false, expiresAt: t(-2 * day), status: "expired", homeStatus: "revoked" });
  return s;
}

test("the plan: a Home user whose subscription ended, or of an older router, is stale; a failed change is retried", () => {
  const s = state();
  const users = [
    { name: "nh_1", comment: "ndahi:home:v-sharing:2" },
    { name: "nh_2", comment: "ndahi:home:v-ended:2" },
    { name: "nh_3", comment: "ndahi:home:v-idle:1" },
    { name: "nh_4", comment: "ndahi:home:v-unknown:1" },
    { name: "other", comment: "not ours" },
  ];
  const plan = planHomeReconcile(s, users, now);
  assert.equal(plan.checked, 4, "every linked router");
  assert.deepEqual(plan.stale.map((x) => [x.voucherId, x.customerId]), [["v-ended", "ended"], ["v-idle", "idle"], ["v-unknown", null]]);
  assert.deepEqual(plan.retry, [{ customerId: "withheld", operationId: "op-withheld" }]);
  // Without a router read, only the records decide (no stale users known).
  assert.deepEqual(planHomeReconcile(s, null, now).stale, []);
});

test("applying it queues the revokes and the retry through the Home worker, once, and records the run", () => {
  const s = state();
  const plan = planHomeReconcile(s, [{ comment: "ndahi:home:v-ended:2" }], now);
  const run = applyHomeReconcile(s, plan, now, { trigger: "manual" });
  assert.deepEqual([run.checked, run.stale, run.retried, run.trigger], [4, 1, 1, "manual"]);
  assert.equal(s.homeOperations.filter((o) => o.kind === "revoke" && o.customerId === "ended").length, 1);
  assert.equal(s.homeOperations.find((o) => o.id === "op-withheld").status, "queued");
  // A second pass doesn't queue the same revoke twice.
  applyHomeReconcile(s, planHomeReconcile(s, [{ comment: "ndahi:home:v-ended:2" }], now), now);
  assert.equal(s.homeOperations.filter((o) => o.kind === "revoke" && o.customerId === "ended").length, 1);
  assert.equal(reconcileDue(s, now), false);
  assert.equal(reconcileDue(s, new Date(+now + RECONCILE_EVERY_MS)), true);
});

test("the page's view: each router's state, the counts and recent changes", () => {
  const s = state();
  applyHomeReconcile(s, planHomeReconcile(s, [], now), now);
  const view = homeRoutersView(s, now);
  const rows = Object.fromEntries(view.rows.map((r) => [r.customerId, [r.router, r.sharing, r.mac.startsWith("••:••:••:")]]));
  assert.deepEqual(rows, { sharing: ["online", "sharing", true], idle: ["offline", "idle", true], withheld: ["online", "withheld", true], ended: ["disconnected", "removed", true], gone: ["disconnected", "removed", true] });
  assert.deepEqual(view.metrics, { registered: 3, sharing: 2, withheld: 1, stale: 0 }, "as drawn, idle routers count as sharing");
  assert.equal(view.rows.find((r) => r.customerId === "ended").expiredAt, t(-day));
  assert.equal(view.recent[0].kind, "reconciled");
});

test("Reconcile now: off while Home is off; with Home on it runs and answers with the page", async (t) => {
  const secret = "home-reconcile";
  for (const enabled of [false, true]) {
    const store = createStore({ persistent: false });
    await store.transaction((s) => {
      s.adminUsers.push({ id: "owner", username: "owner", role: "owner", active: true, passkeys: [] });
      s.adminSessions.push({ userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    });
    const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test",
      PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", LOG_LEVEL: "silent", ...(enabled ? { NDAHI_HOME_ENABLED: "true" } : {}) } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/home/reconcile`, { method: "POST", headers: { cookie: "admin_session=owner", origin: "http://admin.test", "x-csrf-token": "csrf", "content-type": "application/json" }, body: "{}" });
    const body = await r.json();
    if (!enabled) assert.deepEqual([r.status, body.error], [409, "Home WISP is off, so there's nothing to reconcile yet."]);
    else {
      assert.equal(r.status, 200);
      assert.deepEqual([body.run.trigger, body.run.checked, body.run.routerRead], ["manual", 0, false], "the mock router can't list Home users");
      assert.deepEqual(body.routers.metrics, { registered: 0, sharing: 0, withheld: 0, stale: 0 });
    }
  }
});
