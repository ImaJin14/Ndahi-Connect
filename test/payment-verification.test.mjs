// The verified 2% fee and the reconciliation rules before provisioning (#432;
// 24 Nov brief §2): the fee examples on both networks, the fallback for an
// unverified network, MeSomb's own "SUCCESS", one rule set for polling and
// webhooks, and activation exactly once.
import test from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { paymentFeeRules, quotePayment } from "../lib/payment-fees.mjs";
import { verificationVerdict, routeToReconciliation } from "../lib/payment-verification.mjs";
import { MeSombPaymentAdapter } from "../lib/payments.mjs";
import { closeExpiredCheckout, blocksNewCheckout } from "../lib/billing.mjs";

const VERIFIED = "percent=2,on=price,round=nearest";

test("the verified 2% fee: Math.round(base × 0.02) on both networks, the four examples, and the fallback", () => {
  const rules = paymentFeeRules({ PAYMENT_MODE: "mesomb", PAYMENT_FEE_MTN: VERIFIED, PAYMENT_FEE_ORANGE: VERIFIED });
  for (const network of ["mtn", "orange"]) {
    for (const [base, total] of [[250, 255], [500, 510], [2500, 2550], [6000, 6120]])
      assert.deepEqual(quotePayment(base, network, rules), { price: base, fee: total - base, total, network }, `${network} ${base}`);
    // Every catalogue price and halves: the same as Math.round(base * 0.02).
    for (const base of [125, 375, 625, 900, 1300, 1700, 2100, 4000, 5500, 7000, 8500, 10000, 15000, 20000, 25000, 30000, 50000, 99975])
      assert.equal(quotePayment(base, network, rules).fee, Math.round(base * 0.02), `${network} ${base}`);
  }
  // Only MTN verified: Orange shows the base price with no fee or total (fee in the operator prompt).
  const mtnOnly = paymentFeeRules({ PAYMENT_MODE: "mesomb", PAYMENT_FEE_MTN: VERIFIED });
  assert.deepEqual(quotePayment(2500, "orange", mtnOnly), { price: 2500, fee: null, total: null, network: "orange" });
  assert.deepEqual(quotePayment(2500, "mtn", mtnOnly), { price: 2500, fee: 50, total: 2550, network: "mtn" });
});

test("only MeSomb's own SUCCESS confirms a payment; another success word is held as unconfirmed", async () => {
  const adapter = (status) => new MeSombPaymentAdapter({ client: { async checkTransactions() {
    return [{ pk: "pk-1", status, amount: 2500, currency: "XAF", fees: 50, trxamount: 2550 }];
  } } });
  const paid = await adapter("SUCCESS").verifyPayment({ id: "pay-1", providerReference: "pk-1" });
  assert.deepEqual([paid.status, paid.providerStatus, paid.amount, paid.currency, paid.providerFee, paid.providerTotal], ["paid", "SUCCESS", 2500, "XAF", 50, 2550]);
  for (const word of ["SUCCESSFUL", "SUCCEEDED"]) assert.equal((await adapter(word).verifyPayment({ id: "pay-1", providerReference: "pk-1" })).status, "unconfirmed", word);
});

