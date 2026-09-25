import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { createBillingService, ensureReceipt, receiptDocument } from "../lib/billing.mjs";
import { FlutterwavePaymentAdapter, flutterwaveRefund, MeSombPaymentAdapter } from "../lib/payments.mjs";
import { ResendEmailAdapter } from "../lib/email.mjs";

async function fixture(t, { payments, email, now, store = createStore({ persistent: false }), env = {} } = {}) {
  const server = createServer({ store, payments, email, now, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock",
    OMADA_MODE: "not-configured", SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false",
    ADMIN_PIN: "9999", ...env,
  } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, jar = {};
  const call = async (path, method = "GET", data, cookieOverride) => {
    const response = await fetch(base + path, { method,
      headers: { "content-type": "application/json", cookie: cookieOverride ?? Object.values(jar).join("; ") },
      body: data ? JSON.stringify(data) : undefined });
    const cookie = response.headers.get("set-cookie");
    if (cookie) jar[cookie.split("=")[0]] = cookie.split(";")[0];
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { /* receipt HTML */ }
    return { response, json, text };
  };
  return { store, call, jar };
}
const input = (extra = {}) => ({ phone: "670010001", name: "Test Customer", email: "billing@example.test",
  planId: "weekly", network: "mtn", requestKey: "checkout-one", ...extra });
async function account(f) {
  const purchase = await f.call("/api/purchase", "POST", input());
  assert.equal(purchase.response.status, 201);
  const id = purchase.json.payment.id;
  const paid = await f.call(`/api/payments/${id}/confirm`, "POST");
  assert.equal(paid.response.status, 200);
  await f.call("/api/account/setup/pin", "POST", { phone: input().phone, code: paid.json.access.code, pin: "2468", confirmPin: "2468" });
  return id;
}

test("BILL-001 reserves before provider IO and serializes distinct checkout keys across requests", async (t) => {
  let release, entered;
  const enteredPromise = new Promise((r) => { entered = r; });
  const hold = new Promise((r) => { release = r; });
  let creates = 0;
  const f = await fixture(t, { env: { PAYMENT_MODE: "mesomb" }, payments: { mesomb: {
    async createPayment() { creates++; entered(); await hold; throw Error("response lost after charge"); },
    async verifyPayment(p) { return { status: "pending", providerReference: "provider-1", transactionReference: p.id, amount: p.amount, currency: p.currency }; },
  } } });
  const first = f.call("/api/purchase", "POST", input());
  await enteredPromise;
  const persisted = await f.store.snapshot();
  assert.equal(persisted.payments.length, 1);
  assert.equal(persisted.payments[0].creationState, "submitted");
  const duplicate = await f.call("/api/purchase", "POST", input());
  assert.equal(duplicate.response.status, 200);
  const otherKey = await f.call("/api/purchase", "POST", input({ requestKey: "other-tab" }));
  assert.equal(otherKey.response.status, 409);
  assert.equal(otherKey.json.code, "PAYMENT_IN_PROGRESS");
  release();
  const original = await first;
  assert.equal(original.response.status, 201);
  assert.equal(original.json.payment.id, duplicate.json.payment.id);
  assert.match(original.json.payment.recoveryMessage, /may have reached/);
  const restarted = await fixture(t, { store: f.store, env: { PAYMENT_MODE: "mesomb" }, payments: { mesomb: {
    async createPayment() { creates++; throw Error("must not resend"); },
  } } });
  const recovered = await restarted.call("/api/purchase", "POST", input());
  assert.equal(recovered.json.payment.id, original.json.payment.id);
  assert.equal(creates, 1);
});

test("BILL-001 persists nothing and contacts no provider when reservation storage fails", async (t) => {
  const real = createStore({ persistent: false }); let creates = 0;
  const f = await fixture(t, { store: { ...real, transaction: async () => { throw Error("storage unavailable"); } },
    env: { PAYMENT_MODE: "mesomb" }, payments: { mesomb: { async createPayment() { creates++; } } } });
  await f.call("/api/purchase", "POST", input());
  assert.equal(creates, 0);
});

test("BILL-001 timeout never releases a charge; verified late payment settles only once", async (t) => {
  let time = new Date("2026-09-25T12:00:00Z"), checks = 0, creates = 0;
  const f = await fixture(t, { now: () => time, env: { PAYMENT_MODE: "mesomb" }, payments: { mesomb: {
    async createPayment() { creates++; return { providerReference: "ref-123" }; },
    async verifyPayment(p) {
      if (++checks === 1) throw Error("temporary outage");
      return { status: "paid", providerReference: "ref-123", transactionReference: p.id, amount: p.amount, currency: p.currency };
    },
  } } });
  const p = (await f.call("/api/purchase", "POST", input())).json.payment;
  time = new Date(+time + 3600000);
  let status = await f.call(`/api/payments/${p.id}/status`);
  assert.equal(status.json.payment.status, "pending");
  assert.equal((await f.call("/api/purchase", "POST", input({ requestKey: "retry" }))).response.status, 409);
  time = new Date(+time + 6000);
  status = await f.call(`/api/payments/${p.id}/status`);
  assert.equal(status.json.payment.status, "paid");
  await f.call(`/api/payments/${p.id}/status`);
  assert.equal((await f.store.snapshot()).vouchers.length, 1);
  assert.equal(creates, 1);
});

test("BILL-001 mismatched verification cannot release or fulfill a payment; provider failure allows retry", async (t) => {
  let time = new Date(), mismatch = true;
  const f = await fixture(t, { now: () => time, env: { PAYMENT_MODE: "mesomb" }, payments: { mesomb: {
    async createPayment() { return { providerReference: crypto.randomUUID() }; },
    async verifyPayment(p) { return { status: "failed", providerReference: p.providerReference, transactionReference: p.id,
      amount: mismatch ? 1 : p.amount, currency: p.currency }; },
  } } });
  const p = (await f.call("/api/purchase", "POST", input())).json.payment;
  assert.equal((await f.call(`/api/payments/${p.id}/status`)).json.payment.status, "pending");
  mismatch = false; time = new Date(+time + 6000);
  assert.equal((await f.call(`/api/payments/${p.id}/status`)).json.payment.status, "failed");
  assert.equal((await f.call("/api/purchase", "POST", input({ requestKey: "new-confirmed-retry" }))).response.status, 201);
});

test("BILL-002 receipt ownership, frozen allowances, safe HTML and email failure recovery", async (t) => {
  let failed = true, calls = 0, time = new Date();
  const f = await fixture(t, { now: () => time, email: { configured: () => true, sendVoucher: async () => ({}),
    async sendReceipt({ receipt }) { calls++; assert.equal(receipt.plan.name, "Weekly"); if (failed) throw Error("mail down"); return { messageId: "mail-1" }; },
  } });
  const id = await account(f);
  assert.equal((await f.call(`/api/account/payments/${id}/receipt`, "GET", null, "")).response.status, 401);
  await f.store.transaction((s) => { s.payments[0].planSnapshot.name = "Changed catalogue <script>bad()</script>"; });
  const receipt = await f.call(`/api/account/payments/${id}/receipt`);
  assert.equal(receipt.response.status, 200);
  assert.match(receipt.response.headers.get("content-disposition"), /attachment/);
  assert.match(receipt.text, /Weekly/);
  assert.doesNotMatch(receipt.text, /Changed catalogue/);
  let response = await f.call("/api/account/payments/receipt-email", "POST", { paymentId: id });
  assert.equal(response.json.payment.receiptEmail.status, "failed");
  assert.equal((await f.call(`/api/account/payments/${id}/receipt`)).response.status, 200);
  failed = false; time = new Date(+time + 61000);
  response = await f.call("/api/account/payments/receipt-email", "POST", { paymentId: id });
  assert.equal(response.json.payment.receiptEmail.status, "sent");
  await f.call("/api/account/payments/receipt-email", "POST", { paymentId: id });
  assert.equal(calls, 2);
  await f.store.transaction((s) => { s.dashboardSessions[0].customerId = "another-customer"; });
  assert.equal((await f.call(`/api/account/payments/${id}/receipt`)).response.status, 404);
  assert.equal((await f.call("/api/account/payments/receipt-email", "POST", { paymentId: id })).response.status, 404);
  assert.equal((await f.call("/api/account/payments/refund", "POST", { paymentId: id })).response.status, 404);
});

test("BILL-002 historical paid transactions have receipts without exposing activation codes", () => {
  const p = { id: "old", status: "paid", planId: "legacy", createdAt: "2025-01-01", amount: 500, currency: "XAF", provider: "mesomb", providerReference: "ref", customerName: "<script>alert(1)</script>" };
  const receipt = ensureReceipt(p, { name: "Historical", quotaGb: null, validityHours: 24, deviceLimit: 1 });
  const html = receiptDocument(receipt);
  assert.match(html, /ref/); assert.match(html, /Unlimited/); assert.doesNotMatch(html, /<script>/);
});

test("BILL-003 customer request, administrator approval, and provider confirmation share one refund", async (t) => {
  let refunds = 0, time = new Date(), refundStatus = "pending";
  const { MockPaymentAdapter } = await import("../lib/payments.mjs");
  const adapter = new MockPaymentAdapter();
  adapter.refundPayment = async () => { refunds++; return { status: "pending", providerReference: "refund-1" }; };
  adapter.verifyRefund = async () => ({ status: refundStatus, providerReference: "refund-1" });
  const f = await fixture(t, { now: () => time, payments: { mock: adapter } });
  const id = await account(f);
  const requested = await f.call("/api/account/payments/refund", "POST", { paymentId: id, reason: "Service unavailable" });
  assert.equal(requested.json.payment.refund.status, "requested");
  await f.call("/api/account/payments/refund", "POST", { paymentId: id });
  assert.equal(refunds, 0);
  await f.call("/api/admin/login", "POST", { pin: "9999" });
  const approved = await f.call("/api/admin/payments/refund", "POST", { paymentId: id });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.json.payment.refund.status, "pending");
  await f.call("/api/admin/payments/refund", "POST", { paymentId: id });
  assert.equal(refunds, 1);
  let status = await f.call(`/api/account/payments/${id}/status`);
  assert.equal(status.json.payment.refund.status, "pending");
  refundStatus = "completed"; time = new Date(+time + 31000);
  status = await f.call("/api/admin/payments/refund/check", "POST", { paymentId: id });
  assert.equal(status.json.payment.refund.status, "completed");
  const customer = await f.call("/api/account/dashboard");
  assert.equal(customer.json.payments[0].refund.status, "completed");
  assert.equal(customer.json.activeBundle, null);
  assert.equal((await f.call(`/api/account/payments/${id}/receipt`)).response.status, 200);
  assert.equal((await f.call(`/api/payments/${id}/confirm`, "POST")).response.status, 409);
});

