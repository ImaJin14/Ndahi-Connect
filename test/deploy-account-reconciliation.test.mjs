import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/api/state.mjs";
import { deployAccountReconciliation, openAccountBackup } from "../scripts/deploy-account-reconciliation.mjs";
import { createServer } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

const pepper = "synthetic-deployment-test-key", now = () => new Date("2030-01-01T00:00:00Z");
async function fixture() {
  const store = createStore({ persistent: false });
  await store.transaction(s => {
    s.customers.push({ id: "first", phone: "+237670180001", name: "Original Private", pinHash: "private-proof", createdAt: "2029-01-01T00:00:00Z" },
      { id: "later", phone: "670180001", name: "Later Private", emailVerificationRequired: true, createdAt: "2029-02-01T00:00:00Z" });
    s.payments.push({ id: "paid", customerId: "later", status: "paid", amount: 1000, payerPhone: "690180002", receipt: { amount: 1000 } });
    s.vouchers.push({ id: "v", customerId: "later", paymentId: "paid", status: "expired", quotaBytes: 5e9, usedBytes: 20 });
  });
  return store;
}
test("deployment applies safe repairs once and keeps an authenticated encrypted backup in the same transaction", async () => {
  const store = await fixture(), before = await store.snapshot();
  const result = await deployAccountReconciliation({ store, pepper, now }), after = await store.snapshot();
  assert.equal(result.status, "complete"); assert.equal(result.mergedCustomerCount, 1);
  assert.equal(after.customers.length, 1); assert.equal(after.customers[0].name, "Original Private");
  assert.equal(after.payments[0].customerId, "first"); assert.equal(after.vouchers[0].customerId, "first");
  const backup = after.zone.accountReconciliation.backup;
  assert.ok(!JSON.stringify(backup).includes("Later Private"));
  assert.deepEqual(openAccountBackup(backup, pepper).collections.customers.before, before.customers);
  assert.throws(() => openAccountBackup(backup, "wrong-key"));
  const again = await deployAccountReconciliation({ store, pepper, now });
  assert.equal(again.alreadyApplied, true); assert.deepEqual(await store.snapshot(), after);
});
test("competing credentials are left for review without loss of accounts or payment ownership", async () => {
  const store = await fixture(); await store.transaction(s => { s.customers[1].pinHash = "other-proof"; });
  const before = await store.snapshot(), result = await deployAccountReconciliation({ store, pepper, now }), after = await store.snapshot();
  assert.equal(result.status, "needs_review"); assert.equal(result.mergedCustomerCount, 0);
  assert.deepEqual(after.customers, before.customers); assert.deepEqual(after.payments, before.payments);
  assert.equal(after.zone.accountReconciliation.backup, undefined);
});
test("public deployment evidence exposes aggregate outcomes only", async t => {
  const store = await fixture(); await deployAccountReconciliation({ store, pepper, now });
  await store.transaction(s => {
    s.adminUsers.push({ id: "owner", username: "owner", role: "owner", active: true });
    s.adminSessions.push({ id: "owner-session", userId: "owner", tokenHash: hashSecret("owner-token", pepper), csrfToken: "csrf", expiresAt: "2031-01-01T00:00:00Z" });
  });
  const server = createServer({ store, now, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", ADMIN_SESSION_SECRET: pepper, ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test" } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/status`), body = await r.json();
  assert.equal(body.accountReconciliation.status, "complete");
  for (const secret of ["Original Private", "Later Private", "private-proof", "670180001", "backup", "ciphertext"])
    assert.equal(JSON.stringify(body).includes(secret), false);
  const admin = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/dashboard`, { headers: { origin: "http://admin.test", cookie: "admin_session=owner-token" } });
  assert.equal(admin.status, 200);
  const dashboard = await admin.json();
  assert.equal(dashboard.zone.accountReconciliation, undefined, "private encrypted backup is excluded even from the dashboard");
});
