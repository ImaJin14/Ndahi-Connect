import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { blank } from "../lib/api/state.mjs";
import { reservePurchase } from "../lib/domain/purchases.mjs";
import { closeExpiredCheckout, closedCheckoutMessage, paymentView } from "../lib/billing.mjs";
import { createHandler, createStore } from "../server.mjs";
import { createLogger } from "../lib/logger.mjs";
import { enqueuePaymentWebhook } from "../lib/payment-webhooks.mjs";

// Pending checkouts close once their approval window (5 min) and grace (2 min) pass, so an
// abandoned or unresolved payment cannot block a new one; late confirmations still count.
const start = new Date("2026-10-02T12:00:00Z");
const at = (seconds) => new Date(start.getTime() + seconds * 1000);
const timing = { pendingSeconds: 300, graceSeconds: 120, lateCheckHours: 24 };
const reserveAt = (s, seconds, input = {}) => reservePurchase(s,
  { phone: "670000001", name: "Ada", planId: "weekly", network: "mtn", ...input },
  { clock: () => at(seconds), provider: "mesomb", paymentMode: "mesomb", requester: { ip: "10.0.0.8" }, ...timing });

test("a pending checkout blocks a new one only until its window and grace pass", () => {
  const s = blank(), first = reserveAt(s, 0);
  assert.equal(first.status, 201);
  assert.equal(first.payment.paymentExpiresAt, at(300).toISOString());
  s.payments.find(p => p.id === first.payment.id).creationState = "accepted";
  assert.equal(reserveAt(s, 419).body.code, "PAYMENT_IN_PROGRESS", "still inside the grace period");
  const second = reserveAt(s, 421);
  assert.equal(second.status, 201);
  const closed = s.payments.find((p) => p.id === first.payment.id);
  assert.deepEqual([closed.status, closed.checkoutClosedAt, closed.lateCheckUntil, closed.failureReason],
    ["expired", at(421).toISOString(), at(421 + 24 * 3600).toISOString(), closedCheckoutMessage]);
  assert.equal(paymentView(closed).recoveryMessage, closedCheckoutMessage);
  assert.ok(s.events.some((e) => e.type === "payment.checkout_expired" && e.meta.paymentId === closed.id));
});

test("payments already stuck for days are released, including ones from before this fix", () => {
  const s = blank();
  s.customers.push({ id: "c1", phone: "670000001", name: "Ada" });
  const daysAgo = new Date(start.getTime() - 3 * 86400000).toISOString();
  s.payments.push(
    { id: "stuck-pending", customerId: "c1", provider: "mesomb", status: "pending", createdAt: daysAgo, verificationError: "verification_unavailable_or_mismatched" },
    { id: "stuck-uncertain", customerId: "c1", provider: "mesomb", status: "pending", creationState: "uncertain", createdAt: daysAgo },
    { id: "stuck-failed", customerId: "c1", provider: "flutterwave", status: "failed", createdAt: daysAgo },
  );
  assert.equal(reserveAt(s, 0).status, 201);
  assert.deepEqual(s.payments.filter((p) => p.id.startsWith("stuck")).map((p) => p.status), ["expired", "expired", "expired"]);
});

test("payments that involve money are never closed", () => {
  const old = new Date(start.getTime() - 86400000).toISOString(), late = at(0);
  for (const p of [
    { status: "paid", confirmedAt: old, createdAt: old },
    { status: "paid", confirmedAt: old, fulfillmentStatus: "needs_review", createdAt: old },
    { status: "refund-pending", confirmedAt: old, refund: { status: "pending" }, createdAt: old },
    { status: "failed", providerFailedAt: old, createdAt: old },
    { status: "pending", createdAt: late.toISOString() },
  ]) {
    const before = structuredClone(p);
    assert.equal(closeExpiredCheckout(p, late, timing), false, JSON.stringify(before));
    assert.deepEqual(p, before);
  }
  const held = blank();
  held.customers.push({ id: "c1", phone: "670000001" });
  held.payments.push({ id: "held", customerId: "c1", status: "paid", confirmedAt: old, fulfillmentStatus: "needs_review", createdAt: old });
  assert.equal(reserveAt(held, 0).body.code, "PAYMENT_IN_PROGRESS", "a paid order awaiting review still needs support first");
});

