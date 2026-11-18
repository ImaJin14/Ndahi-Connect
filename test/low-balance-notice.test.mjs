// Customers whose Mobile Money balance cannot cover a bundle. No provider lets us
// read a payer's balance before the request, so: the checkout reminds them first
// (portal), and when the operator refuses the request for its balance, the payment
// closes at once as a confirmed failure with no money taken and a clear reason,
// instead of waiting out the five-minute approval window as "uncertain".
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHandler, createStore } from "../server.mjs";
import { MeSombPaymentAdapter, providerFailureCode } from "../lib/payments.mjs";
import { createBillingService, paymentView, recordGatewayFailure } from "../lib/billing.mjs";
import { silentLogger } from "../lib/logger.mjs";

const keys = { applicationKey: "synthetic-app", accessKey: "synthetic-access", secretKey: "synthetic-secret" };
const payment = { id: "pay-1", amount: 1000, currency: "XAF", payerPhone: "670000501", network: "mtn", customerName: "Ada Buyer", planId: "weekly" };

test("provider codes and wording map to a balance reason only when they name one", () => {
  for (const raw of [{ code: "subscriber-insufficient-balance" }, { detail: "insufficient balance in the account" },
    { code: "INSUFFICIENT_FUNDS_INITIATOR" }, { message: "Solde insuffisant" }]) assert.equal(providerFailureCode(raw), "low_balance", JSON.stringify(raw));
  for (const raw of [{ code: "CUSTOMER_BALANCE_INVALID" }, { reason: "LOW_BALANCE_OR_PAYEE_LIMIT_REACHED_OR_NOT_ALLOWED" },
    { detail: "Either the balance is low, or the payee has reached its limit or it is not allowed" }]) assert.equal(providerFailureCode(raw), "check_balance", JSON.stringify(raw));
  // MeSomb's catch-all lists several possible causes, so it names none.
  assert.equal(providerFailureCode({ code: "subscriber-internal-error", detail: "Issue during the processing. it can be: insufficient fund, timeout, wrong secret code..." }), null);
  for (const raw of [{ code: "subscriber-not-found" }, { code: "subscriber-limit-reached" }, { code: 400 }, {}]) assert.equal(providerFailureCode(raw), null, JSON.stringify(raw));
});

async function withFetch(reply, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => reply();
  try { return await fn(); } finally { globalThis.fetch = original; }
}
const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("MeSomb's balance refusal reaches billing as a refusal, through the real SDK", async () => {
  const adapter = new MeSombPaymentAdapter(keys);
  const refused = await withFetch(json(400, { detail: "insufficient balance in the account", code: "subscriber-insufficient-balance", support: "https://mesomb.example" }),
    () => adapter.createPayment(payment).then(() => null, (error) => error));
  assert.deepEqual(refused.refusal, { failureCode: "low_balance" });
  // Any other rejection, or a server error that merely mentions a balance, stays uncertain.
  for (const reply of [json(400, { detail: "This account does not exist", code: "subscriber-not-found" }),
    json(500, { detail: "insufficient balance", code: "subscriber-insufficient-balance" })]) {
    const error = await withFetch(reply, () => adapter.createPayment(payment).then(() => null, (e) => e));
    assert.ok(error instanceof Error);
    assert.equal(error.refusal, undefined);
  }
  // A failed operation in the response body carries the same answer.
  const failed = await new MeSombPaymentAdapter({ ...keys, client: { async makeCollect() {
    return { success: false, status: "FAIL", message: "Either the balance is low, or the payee has reached its limit", transaction: null };
  } } }).createPayment(payment).then(() => null, (e) => e);
  assert.deepEqual(failed.refusal, { failureCode: "check_balance" });
});

function billingFixture(createPayment) {
  const store = createStore({ persistent: false }), now = () => new Date("2030-05-01T10:00:00Z");
  const billing = createBillingService({ store, now, logger: silentLogger, planFor: () => null, settle: () => {},
    payments: { mesomb: { createPayment, async verifyPayment() { throw Object.assign(Error("missing"), { code: "PAYMENT_NOT_FOUND" }); } } } });
  return { store, billing, now };
}
const reserve = (store, now) => store.transaction((s) => {
  s.customers.push({ id: "c1", phone: "670000501" });
  s.payments.push({ ...payment, customerId: "c1", provider: "mesomb", status: "pending", creationState: "reserved", createdAt: now().toISOString(),
    paymentExpiresAt: new Date(+now() + 300000).toISOString(), paymentClosesAt: new Date(+now() + 300000).toISOString() });
});

test("a balance refusal closes the payment at once: failed, nothing taken, free to pay again", async () => {
  const f = billingFixture(async () => { throw Object.assign(Error("insufficient"), { refusal: { failureCode: "low_balance" } }); });
  await reserve(f.store, f.now);
  await f.billing.startPayment("pay-1");
  const p = (await f.store.snapshot()).payments[0], view = paymentView(p, { now: f.now() });
  assert.deepEqual([p.status, p.creationState, p.failureCode], ["failed", "refused", "low_balance"]);
  assert.match(p.failureReason, /balance was too low.*no money was taken/i);
  assert.deepEqual([view.failureCode, view.moneyTaken, view.blocksNewCheckout], ["low_balance", false, false]);
  // A later provider read without a reason keeps the balance reason.
  recordGatewayFailure(p, { status: "failed", failureCode: null }, f.now());
  assert.equal(p.failureCode, "low_balance");
});

test("any other submission error still waits for the provider instead of guessing", async () => {
  const f = billingFixture(async () => { throw Error("connection reset"); });
  await reserve(f.store, f.now);
  await f.billing.startPayment("pay-1");
  const p = (await f.store.snapshot()).payments[0];
  assert.deepEqual([p.status, p.creationState, p.failureCode], ["pending", "uncertain", undefined]);
  assert.equal(paymentView(p, { now: f.now() }).blocksNewCheckout, true, "no second charge while it may have gone through");
});

test("checkout answers straight away with the reason, and the customer can pay again", async (t) => {
  let balance = 0;
  const handler = createHandler({ store: createStore({ persistent: false }), validateConfig: false, logger: silentLogger,
    payments: { mesomb: { configured: () => true, async createPayment(p) {
      if (balance < p.amount) throw Object.assign(Error("insufficient"), { refusal: { failureCode: "check_balance" } });
      return { providerReference: `ref-${p.id}`, status: "pending" };
    }, async verifyPayment() { return { status: "pending" }; } } },
    env: { NODE_ENV: "test", PAYMENT_MODE: "mesomb", CUSTOMER_APP_URL: "http://customer.test", SECRET_PEPPER: "low-balance", CUSTOMER_SESSION_SECRET: "low-balance",
      BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  const server = await new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const purchase = (key) => fetch(`http://127.0.0.1:${server.address().port}/api/purchase`, { method: "POST",
    headers: { "content-type": "application/json", origin: "http://customer.test" },
    body: JSON.stringify({ phone: "670000502", name: "Guest", planId: "weekly", network: "mtn", requestKey: key }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const refused = await purchase("k".repeat(40));
  assert.equal(refused.status, 201);
  assert.deepEqual([refused.body.payment.status, refused.body.payment.failureCode, refused.body.payment.moneyTaken], ["failed", "check_balance", false]);
  assert.match(refused.body.checkout.message, /usually means the balance was too low/);
  balance = 5000;
  const retried = await purchase("m".repeat(40));
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(retried.body.payment.status, "pending");
});