test("BILL-003 an uncertain refund is persisted and never submitted twice after restart", async (t) => {
  let refunds = 0;
  const { MockPaymentAdapter } = await import("../lib/payments.mjs");
  const adapter = new MockPaymentAdapter();
  adapter.refundPayment = async () => { refunds++; throw Error("lost response"); };
  const f = await fixture(t, { payments: { mock: adapter } });
  const id = await account(f);
  await f.call("/api/admin/login", "POST", { pin: "9999" });
  await f.call("/api/admin/payments/refund", "POST", { paymentId: id });
  const service = createBillingService({ store: f.store, payments: { mock: adapter }, planFor: () => null });
  await service.submitRefund(id);
  const p = (await f.store.snapshot()).payments[0];
  assert.equal(p.refund.status, "pending"); assert.ok(p.refund.submittedAt);
  assert.match(p.refund.message, /may have succeeded/); assert.equal(refunds, 1);
});

test("BILL-003 Flutterwave request completion is pending until payout and explicit failure wins", () => {
  assert.equal(flutterwaveRefund({ status: "completed", id: 1 }).status, "pending");
  assert.equal(flutterwaveRefund({ status: "success", id: 1 }).status, "pending");
  assert.equal(flutterwaveRefund({ status: "completed-momo", id: 1 }).status, "completed");
  assert.equal(flutterwaveRefund({ status: "completed", meta: '{"disburse_status":"failed"}' }).status, "failed");
});