test("one verdict for polling and webhooks: identity, XAF and the merchant credit equal to the base price", () => {
  const s = { payments: [{ id: "other", provider: "mesomb", providerReference: "pk-9" }] };
  const p = { id: "pay-1", provider: "mesomb", providerReference: "pk-1", amount: 2500, currency: "XAF" };
  const ok = { status: "paid", providerReference: "pk-1", transactionReference: "pay-1", amount: 2500, currency: "XAF" };
  assert.deepEqual(verificationVerdict(s, p, ok), { ok: true });
  for (const [change, issue, extra] of [[{ amount: 2550 }, "amount_mismatch"], [{ amount: 2450 }, "amount_mismatch"], [{ currency: "EUR" }, "currency_mismatch"],
    [{ transactionReference: "pay-2" }, "identity_mismatch"], [{ providerReference: "pk-2" }, "identity_mismatch"], [{ providerReference: "pk-9" }, "identity_mismatch"],
    [{}, "identity_mismatch", { transactionId: "pk-7" }], [{ status: "unconfirmed" }, "provider_status_unconfirmed"]])
    assert.deepEqual(verificationVerdict(s, p, { ...ok, ...change }, extra), { ok: false, issue, reconcile: true }, JSON.stringify(change));
  // Not money moved: a mismatch on a pending answer is only unverified.
  assert.deepEqual(verificationVerdict(s, p, { ...ok, status: "pending", amount: 1 }), { ok: false, issue: "amount_mismatch", reconcile: false });
  assert.deepEqual(verificationVerdict(s, p, null), { ok: false, issue: "verification_unavailable", reconcile: false });
  // A recorded reference that is only our own payment id (none at creation) isn't compared.
  assert.deepEqual(verificationVerdict(s, { ...p, providerReference: "pay-1" }, ok), { ok: true });
  // Routed once per issue: a repeated callback adds no new event.
  const t = { payments: [], events: [] }, q = { id: "pay-3", provider: "mesomb", amount: 2500 };
  routeToReconciliation(t, q, "amount_mismatch", { ...ok, amount: 2550 }, new Date("2026-11-25T10:00:00Z"));
  routeToReconciliation(t, q, "amount_mismatch", { ...ok, amount: 2550 }, new Date("2026-11-25T10:01:00Z"));
  assert.deepEqual([q.reconciliation.status, q.reconciliation.issues, q.reconciliation.reported.amount, t.events.length], ["needs_review", ["payment_details_mismatch", "amount_mismatch"], 2550, 1]);
});

