// Normalized payment states, retry, the cheaper bundle and activation apart
// from payment (#433; 24 Nov brief §3; canvas PhonePaymentFailed #409).
// Provider answers are shaped like MeSomb's, and go through the real adapter
// both ways: the checkout poll and a signed webhook.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { blank } from "../lib/api/state.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";
import { paymentFeeRules } from "../lib/payment-fees.mjs";
import { providerResultState, paymentState, retryAllowed, paymentReference, cheaperBundle, shortCodes, activationState, PAYMENT_STATES } from "../lib/payment-states.mjs";
import { MeSombPaymentAdapter } from "../lib/payments.mjs";
import { format } from "../shared-app/i18n.js";

const VERIFIED = "percent=2,on=price,round=nearest";

test("every provider answer becomes one of seven states: codes first, PIN before invalid number, ambiguous is unclear", () => {
  const cases = [
    [{ pk: "pk-1", status: "SUCCESS", amount: 1000, currency: "XAF" }, "paid"],
    [{ pk: "pk-1", status: "PENDING" }, "pending"],
    [{ pk: "pk-1", status: "EXPIRED" }, "expired"],
    [{ pk: "pk-1", status: "FAIL", message: "Transaction timed out" }, "expired"],
    [{ success: false, code: "subscriber-insufficient-balance", message: "The subscriber does not have enough balance" }, "insufficient_funds"],
    [{ success: false, code: "CUSTOMER_BALANCE_INVALID", message: "Customer balance invalid" }, "insufficient_funds"],
    [{ pk: "pk-1", status: "FAIL", message: "Solde insuffisant" }, "insufficient_funds"],
    [{ pk: "pk-1", status: "FAIL", message: "Transaction cancelled by the customer" }, "cancelled_or_pin"],
    // A PIN error that also mentions the number is a PIN error, not an invalid number.
    [{ pk: "pk-1", status: "FAIL", message: "Incorrect PIN entered for the number 670010043" }, "cancelled_or_pin"],
    [{ success: false, code: "subscriber-wrong-pin", message: "Subscriber 670010043 not found" }, "cancelled_or_pin"],
    [{ pk: "pk-1", status: "FAIL", message: "The subscriber 670010043 is not registered for Mobile Money" }, "invalid_subscriber"],
    [{ success: false, code: "subscriber-not-found", message: "Unknown" }, "invalid_subscriber"],
    // The code wins over the message.
    [{ success: false, code: "subscriber-insufficient-balance", message: "Transaction cancelled" }, "insufficient_funds"],
    // Ambiguous: never a guessed cause.
    [{ pk: "pk-1", status: "FAIL", message: "Subscriber internal error, it can be: insufficient fund, timeout, wrong secret code..." }, "unclear"],
    [{ pk: "pk-1", status: "FAIL" }, "unclear"],
    [{ pk: "pk-1", status: "FAIL", message: "Something went wrong" }, "unclear"],
    [null, "unclear"],
  ];
  for (const [raw, state] of cases) assert.equal(providerResultState(raw), state, JSON.stringify(raw));
  assert.deepEqual(PAYMENT_STATES, ["paid", "pending", "expired", "cancelled_or_pin", "invalid_subscriber", "insufficient_funds", "unclear"]);
});

test("retry only once the attempt certainly ended; the reference is the provider's, else NDAHI's", () => {
  const base = { id: "pay-1", amount: 1000, providerReference: "pk-1" };
  assert.deepEqual([paymentState({ ...base, status: "pending" }), retryAllowed({ ...base, status: "pending" })], ["pending", false]);
  assert.deepEqual([paymentState({ ...base, status: "pending", verificationError: "x" }), retryAllowed({ ...base, status: "pending", verificationError: "x" })], ["unclear", false]);
  const failed = { ...base, status: "failed", providerFailedAt: "2026-11-25T10:00:00Z", failureState: "cancelled_or_pin" };
  assert.deepEqual([paymentState(failed), retryAllowed(failed)], ["cancelled_or_pin", true]);
  // Older records: from the reason code.
  assert.equal(paymentState({ ...base, status: "failed", providerFailedAt: "x", failureCode: "low_balance" }), "insufficient_funds");
  assert.equal(paymentState({ ...base, status: "failed", providerFailedAt: "x", failureCode: "declined" }), "unclear");
  const closed = { ...base, status: "expired", checkoutClosedAt: "2026-11-25T10:05:00Z" };
  assert.deepEqual([paymentState(closed), retryAllowed(closed)], ["expired", true]);
  // Held for review (#432): never retried.
  assert.deepEqual([paymentState({ ...base, status: "pending", verificationHold: { issue: "amount_mismatch" } }), retryAllowed({ ...base, status: "pending", verificationHold: {} })], ["unclear", false]);
  assert.equal(paymentReference(base), "pk-1");
  assert.equal(paymentReference({ id: "pay-2", providerReference: "pay-2" }), "pay-2");
  assert.equal(paymentReference({ id: "pay-3" }), "pay-3");
});

