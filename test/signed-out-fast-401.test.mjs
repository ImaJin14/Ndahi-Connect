// Signed-out requests (every signed-out portal page asks for the dashboard,
// security and checkout-setup state) answer 401 without opening a store
// transaction, so they never queue behind, or hold up, other work. With a
// cookie, even a stale one, the full check still runs. Production on 20 Nov:
// these 401s took 2-10 s and a deploy smoke check timed out on them.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { checkoutSetupCookie } from "../lib/checkout-setup.mjs";

test("signed-out dashboard, security, setup and admin requests skip the store transaction", async (t) => {
  const store = createStore({ persistent: false });
  let transactions = 0;
  const transaction = store.transaction.bind(store);
  store.transaction = (...args) => { transactions++; return transaction(...args); };
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: "fast-401", ADMIN_SESSION_SECRET: "fast-401", SECRET_PEPPER: "fast-401",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, cookie) => {
    const response = await fetch(base + path, { headers: cookie ? { cookie } : {} });
    return { status: response.status, body: await response.json() };
  };
  const cases = [
    ["/api/account/dashboard", "customer_session=stale", { error: "Dashboard session expired. Please sign in again." }],
    ["/api/account/security", "customer_session=stale", { error: "Dashboard session expired. Please sign in again." }],
    ["/api/account/setup/checkout", `${checkoutSetupCookie}=stale`, null],
    ["/api/admin/dashboard", "admin_session=stale", { error: "Admin session expired." }],
    ["/api/admin/records?collection=audit", "admin_session=stale", { error: "Admin session expired." }],
  ];
  for (const [path, staleCookie, expected] of cases) {
    const before = transactions;
    const signedOut = await get(path);
    assert.equal(signedOut.status, 401, path);
    if (expected) assert.deepEqual(signedOut.body, expected, path);
    else assert.equal(signedOut.body.code, "SETUP_ACCESS_EXPIRED");
    assert.equal(transactions, before, `${path} without a cookie opens no transaction`);
    // A cookie that matches nothing still gets the full check, and the same answer.
    const checked = transactions;
    const stale = await get(path, staleCookie);
    assert.equal(stale.status, 401, `${path} with a stale cookie`);
    assert.ok(transactions > checked, `${path} with a cookie is still checked against the store`);
    assert.deepEqual(stale.body, signedOut.body, `${path}: the same answer either way`);
  }
});
