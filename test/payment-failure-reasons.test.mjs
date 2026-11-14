// Server task 2 for the redesign's PhonePaymentFailed screen (#251): every
// provider-confirmed failure carries a reason and says no money was taken; an
// unresolved request is "timeout" and never permits a second charge for it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHandler, createStore } from "../server.mjs";
import { checkoutOutcomeReadable, paymentFailure, paymentView, recordGatewayFailure } from "../lib/billing.mjs";
import { MeSombPaymentAdapter, providerFailureCode } from "../lib/payments.mjs";

const base = new Date("2030-01-01T12:00:00Z"), at = (seconds) => new Date(+base + seconds * 1000);

test("provider wording maps to a reason only when it is unambiguous", () => {
  assert.equal(providerFailureCode({ processor_response: "Insufficient Funds" }), "low_balance");
  assert.equal(providerFailureCode({ message: "Solde insuffisant pour effectuer la transaction" }), "low_balance");
  assert.equal(providerFailureCode({ message: "Customer is not registered for Mobile Money" }), "wrong_network");
  assert.equal(providerFailureCode({ reason: "Wrong network for this number" }), "wrong_network");
  for (const raw of [{ processor_response: "Transaction declined" }, { status: "FAILED" }, {}, null, { message: 42 }])
    assert.equal(providerFailureCode(raw), null, JSON.stringify(raw));
});

test("a confirmed failure records its reason; an expired request was not approved", () => {
  const failed = { createdAt: at(0).toISOString() };
  recordGatewayFailure(failed, { status: "failed", failureCode: "low_balance" }, at(30));
  assert.deepEqual([failed.status, failed.failureCode], ["failed", "low_balance"]);
  const unknown = { createdAt: at(0).toISOString() };
  recordGatewayFailure(unknown, { status: "failed", failureCode: null }, at(30));
  assert.equal(unknown.failureCode, "declined");
  // An Orange-block number paid as MTN, with no clearer provider reason.
  const orangeOnMtn = { createdAt: at(0).toISOString(), payerPhone: "699001245", network: "mtn" };
  recordGatewayFailure(orangeOnMtn, { status: "failed", failureCode: null }, at(30));
  assert.equal(orangeOnMtn.failureCode, "wrong_network");
  const matching = { createdAt: at(0).toISOString(), payerPhone: "670001245", network: "mtn" };
  recordGatewayFailure(matching, { status: "failed", failureCode: null }, at(30));
  assert.equal(matching.failureCode, "declined");
  const providerSays = { createdAt: at(0).toISOString(), payerPhone: "699001245", network: "mtn" };
  recordGatewayFailure(providerSays, { status: "failed", failureCode: "low_balance" }, at(30));
  assert.equal(providerSays.failureCode, "low_balance", "a clear provider reason wins");
  const expired = { createdAt: at(0).toISOString() };
  recordGatewayFailure(expired, { status: "failed", requestExpired: true, failureCode: "low_balance" }, at(30));
  assert.deepEqual([expired.status, expired.failureCode], ["expired", "declined"]);
});

test("the payment view says whether money was taken only when it is known", () => {
  const p = (extra) => ({ id: "p", createdAt: at(0).toISOString(), provider: "mesomb", ...extra });
  const confirmed = { status: "failed", providerFailedAt: at(30).toISOString(), creationState: "accepted" };
  assert.deepEqual(paymentFailure(p({ ...confirmed, failureCode: "wrong_network" })), { failureCode: "wrong_network", moneyTaken: false });
  assert.deepEqual(paymentFailure(p(confirmed)), { failureCode: "declined", moneyTaken: false });
  // Closed by our deadline before the provider answered: keep checking, don't pay again.
  assert.deepEqual(paymentFailure(p({ status: "expired", checkoutClosedAt: at(300).toISOString(), creationState: "accepted" })), { failureCode: "timeout", moneyTaken: null });
  assert.deepEqual(paymentFailure(p({ status: "pending", creationState: "uncertain" })), { failureCode: "timeout", moneyTaken: null });
  assert.deepEqual(paymentFailure(p({ status: "pending", creationState: "accepted", verificationError: "verification_unavailable_or_mismatched" })), { failureCode: "timeout", moneyTaken: null });
  // Still waiting normally, paid, refunded: no failure screen.
  for (const extra of [{ status: "pending", creationState: "accepted" }, { status: "paid", confirmedAt: at(40).toISOString() }, { status: "refunded", refund: { status: "completed" } }])
    assert.deepEqual(paymentFailure(p(extra)), { failureCode: null, moneyTaken: null }, JSON.stringify(extra));
  // Never reached the provider: nothing was charged, and it is not a provider failure.
  assert.deepEqual(paymentFailure(p({ status: "expired", creationState: "reserved", checkoutClosedAt: at(300).toISOString() })), { failureCode: null, moneyTaken: false });
  assert.deepEqual(paymentFailure(p({ status: "failed", creationState: "rejected", providerFailedAt: at(1).toISOString() })), { failureCode: null, moneyTaken: false });
  const view = paymentView(p({ ...confirmed, failureCode: "low_balance", amount: 500, currency: "XAF", payerPhone: "670050099", network: "mtn", providerReference: "ref-1" }), { now: at(60) });
  assert.deepEqual([view.failureCode, view.moneyTaken, view.providerReference, view.network, view.payerPhone], ["low_balance", false, "ref-1", "mtn", "670050099"]);
});