test("BILL-001 Flutterwave can recover a lost create response using the original reference", async () => {
  const original = globalThis.fetch; let url;
  globalThis.fetch = async (value) => { url = value; return new Response(JSON.stringify({ data: { id: 42, tx_ref: "payment-42", amount: 500, currency: "XAF", status: "successful" } })); };
  try {
    const adapter = new FlutterwavePaymentAdapter({ secretKey: "test", secretHash: "test" });
    const result = await adapter.verifyPayment({ id: "payment-42" });
    assert.match(url, /verify_by_reference\?tx_ref=payment-42/); assert.equal(result.status, "paid");
  } finally { globalThis.fetch = original; }
});

test("BILL-002 receipt email carries the same provider reference and stable idempotency key", async () => {
  let sent;
  const adapter = new ResendEmailAdapter({ apiKey: "test", from: "receipts@example.test", fetcher: async (_url, options) => {
    sent = options; return new Response(JSON.stringify({ id: "sent" }));
  } });
  const receipt = ensureReceipt({ id: "p1", status: "paid", planId: "weekly", amount: 500, currency: "XAF", provider: "mesomb", providerReference: "provider-42" }, { name: "Weekly", quotaGb: 3, deviceLimit: 1, validityHours: 168 });
  await adapter.sendReceipt({ to: "customer@example.test", receipt });
  assert.equal(sent.headers["idempotency-key"], "payment-receipt/p1");
  assert.match(JSON.parse(sent.body).html, /provider-42/);
});

