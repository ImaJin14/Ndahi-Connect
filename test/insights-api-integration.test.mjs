// Insights (#262) through the real admin router: only a signed-in owner reads
// recorded collections; every other role, and no session, is refused. The
// portal's anonymous funnel beacons are counted and appear in the owner's view.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

test("the admin router serves Insights to the owner only", async (t) => {
  const store = createStore({ persistent: false }), secret = "insights-integration-secret";
  await store.transaction((s) => {
    for (const role of ["owner", "operator", "auditor", "reseller"]) {
      s.adminUsers.push({ id: `staff-${role}`, username: role, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: `staff-${role}`, role, tokenHash: hashSecret(`token-${role}`, secret), csrfToken: `csrf-${role}`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    s.payments.push({ id: "p1", provider: "mesomb", providerReference: "mesomb-1", amount: 1500, currency: "XAF", status: "paid", confirmedAt: "2026-11-16T09:00:00Z" });
  });
  const server = createServer({ store, validateConfig: false, now: () => new Date("2026-11-16T10:00:00Z"), env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", CUSTOMER_APP_URL: "http://portal.test", OMADA_MODE: "standalone", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, path = `${base}/api/admin/insights?from=2026-11-15T23%3A00%3A00Z&to=2026-11-16T23%3A00%3A00Z`;
  // Funnel beacons: the portal's origin only, a known step and variant only.
  const beacon = (input, origin = "http://portal.test") => fetch(`${base}/api/telemetry/funnel`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) });
  for (const step of ["wifi_page", "wifi_page", "signed_in", "payment_started", "paid"]) assert.equal((await beacon({ step, variant: "v2" })).status, 204);
  assert.equal((await beacon({ step: "paid", variant: "v2" }, "http://evil.test")).status, 403);
  assert.equal((await beacon({ step: "paid", variant: "v2", phone: "670000001" })).status, 204, "extra fields are dropped, not stored");
  assert.equal((await beacon({ step: "refunded", variant: "v2" })).status, 400);
  const big = await fetch(`${base}/api/telemetry/funnel`, { method: "POST", headers: { origin: "http://portal.test" }, body: JSON.stringify({ step: "paid", variant: "v2", pad: "x".repeat(400) }) });
  assert.equal(big.status, 400);
  const rows = (await store.snapshot()).insightCounters;
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes("670000001"), false);
  const get = (role) => fetch(path, { headers: { ...(role ? { cookie: `admin_session=token-${role}` } : {}), origin: "http://admin.test" } });
  const owner = await get("owner");
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get("cache-control"), "no-store");
  const body = await owner.json();
  assert.deepEqual(body.collections.days, [{ date: "2026-11-16", collected: 1500, refunded: 0, net: 1500 }]);
  assert.equal(body.availability.accessPointLoad.status, "unavailable", "no estimate is offered for data that is not recorded");
  assert.equal(body.availability.accessPointLoad.reason, "access-points-run-standalone-without-a-controller");
  assert.deepEqual(body.funnel.variants.v2, { wifi_page: 2, signed_in: 1, payment_started: 1, paid: 2 });
  assert.equal(body.availability.funnel.status, "available");
  assert.equal(body.devices.status, "collecting");
  for (const role of ["operator", "auditor", "reseller"]) {
    const refused = await get(role);
    assert.equal(refused.status, 403, role);
    assert.equal((await refused.json()).collections, undefined, role);
  }
  assert.equal((await get(null)).status, 401);
  // A POST is not a route: no financial data and no state change.
  const post = await fetch(path, { method: "POST", headers: { cookie: "admin_session=token-owner", origin: "http://admin.test", "content-type": "application/json", "x-csrf-token": "csrf-owner" }, body: "{}" });
  assert.equal(post.status, 404);
});