async function fixture(t) {
  let now = at(0), charges = 0;
  const states = new Map(), messages = new Map();
  const store = createStore({ persistent: false });
  const adapter = new MeSombPaymentAdapter({ applicationKey: "synthetic", accessKey: "synthetic", secretKey: "synthetic", client: {
    async makeCollect(input) { charges++; states.set(input.trxID, { status: "PENDING", amount: input.amount }); return { success: true, transaction: { pk: input.trxID, status: "PENDING" } }; },
    async checkTransactions(ids) {
      const state = states.get(ids[0]);
      return [{ pk: ids[0], status: state.status, amount: state.amount, currency: "XAF", ...(messages.has(ids[0]) ? { message: messages.get(ids[0]) } : {}) }];
    },
  } });
  const handler = createHandler({ store, payments: { mesomb: adapter }, validateConfig: false, now: () => now, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mesomb", CUSTOMER_APP_URL: "http://customer.test", SECRET_PEPPER: "synthetic-payments", CUSTOMER_SESSION_SECRET: "synthetic-payments",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent",
  } });
  const server = http.createServer(handler); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const url = "http://127.0.0.1:" + server.address().port;
  const purchase = async (key) => {
    const r = await fetch(url + "/api/purchase", { method: "POST", headers: { origin: "http://customer.test", "content-type": "application/json" },
      body: JSON.stringify({ phone: "670050099", name: "Synthetic buyer", planId: "weekly", network: "mtn", requestKey: key }) });
    return { status: r.status, body: await r.json() };
  };
  const view = async (id) => paymentView((await store.snapshot()).payments.find((p) => p.id === id), { now });
  const status = async (id, key) => {
    const r = await fetch(`${url}/api/payments/${id}/status`, { headers: { origin: "http://customer.test", ...(key ? { "x-checkout-key": key } : {}) } });
    return { status: r.status, body: await r.json() };
  };
  const recover = async (key) => {
    const r = await fetch(url + "/api/purchase/recover", { method: "POST", headers: { origin: "http://customer.test", "content-type": "application/json" }, body: JSON.stringify({ requestKey: key }) });
    return { status: r.status, body: await r.json() };
  };
  return { handler, purchase, view, status, recover, store, charges: () => charges, advance: (n) => { now = at(n); },
    provider: (id, status, message) => { states.get(id).status = status; if (message) messages.set(id, message); } };
}

test("a provider-confirmed low balance reaches the status view with no money taken", async (t) => {
  const f = await fixture(t), { body } = await f.purchase("low-balance");
  assert.equal(body.payment.failureCode, null);
  f.advance(20); f.provider(body.payment.id, "FAILED", "Insufficient balance");
  await f.handler.billing.recheckPayment(body.payment.id);
  const view = await f.view(body.payment.id);
  assert.deepEqual([view.status, view.failureCode, view.moneyTaken], ["failed", "low_balance", false]);
});

test("a request the provider never resolves is a timeout that blocks a second charge while it is open", async (t) => {
  const f = await fixture(t), { body } = await f.purchase("slow");
  f.advance(60);
  const blocked = await f.purchase("slow-retry");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "PAYMENT_IN_PROGRESS");
  assert.equal(f.charges(), 1, "no second charge while the first request is open");
  f.advance(301);
  await f.handler.billing.expireCheckout(body.payment.id);
  const view = await f.view(body.payment.id);
  assert.deepEqual([view.failureCode, view.moneyTaken], ["timeout", null]);
  assert.ok(view.lateCheckUntil, "late provider answers are still checked");
});

test("a guest's private key reads why its payment failed, for a day, without details or a code", async (t) => {
  const f = await fixture(t), key = "k".repeat(40), { body } = await f.purchase(key);
  f.advance(20); f.provider(body.payment.id, "FAILED", "Insufficient balance");
  const read = await f.status(body.payment.id, key);
  assert.equal(read.status, 200);
  assert.deepEqual([read.body.payment.failureCode, read.body.payment.moneyTaken, read.body.access], ["low_balance", false, undefined]);
  assert.deepEqual([read.body.payment.payerPhone, read.body.payment.payerPhoneMasked, read.body.payment.requestKey], [null, "6•• •• 00 99", undefined], "only the masked number");
  assert.equal((await f.status(body.payment.id)).status, 404, "the payment ID alone reads nothing");
  assert.equal((await f.status(body.payment.id, "x".repeat(40))).status, 404, "another key reads nothing");
  const recovered = await f.recover(key);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.payment.failureCode, "low_balance");
  assert.deepEqual(recovered.body.details, { name: "", phone: "", email: "", network: "mtn" }, "a closed checkout's key does not return the guest's details");
  f.advance(20 + 86401);
  assert.equal((await f.status(body.payment.id, key)).status, 404, "the outcome stays readable for a day only");
});

test("an outcome read never covers a confirmed, refunded, revoked or account payment", () => {
  const now = at(100), failed = { status: "failed", providerFailedAt: at(50).toISOString() };
  assert.equal(checkoutOutcomeReadable(failed, now), true);
  for (const extra of [{ confirmedAt: at(60).toISOString() }, { refund: { status: "pending" } }, { checkoutKeyRevokedAt: at(70).toISOString() }, { checkoutAudience: "account" }, { status: "paid" }])
    assert.equal(checkoutOutcomeReadable({ ...failed, ...extra }, now), false, JSON.stringify(extra));
  assert.equal(checkoutOutcomeReadable({ status: "expired", checkoutClosedAt: at(0).toISOString(), lateCheckUntil: at(0).toISOString() }, at(10)), false, "a saved late-check cutoff is final");
  assert.equal(checkoutOutcomeReadable({ status: "failed", providerFailedAt: at(0).toISOString() }, at(86399)), true);
  assert.equal(checkoutOutcomeReadable({ status: "failed", providerFailedAt: at(0).toISOString() }, at(86401)), false, "a day after the failure");
  assert.equal(checkoutOutcomeReadable({ status: "pending" }, now), false, "an open checkout uses the active key rule");
});