test("BILL-001 guest recovery reads the original checkout even after its plan is discontinued", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => s.bundles.push({ id: "temporary", name: "Temporary package", price: 500, quotaGb: 2, validityHours: 48, deviceLimit: 1 }));
  const created = await f.call("/api/purchase", "POST", input({ planId: "temporary" }));
  await f.store.transaction((s) => { s.bundles[0].discontinued = true; });
  const recovered = await f.call("/api/purchase/recover", "POST", input());
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.json.payment.id, created.json.payment.id);
  assert.equal((await f.call("/api/purchase/recover", "POST", input({ requestKey: "wrong-key" }))).response.status, 404);
  assert.equal((await f.call(`/api/payments/${created.json.payment.id}/confirm`, "POST")).response.status, 200);
  assert.equal((await f.store.snapshot()).payments[0].receipt.plan.name, "Temporary package");
});

test("BILL-003 legacy refund-pending records cannot issue another refund", async () => {
  const store = createStore({ persistent: false }); let calls = 0;
  const service = createBillingService({ store, payments: { mock: { async refundPayment() { calls++; } } } });
  await store.transaction((s) => { const p = { id: "legacy", provider: "mock", status: "refund-pending" }; s.payments.push(p); service.requestRefund(p); });
  await service.submitRefund("legacy");
  assert.equal(calls, 0);
  assert.equal((await store.snapshot()).payments[0].refund.status, "pending");
});

test("BILL-003 refund confirmation cannot disconnect a newer replacement package", async (t) => {
  const f = await fixture(t);
  const id = await account(f);
  const replacement = await f.call("/api/account/plan/purchase", "POST", { action: "switch", planId: "monthly", requestKey: "new-plan" });
  const paid = await f.call(`/api/payments/${replacement.json.payment.id}/confirm`, "POST");
  await f.call("/api/admin/login", "POST", { pin: "9999" });
  await f.call("/api/admin/payments/refund", "POST", { paymentId: id });
  const dashboard = await f.call("/api/account/dashboard");
  assert.equal(dashboard.json.activeBundle.id, paid.json.voucher.id);
});

test("BILL-003 refund failures stay visible and manual payment overrides cannot reopen the charge", async (t) => {
  const { MockPaymentAdapter } = await import("../lib/payments.mjs");
  const adapter = new MockPaymentAdapter();
  adapter.refundPayment = async () => ({ status: "failed", providerReference: "failed-refund" });
  const f = await fixture(t, { payments: { mock: adapter } });
  const id = await account(f);
  await f.call("/api/admin/login", "POST", { pin: "9999" });
  const failed = await f.call("/api/admin/payments/refund", "POST", { paymentId: id });
  assert.equal(failed.json.payment.refund.status, "failed");
  assert.equal(failed.json.payment.status, "paid");
  assert.equal((await f.call("/api/admin/payments/status", "POST", { paymentId: id, status: "failed" })).response.status, 409);
});

test("BILL-002 worker retries receipt delivery for historical payments", async () => {
  const store = createStore({ persistent: false }); let deliveries = 0;
  await store.transaction((s) => {
    s.customers.push({ id: "c", email: "test@example.test" });
    s.payments.push({ id: "p", customerId: "c", status: "paid", amount: 500, currency: "XAF", provider: "mock", planId: "weekly" });
  });
  const service = createBillingService({ store, payments: {}, planFor: () => ({ name: "Weekly" }), email: { async sendReceipt() { deliveries++; return { messageId: "mail" }; } } });
  await service.run(); await service.run();
  assert.equal(deliveries, 1);
  assert.equal((await store.snapshot()).payments[0].receiptEmail.status, "sent");
});
