// A receipt that cannot be emailed until the customer links an email (or turns
// transactional email back on) used to be retried on every 30-second billing pass,
// forever. It is now checked hourly, and on the next pass once the customer fixes it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createStore, createServer } from "../server.mjs";
import { createBillingService, receiptDue, receiptRecheckMs, retryBlockedReceipts } from "../lib/billing.mjs";
import { hashSecret } from "../lib/security.mjs";
import { silentLogger } from "../lib/logger.mjs";

const base = new Date("2030-04-01T10:00:00Z"), at = (ms) => new Date(+base + ms);

test("receipt work is due only when it can make progress", () => {
  const paid = { status: "paid", confirmedAt: at(0).toISOString() }, now = +at(0);
  assert.equal(receiptDue({ status: "pending" }, now), false, "unpaid payments have no receipt");
  assert.equal(receiptDue(paid, now), true, "a receipt never queued");
  for (const status of ["sent", "cancelled"]) assert.equal(receiptDue({ ...paid, receiptEmail: { status } }, now), false, status);
  assert.equal(receiptDue({ ...paid, receiptEmail: { status: "failed", attempts: 5, nextAttemptAt: at(-1).toISOString() } }, now), false, "attempts used up");
  assert.equal(receiptDue({ ...paid, receiptEmail: { status: "failed", attempts: 2 } }, now), false, "delivery stopped for good");
  assert.equal(receiptDue({ ...paid, receiptEmail: { status: "failed", attempts: 2, nextAttemptAt: at(60000).toISOString() } }, now), false, "waiting to retry");
  assert.equal(receiptDue({ ...paid, receiptEmail: { status: "failed", attempts: 2, nextAttemptAt: at(-1).toISOString() } }, now), true, "retry time reached");
  assert.equal(receiptDue({ ...paid, receiptEmail: { status: "sending", leaseUntil: at(5000).toISOString() } }, now), false, "another worker holds it");
  assert.equal(receiptDue({ ...paid, receiptEmail: { status: "sending", leaseUntil: at(-1).toISOString() } }, now), true, "an abandoned lease");
  for (const status of ["needs_email", "disabled"]) {
    assert.equal(receiptDue({ ...paid, receiptEmail: { status, recheckAt: at(60000).toISOString() } }, now), false, `${status} waits`);
    assert.equal(receiptDue({ ...paid, receiptEmail: { status, recheckAt: at(-1).toISOString() } }, now), true, `${status} hourly check`);
    assert.equal(receiptDue({ ...paid, receiptEmail: { status } }, now), true, `${status} recorded before this change, or nudged`);
  }
  const s = { payments: [{ customerId: "c", receiptEmail: { status: "needs_email", recheckAt: "x" } },
    { customerId: "c", receiptEmail: { status: "failed", recheckAt: "kept" } }, { customerId: "d", receiptEmail: { status: "disabled", recheckAt: "y" } }] };
  retryBlockedReceipts(s, "c");
  assert.deepEqual(s.payments.map((p) => p.receiptEmail.recheckAt), [undefined, "kept", "y"]);
});

async function seed(store, { email }) {
  await store.transaction((s) => {
    s.customers.push({ id: "c1", phone: "670000401", name: "Receipt Customer", ...(email ? { email, emailVerifiedAt: base.toISOString() } : {}) });
    s.payments.push({ id: "p1", customerId: "c1", status: "paid", confirmedAt: base.toISOString(), createdAt: base.toISOString(), provider: "mesomb",
      amount: 1000, currency: "XAF", planId: "weekly", planSnapshot: { id: "weekly", name: "Weekly", price: 1000 } });
  });
}

test("the billing worker checks a receipt blocked on a missing email hourly, not every pass", async () => {
  let now = base, sent = 0;
  const store = createStore({ persistent: false });
  await seed(store, { email: "" });
  const billing = createBillingService({ store, payments: {}, now: () => now, planFor: () => ({ id: "weekly", name: "Weekly" }), logger: silentLogger,
    email: { configured: () => true, async sendReceipt() { sent++; return { messageId: "m" }; } } });
  await billing.run();
  let p = (await store.snapshot()).payments[0];
  assert.equal(p.receiptEmail.status, "needs_email");
  assert.equal(p.receiptEmail.recheckAt, new Date(+now + receiptRecheckMs).toISOString());
  const checked = p.billingCheckedAt;
  now = at(30000);
  await billing.run();
  assert.equal((await store.snapshot()).payments[0].billingCheckedAt, checked, "the next pass leaves it alone");
  now = at(receiptRecheckMs + 1000);
  await billing.run();
  p = (await store.snapshot()).payments[0];
  assert.notEqual(p.billingCheckedAt, checked, "checked again after an hour");
  assert.equal(p.receiptEmail.recheckAt, new Date(+now + receiptRecheckMs).toISOString());
  // The customer confirms an email: the receipt goes out on the next pass.
  now = at(receiptRecheckMs + 60000);
  await store.transaction((s) => { Object.assign(s.customers[0], { email: "customer@example.test", emailVerifiedAt: now.toISOString() }); retryBlockedReceipts(s, "c1"); });
  await billing.run();
  p = (await store.snapshot()).payments[0];
  assert.deepEqual([p.receiptEmail.status, p.receiptEmail.recheckAt, sent], ["sent", undefined, 1]);
});

test("turning transactional email back on releases the customer's waiting receipts", async (t) => {
  let now = base, sent = 0;
  const store = createStore({ persistent: false }), secret = "receipt-backoff-secret", token = "t".repeat(43);
  await seed(store, { email: "customer@example.test" });
  await store.transaction((s) => {
    s.notificationStates.push({ id: "preferences:customer:c1", actor: "customer:c1", emailTransactions: false });
    s.dashboardSessions.push({ id: "s1", tokenHash: hashSecret(token, secret), customerId: "c1", role: "customer", csrfToken: "csrf",
      expiresAt: at(3600000).toISOString(), createdAt: base.toISOString(), lastSeenAt: base.toISOString() });
  });
  const server = createServer({ store, now: () => now, validateConfig: false, logger: silentLogger,
    email: { configured: () => true, async sendReceipt() { sent++; return { messageId: "m" }; } },
    env: { NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", CUSTOMER_SESSION_SECRET: secret,
      SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const handler = server.listeners("request")[0];
  await handler.billing.run();
  assert.equal((await store.snapshot()).payments[0].receiptEmail.status, "disabled");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/account/notifications`, { method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:8080", cookie: `customer_session=${token}`, "x-csrf-token": "csrf" },
    body: JSON.stringify({ action: "preferences", emailTransactions: true }) });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await store.snapshot()).payments[0].receiptEmail.recheckAt, undefined);
  now = at(30000);
  await handler.billing.run();
  assert.deepEqual([(await store.snapshot()).payments[0].receiptEmail.status, sent], ["sent", 1]);
});