test("the cheaper bundle: the highest on sale below the price, same kind; ties by devices, then validity; none, or no verified fee, means no suggestion", () => {
  const s = blank();
  seedCatalogue(s, new Date("2026-11-25T00:00:00Z"));
  s.catalogue.mode = "unlimited";
  const rules = paymentFeeRules({ PAYMENT_MODE: "mesomb", PAYMENT_FEE_MTN: VERIFIED });
  const attempt = (planId) => { const plan = s.bundles.find((b) => b.id === planId); return { id: "p", planId, planSnapshot: plan, amount: plan.price, network: "mtn" }; };
  const normal = cheaperBundle(s, attempt("unlimited-24h-3"), rules);
  assert.deepEqual([normal.planId, normal.price, normal.fee, normal.total], ["unlimited-24h-2", 900, 18, 918]);
  // 4,000 (7 days · 2 devices): 7 days · 1 device and 24 hours · 6 devices tie at 2,500; one device is closer to two.
  const tie = cheaperBundle(s, attempt("unlimited-7d-2"), rules);
  assert.deepEqual([tie.planId, tie.name, tie.deviceSlots, tie.total], ["unlimited-7d-1", "Personal Unlimited", 1, 2550]);
  assert.equal(cheaperBundle(s, attempt("unlimited-5h-1"), rules), null, "nothing cheaper");
  assert.equal(cheaperBundle(s, attempt("home-wisp-30d"), rules), null, "Home WISP is never swapped for Personal Unlimited");
  assert.equal(cheaperBundle(s, { ...attempt("unlimited-7d-2"), network: "orange" }, rules), null, "Orange's fee isn't verified");
  // Fixed-data plans while the switch is legacy.
  s.catalogue.mode = "legacy";
  assert.equal(cheaperBundle(s, { id: "p", planId: "weekly", amount: 1000, network: "mtn" }, rules).planId, "daily");
});

test("payment confirmed and Wi-Fi active are separate; short codes only once verified", () => {
  const paid = { id: "p", status: "paid", confirmedAt: "x" };
  assert.equal(activationState({ id: "p", status: "pending" }, null), null);
  assert.equal(activationState(paid, null), "activating");
  assert.equal(activationState(paid, { status: "active", routerSyncStatus: "pending" }), "activating");
  assert.equal(activationState(paid, { status: "active", routerSyncStatus: "synchronized" }), "active");
  assert.equal(activationState(paid, { status: "available", startsOnFirstConnection: true }), "waiting_first_connection");
  assert.equal(activationState({ ...paid, fulfillmentStatus: "needs_review" }, null), "review");
  assert.equal(shortCodes({}), null);
  assert.deepEqual(shortCodes({ PAYMENT_SHORT_CODES: "verified" }), { mtn: "*126#", orange: "#150#" });
});

test("the messages read exactly as the brief and the design, in English and French", () => {
  const en = (key, values) => format(key, values, "en"), fr = (key, values) => format(key, values, "fr");
  assert.equal(en("payStateInsufficientBody", { total: "4,080 XAF" }), "Insufficient MoMo/OM balance. You need at least 4,080 XAF in your wallet to cover the bundle + 2% payment fee.");
  assert.equal(en("payStateSwitch", { name: "Personal Unlimited · 7 days · 1 device", total: "2,550 XAF" }), "Switch to Personal Unlimited · 7 days · 1 device (2,550 XAF)");
  assert.equal(en("payStateExpiredBodyCodes", { mtn: "*126#", orange: "#150#" }), "Payment request expired. Dial *126# (MTN) or #150# (Orange) to approve pending prompts, or tap Retry to send a new pop-up.");
  assert.equal(en("payStateCancelledBody"), "Transaction cancelled or incorrect PIN entered. Tap Retry when you're ready to approve the prompt.");
  assert.equal(en("payStateInvalidBody", { wallet: "MTN MoMo" }), "This number isn't registered on MTN MoMo. Please check the number or switch networks.");
  assert.equal(en("payStatePendingBody", { brand: "MTN" }), "Waiting for MTN confirmation. Approve the pop-up on your phone—your Wi-Fi will activate automatically once confirmed.");
  assert.equal(fr("payStateInsufficientBody", { total: "4 080 XAF" }), "Solde MoMo/OM insuffisant. Il vous faut au moins 4 080 XAF sur votre compte pour couvrir le forfait + 2 % de frais de paiement.");
  assert.equal(fr("payStateCancelledBody"), "Transaction annulée ou code PIN incorrect. Touchez Réessayer quand vous êtes prêt à valider la demande.");
  assert.equal(fr("payStateUnclearBody", { brand: "MTN" }), "MTN n'a pas donné de réponse claire. Si de l'argent a quitté votre compte, votre forfait s'activera ou le montant vous sera rendu.");
  assert.equal(fr("payStateExpiredBodyCodes", { mtn: "*126#", orange: "#150#" }), "Demande de paiement expirée. Composez *126# (MTN) ou #150# (Orange) pour valider les demandes en attente, ou touchez Réessayer pour envoyer une nouvelle demande.");
});