async function fixture(t) {
  let time = start.getTime();
  const statuses = new Map(), calls = { create: 0, verify: 0 }, lines = [];
  const store = createStore({ persistent: false });
  const handler = createHandler({
    store, now: () => new Date(time),
    logger: createLogger({ service: "api", write: (_, line) => lines.push(JSON.parse(line)) }),
    env: {
      NODE_ENV: "test", PAYMENT_MODE: "mesomb", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
      SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
      PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", ADMIN_PIN: "9999",
    },
    payments: { mesomb: {
      async createPayment(p) { calls.create++; return { providerReference: `ref-${p.id}` }; },
      async verifyPayment(p) {
        calls.verify++;
        const status = statuses.get(p.id) || "pending";
        if (status === "missing") throw Object.assign(Error("MeSomb transaction was not found"), { code: "PAYMENT_NOT_FOUND" });
        return { status, providerReference: `ref-${p.id}`, transactionReference: p.id, amount: p.amount, currency: p.currency };
      },
    } },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const purchase = async (requestKey) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/purchase`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "670040001", name: "Ada", email: "ada@example.test", planId: "weekly", network: "mtn", requestKey }),
    });
    return { status: response.status, body: await response.json() };
  };
  const payment = async (id) => (await store.snapshot()).payments.find((p) => p.id === id);
  return { store, handler, statuses, calls, lines, purchase, payment, base: `http://127.0.0.1:${server.address().port}`, advance: (seconds) => { time += seconds * 1000; } };
}

test("the billing worker closes a checkout the provider never resolves, and the customer can pay again", async (t) => {
  const f = await fixture(t);
  const first = await f.purchase("expiry-1");
  assert.equal(first.status, 201);
  f.statuses.set(first.body.payment.id, "missing");
  assert.equal((await f.purchase("expiry-2")).body.code, "PAYMENT_IN_PROGRESS");
  f.advance(200);
  await f.handler.billing.run();
  assert.equal((await f.payment(first.body.payment.id)).status, "pending", "still inside its window");
  f.advance(221);
  await f.handler.billing.run();
  const closed = await f.payment(first.body.payment.id);
  assert.equal(closed.status, "expired");
  assert.ok(f.lines.some((l) => l.event === "payment.checkout_expired" && l.paymentId === closed.id && l.state === "window_elapsed"));
  const again = await f.purchase("expiry-2");
  assert.equal(again.status, 201, "the customer can start a new payment");
  assert.notEqual(again.body.payment.id, closed.id);
});

test("a closed checkout stays closed while the provider says pending, and a late success still counts", async (t) => {
  const f = await fixture(t);
  const { body } = await f.purchase("late-1"), id = body.payment.id;
  f.advance(421);
  await f.handler.billing.run();
  assert.equal((await f.payment(id)).status, "expired");
  // Late checks are every 10 minutes and do not reopen the checkout.
  const verifies = f.calls.verify;
  f.advance(60);
  await f.handler.billing.run();
  assert.equal(f.calls.verify, verifies, "no recheck before 10 minutes");
  f.advance(600);
  await f.handler.billing.run();
  assert.equal(f.calls.verify, verifies + 1);
  assert.equal((await f.payment(id)).status, "expired");
  const event = await enqueuePaymentWebhook(f.store, "mesomb", { paymentId: id, transactionId: `ref-${id}`, eventId: "still-pending" }, "{}", () => new Date(start.getTime() + 1081000));
  await f.handler.webhookProcessor.process(event.id);
  assert.equal((await f.payment(id)).status, "expired", "a pending webhook does not reopen it");
  // The provider finally confirms: the customer gets their package.
  f.statuses.set(id, "paid");
  f.advance(600);
  await f.handler.billing.run();
  const settled = await f.payment(id);
  assert.equal(settled.status, "paid");
  assert.equal((await f.store.snapshot()).vouchers.filter((v) => v.paymentId === id && v.status === "active").length, 1);
});

test("if the customer already paid again, a late success is held for review instead of stacking", async (t) => {
  const f = await fixture(t);
  const first = (await f.purchase("stack-1")).body.payment.id;
  f.advance(421);
  const second = (await f.purchase("stack-2")).body.payment.id;
  f.statuses.set(second, "paid");
  await f.handler.billing.run();
  f.statuses.set(first, "paid");
  f.advance(600);
  await f.handler.billing.run();
  const state = await f.store.snapshot();
  assert.equal(state.vouchers.filter((v) => v.status === "active").length, 1);
  assert.equal(state.payments.find((p) => p.id === first).fulfillmentStatus, "needs_review");
});

test("late checks stop after 24 hours, and an expired reservation is never sent", async (t) => {
  const f = await fixture(t);
  const id = (await f.purchase("stop-1")).body.payment.id;
  f.advance(421);
  await f.handler.billing.run();
  f.advance(24 * 3600 + 1);
  const verifies = f.calls.verify;
  await f.handler.billing.run();
  assert.equal(f.calls.verify, verifies, "no provider calls after the late-check window");
  assert.equal((await f.payment(id)).status, "expired");

  // A reservation that never reached the provider (for example, after a crash).
  let reserved;
  await f.store.transaction((s) => {
    reserved = reservePurchase(s, { phone: "670040009", name: "Ben", planId: "weekly", network: "mtn" },
      { clock: () => new Date(start.getTime() + (24 * 3600 + 421) * 1000), provider: "mesomb", paymentMode: "mesomb", requester: { ip: "10.0.0.9" }, ...timing }).payment;
  });
  const creates = f.calls.create;
  f.advance(301);
  await f.handler.billing.run();
  const never = await f.payment(reserved.id);
  assert.equal(f.calls.create, creates, "no phone prompt is sent after the window");
  assert.deepEqual([never.status, never.creationState, never.lateCheckUntil], ["expired", "reserved", never.checkoutClosedAt]);
  assert.ok(f.lines.some((l) => l.event === "payment.checkout_expired" && l.state === "never_submitted"));
});

test('checking payment status closes a timed-out checkout without waiting for the worker', async t => {
  const f = await fixture(t);
  const id = (await f.purchase('status-expiry')).body.payment.id;
  f.advance(421);
  const response = await fetch(`${f.base}/api/payments/${id}/status`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).payment.status, 'expired');
});

test('closed never-submitted reservations do not consume the worker batch', async t => {
  const f = await fixture(t);
  await f.store.transaction(s => {
    for (let i = 0; i < 30; i++) s.payments.push({ id: `closed-${i}`, provider: 'mesomb',
      creationState: 'reserved', status: 'expired', createdAt: start.toISOString(),
      checkoutClosedAt: start.toISOString(), lateCheckUntil: start.toISOString() });
  });
  const id = (await f.purchase('batch-live')).body.payment.id;
  f.statuses.set(id, 'paid');
  await f.handler.billing.run();
  assert.equal((await f.payment(id)).status, 'paid');
  assert.equal(f.calls.verify, 1);
});
