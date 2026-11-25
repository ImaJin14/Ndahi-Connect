import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

// GET /api/admin/cash?period= (#379): the Cash and settlements report for one
// period, to owners and operators; the dashboard opens on the last 7 days.
test("the cash report answers for each period, to owners and operators only", async (t) => {
  const secret = "cash-api-secret", now = new Date("2026-11-25T16:30:00Z"), store = createStore({ persistent: false });
  await store.transaction((s) => {
    for (const [id, role] of [["u-owner", "owner"], ["u-operator", "operator"], ["u-auditor", "auditor"], ["u-reseller", "reseller"]]) {
      s.adminUsers.push({ id, username: id, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: id, role, tokenHash: hashSecret(`${id}-token`, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    const paid = (id, network, amount, at) => ({ id, provider: "mesomb", providerReference: `ref-${id}`, network, amount, fee: amount / 50, total: amount * 1.02, currency: "XAF", status: "paid", createdAt: at, confirmedAt: at });
    s.payments.push(paid("today", "mtn", 2500, "2026-11-25T09:00:00Z"), paid("week", "orange", 1000, "2026-11-20T09:00:00Z"), paid("month", "mtn", 5000, "2026-11-05T09:00:00Z"));
  });
  const server = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret,
    CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const get = (user, path) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { cookie: `admin_session=${user}-token` } });
  const net = async (user, period) => { const body = await (await get(user, `/api/admin/cash?period=${period}`)).json(); return [body.period, body.networks.mtn.net, body.networks.orange.net]; };
  assert.deepEqual(await net("u-owner", "today"), ["today", 2500, 0]);
  assert.deepEqual(await net("u-operator", "week"), ["week", 2500, 1000]);
  assert.deepEqual(await net("u-owner", "month"), ["month", 7500, 1000]);
  assert.equal((await get("u-owner", "/api/admin/cash?period=year")).status, 400);
  for (const user of ["u-auditor", "u-reseller"]) assert.equal((await get(user, "/api/admin/cash?period=week")).status, 403, user);
  const dashboard = await (await get("u-owner", "/api/admin/dashboard")).json();
  assert.equal(dashboard.cashReport.period, "week");
  assert.equal(dashboard.cashReport.networks.orange.payments, 1);
  assert.equal(dashboard.cashCollected.from, "2026-11-01T00:00:00+01:00", "the fixed report stays for the v1 dashboard");
});