// Through the API: a poll (checkout status) and an authenticated webhook.
async function server(t, verify, clock = { now: new Date() }) {
  const store = createStore({ persistent: false });
  const payments = { mesomb: {
    configured: () => true,
    async createPayment() { return { providerReference: "pk-1", status: "pending" }; },
    async verifyPayment(p) { return verify(p); },
    async handleWebhook(raw) { const e = JSON.parse(raw); return { eventId: e.id, type: "transaction.success", paymentId: e.paymentId, transactionId: "pk-1" }; },
  } };
  const app = createServer({ store, payments, now: () => clock.now, env: { NODE_ENV: "test", PAYMENT_MODE: "mesomb", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
    SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", PAYMENT_FEE_MTN: VERIFIED, LOG_LEVEL: "silent" } });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { app.closeAllConnections(); app.close(r); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (path, method = "GET", data, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(data ? { body: typeof data === "string" ? data : JSON.stringify(data) } : {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const key = randomUUID();
  const placed = await call("/api/purchase", "POST", { phone: "670010043", name: "Test", planId: "weekly", network: "mtn", requestKey: key });
  assert.equal(placed.status, 201, JSON.stringify(placed.json));
  const id = placed.json.payment.id;
  return { store, id, call, poll: () => call(`/api/payments/${id}/status`, "GET", null, { "x-checkout-key": key }),
    webhook: (eventId) => call("/api/webhooks/mesomb", "POST", JSON.stringify({ id: eventId, paymentId: id }), { "x-mesomb-webhook-signature": "t=1,v1=" + "0".repeat(64) }) };
}
const success = (p, extra = {}) => ({ status: "paid", providerStatus: "SUCCESS", providerReference: "pk-1", transactionReference: p.id, amount: p.amount, currency: "XAF", providerFee: 20, providerTotal: 1020, ...extra });

test("a poll and a webhook for the same success activate the bundle once, with the provider's amounts beside the quote", async (t) => {
  const f = await server(t, (p) => success(p));
  await f.poll();
  await f.webhook("evt-1");
  await f.webhook("evt-1");
  await f.webhook("evt-2");
  await f.poll();
  const s = await f.store.snapshot(), p = s.payments.find((x) => x.id === f.id);
  assert.equal(s.vouchers.filter((v) => v.paymentId === f.id).length, 1, "activated exactly once");
  assert.deepEqual([p.status, p.amount, p.fee, p.total, p.providerFee, p.providerTotal], ["paid", 1000, 20, 1020, 20, 1020], "the quote and the provider's charge, kept apart");
  assert.equal(p.reconciliation?.status === "needs_review", false);
});

test("a success with the wrong amount, currency or identity goes to reconciliation, by poll or by webhook, and nothing is provisioned", async (t) => {
  for (const [change, issue] of [[{ amount: 1020 }, "amount_mismatch"], [{ currency: "EUR" }, "currency_mismatch"], [{ transactionReference: "someone-else" }, "identity_mismatch"]]) {
    for (const path of ["poll", "webhook"]) {
      const f = await server(t, (p) => success(p, change));
      if (path === "poll") await f.poll(); else await f.webhook(`evt-${issue}`);
      const s = await f.store.snapshot(), p = s.payments.find((x) => x.id === f.id);
      assert.equal(s.vouchers.some((v) => v.paymentId === f.id), false, `${path} ${issue}: not provisioned`);
      assert.notEqual(p.status, "paid", `${path} ${issue}`);
      assert.deepEqual([p.reconciliation?.status, p.reconciliation?.issues?.includes(issue)], ["needs_review", true], `${path} ${issue}`);
      assert.ok(s.events.some((e) => e.type === "payment.reconciliation_issue" && e.meta.paymentId === f.id));
    }
  }
});

test("payments made before this change keep their recorded amounts", async (t) => {
  const f = await server(t, (p) => success(p));
  await f.store.transaction((s) => {
    s.payments.push({ id: "older", provider: "mesomb", status: "paid", amount: 1000, currency: "XAF", fee: null, total: null, providerFee: 25, providerTotal: 1025,
      planId: "weekly", providerReference: "pk-old", confirmedAt: "2026-11-20T10:00:00Z" });
  });
  const before = JSON.stringify((await f.store.snapshot()).payments.find((p) => p.id === "older"));
  await f.poll(); await f.webhook("evt-3");
  assert.equal(JSON.stringify((await f.store.snapshot()).payments.find((p) => p.id === "older")), before);
});

test("a payment held for review is never closed as expired and blocks a second charge until support resolves it", async (t) => {
  const clock = { now: new Date("2026-11-25T10:00:00Z") };
  const f = await server(t, (p) => success(p, { amount: 1020 }), clock);
  await f.poll();
  clock.now = new Date(+clock.now + 2 * 864e5);
  await f.poll();
  const p = (await f.store.snapshot()).payments.find((x) => x.id === f.id);
  assert.deepEqual([p.status, p.checkoutClosedAt, p.verificationHold.issue], ["pending", undefined, "amount_mismatch"], "held open, not expired");
  const again = await f.call("/api/purchase", "POST", { phone: "670010043", name: "Test", planId: "weekly", network: "mtn", requestKey: randomUUID() });
  assert.deepEqual([again.status, again.json.code], [409, "PAYMENT_UNDER_REVIEW"]);
  const after = (await f.store.snapshot()).payments;
  assert.equal(after.length, 1, "no second charge");
  assert.equal(after[0].checkoutClosedAt, undefined, "still open after the refused attempt");
  // The rules themselves, a week on.
  const later = new Date(+clock.now + 7 * 864e5), held = structuredClone(after[0]);
  assert.equal(closeExpiredCheckout(held, later), false);
  assert.equal(blocksNewCheckout(held, later), true);
  // Once support refunds it, a new checkout is free again.
  assert.equal(blocksNewCheckout({ ...held, refund: { status: "completed" } }, later), false);
});
