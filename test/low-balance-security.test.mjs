// Security and money-safety regressions for balance refusals. Closing a payment
// early must never be something a caller can trigger, never follow from wording
// alone, and never lose a payment the provider later confirms.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHandler, createStore } from "../server.mjs";
import { MeSombPaymentAdapter } from "../lib/payments.mjs";
import { silentLogger } from "../lib/logger.mjs";

async function serve(t, adapter) {
  const store = createStore({ persistent: false });
  const handler = createHandler({ store, validateConfig: false, logger: silentLogger, payments: { mesomb: adapter },
    env: { NODE_ENV: "test", PAYMENT_MODE: "mesomb", CUSTOMER_APP_URL: "http://customer.test", SECRET_PEPPER: "low-balance-security",
      CUSTOMER_SESSION_SECRET: "low-balance-security", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  const server = await new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const purchase = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/purchase`, { method: "POST",
    headers: { "content-type": "application/json", origin: "http://customer.test" },
    body: JSON.stringify({ phone: "670000801", name: "Guest", planId: "weekly", network: "mtn", requestKey: "r".repeat(40), ...body }) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  return { store, handler, purchase };
}

test("a caller cannot mark its own payment refused, failed or already charged", async (t) => {
  let charges = 0;
  const f = await serve(t, { configured: () => true, async createPayment(p) { charges++; return { providerReference: `ref-${p.id}`, status: "pending" }; },
    async verifyPayment() { return { status: "pending" }; } });
  const made = await f.purchase({ status: "failed", creationState: "refused", failureCode: "low_balance", providerFailedAt: "2030-01-01T00:00:00Z",
    refusal: { failureCode: "low_balance" }, confirmedAt: "2030-01-01T00:00:00Z", amount: 1 });
  assert.equal(made.status, 201);
  const p = (await f.store.snapshot()).payments[0];
  assert.deepEqual([p.status, p.creationState, p.failureCode, p.providerFailedAt, p.confirmedAt, p.amount], ["pending", "accepted", undefined, undefined, undefined, 1000]);
  assert.equal(charges, 1);
});

test("balance wording alone never closes a payment: only the provider's refusal does", async (t) => {
  // An ordinary error that merely mentions a balance (a timeout page, a proxy, a 500) stays uncertain.
  const f = await serve(t, { configured: () => true, async createPayment() { throw Error("Payment provider request failed (502): insufficient balance service"); },
    async verifyPayment() { return { status: "pending" }; } });
  const made = await f.purchase({});
  const p = (await f.store.snapshot()).payments[0];
  assert.deepEqual([made.body.payment.status, p.creationState, p.failureCode], ["pending", "uncertain", undefined]);
  assert.equal(made.body.payment.blocksNewCheckout, true, "no second charge while the first may have gone through");
  // A MeSomb success response whose message mentions a balance is still a pending request.
  const adapter = new MeSombPaymentAdapter({ applicationKey: "a", accessKey: "b", secretKey: "c", client: { async makeCollect(input) {
    return { success: true, status: "PENDING", message: "Customer has insufficient balance warnings enabled", transaction: { pk: input.trxID, status: "PENDING" } };
  } } });
  const pending = await adapter.createPayment({ id: "p2", amount: 1000, currency: "XAF", payerPhone: "670000802", network: "mtn", customerName: "B" });
  assert.deepEqual([pending.status, pending.providerReference], ["pending", "p2"]);
});

test("a refused payment the provider later confirms as paid still activates the bundle", async (t) => {
  let paid = false;
  const f = await serve(t, { configured: () => true,
    async createPayment() { throw Object.assign(Error("insufficient"), { refusal: { failureCode: "low_balance" } }); },
    async verifyPayment(p) { return { status: paid ? "paid" : "failed", providerReference: "late-ref", transactionReference: p.id, amount: p.amount, currency: p.currency }; } });
  const made = await f.purchase({});
  assert.deepEqual([made.body.payment.status, made.body.payment.failureCode], ["failed", "low_balance"]);
  paid = true;
  await f.handler.billing.recheckPayment(made.body.payment.id, { support: true });
  const s = await f.store.snapshot(), p = s.payments[0];
  assert.equal(p.status, "paid", "money received is never left unfulfilled");
  assert.equal(s.vouchers.filter((v) => v.paymentId === p.id).length, 1);
});