// Through the API, with MeSomb's real adapter and a stubbed provider client.
async function server(t, { answer, refuse } = {}) {
  const store = createStore({ persistent: false }), secret = randomUUID();
  let current = answer || (() => ({ status: "PENDING" }));
  const client = {
    async makeCollect() {
      if (refuse) throw Object.assign(Error(refuse.message), { name: "InvalidClientRequestError", code: refuse.code });
      return { isOperationSuccess: () => true, isTransactionSuccess: () => false, transaction: { pk: "pk-1", status: "PENDING" } };
    },
    // A refused request was never created: MeSomb has no transaction for it.
    async checkTransactions([id]) { return refuse ? [] : [{ pk: "pk-1", reference: id, amount: 1000, currency: "XAF", ...current(id) }]; },
  };
  const mesomb = new MeSombPaymentAdapter({ applicationKey: "app", accessKey: "access", secretKey: "secret", webhookSecret: secret, client });
  const app = createServer({ store, payments: { mesomb }, env: { NODE_ENV: "test", PAYMENT_MODE: "mesomb", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
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
  const id = placed.json?.payment?.id;
  const webhook = (eventId) => {
    const raw = JSON.stringify({ id: eventId, event_type: "transaction.updated", data: { object: { reference: id, pk: "pk-1" } } }), stamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${stamp}.${raw}`, "utf8").digest("hex");
    return call("/api/webhooks/mesomb", "POST", raw, { "x-mesomb-webhook-signature": `t=${stamp},v1=${signature}` });
  };
  return { store, id, placed, call, webhook, set: (next) => { current = next; }, poll: () => call(`/api/payments/${id}/status`, "GET", null, { "x-checkout-key": key }) };
}

test("each failure state, by poll and by webhook, from MeSomb-shaped answers", async (t) => {
  const answers = {
    insufficient_funds: { status: "FAIL", message: "The subscriber does not have enough balance", code: "subscriber-insufficient-balance" },
    cancelled_or_pin: { status: "FAIL", message: "Incorrect PIN entered for the number 670010043" },
    invalid_subscriber: { status: "FAIL", message: "The subscriber 670010043 is not registered for Mobile Money" },
    expired: { status: "EXPIRED" },
    unclear: { status: "FAIL", message: "Subscriber internal error, it can be: insufficient fund, timeout, wrong secret code..." },
  };
  for (const [state, answer] of Object.entries(answers)) for (const path of ["poll", "webhook"]) {
    const f = await server(t, { answer: () => answer });
    assert.equal(f.placed.status, 201, JSON.stringify(f.placed.json));
    if (path === "webhook") await f.webhook(`evt-${state}`);
    const status = await f.poll();
    const p = status.json.payment;
    assert.deepEqual([p.state, p.retryAllowed, p.reference, p.paymentConfirmed], [state, true, "pk-1", false], `${path} ${state}`);
    assert.equal(Boolean(status.json.cheaperBundle), state === "insufficient_funds", `${path} ${state}: cheaper bundle only for insufficient funds`);
    if (state === "insufficient_funds") assert.deepEqual([status.json.cheaperBundle.planId, status.json.cheaperBundle.total], ["daily", 255]);
    assert.equal(status.json.shortCodes, null, "short codes stay off until verified");
    assert.equal((await f.store.snapshot()).vouchers.length, 0);
  }
});

test("any other refusal when the request is created stays unclear until the provider answers: no guessed cause, no retry yet", async (t) => {
  const f = await server(t, { refuse: { code: "subscriber-not-found", message: "Subscriber 670010043 not found" } });
  const p = (await f.store.snapshot()).payments.find((x) => x.id === f.id);
  assert.equal(p.creationState, "uncertain");
  const status = (await f.poll()).json.payment;
  assert.deepEqual([status.state, status.retryAllowed], ["unclear", false]);
});

test("pending: no retry and no second charge; a later success activates once, by poll or webhook", async (t) => {
  const f = await server(t);
  let status = await f.poll();
  assert.deepEqual([status.json.payment.state, status.json.payment.retryAllowed, status.json.activation], ["pending", false, null]);
  const again = await f.call("/api/purchase", "POST", { phone: "670010043", name: "Test", planId: "weekly", network: "mtn", requestKey: randomUUID() });
  assert.deepEqual([again.status, again.json.code], [409, "PAYMENT_IN_PROGRESS"], "no second charge while it is unresolved");
  f.set(() => ({ status: "SUCCESS", fees: 20, trxamount: 1020 }));
  await f.webhook("evt-success");
  await f.webhook("evt-success");
  status = await f.poll();
  await f.poll();
  const s = await f.store.snapshot();
  assert.equal(s.vouchers.filter((v) => v.paymentId === f.id).length, 1, "activated once");
  assert.equal(s.payments.length, 1, "charged once");
  assert.deepEqual([status.json.payment.state, status.json.payment.paymentConfirmed, status.json.payment.retryAllowed], ["paid", true, false]);
  assert.ok(["activating", "active"].includes(status.json.activation), "Wi-Fi activation is reported apart from the payment");
  // A failure event after the success never downgrades it.
  f.set(() => ({ status: "FAIL", message: "Transaction cancelled by the customer" }));
  await f.webhook("evt-late-failure");
  assert.equal((await f.store.snapshot()).payments[0].status, "paid");
});
