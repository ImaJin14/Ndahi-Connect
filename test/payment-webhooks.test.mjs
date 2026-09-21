import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler, createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createWebhookProcessor, enqueuePaymentWebhook, scheduleWebhookReplay, webhookSummary } from "../lib/payment-webhooks.mjs";

const baseTime = new Date("2026-09-21T12:00:00Z");
const payment = (provider = "mesomb") => ({ id: "p1", customerId: "c1", planId: "weekly",
  status: "pending", provider, providerReference: "123", amount: 500, currency: "XAF", createdAt: baseTime.toISOString() });
const verification = (p, overrides = {}) => ({ status: "paid", providerReference: p.providerReference,
  transactionReference: p.id, amount: p.amount, currency: p.currency, ...overrides });
const eventData = (id = "evt1") => ({ eventId: id, paymentId: "p1", transactionId: "123", type: "payment.succeeded" });
async function fixture({ provider = "mesomb", store = createStore({ persistent: false }), verify, env = {} } = {}) {
  let time = baseTime, calls = 0;
  const now = () => time;
  await store.transaction((s) => {
    s.customers.push({ id: "c1", phone: "670000001", name: "Customer" });
    s.payments.push(payment(provider));
  });
  const adapter = { configured: () => true,
    verifyPayment: async (p) => { calls++; return verify ? verify(p) : verification(p); },
    handleWebhook: async (raw, signature) => { if (signature !== "valid") throw Error("Invalid signature"); return JSON.parse(raw); },
  };
  const opts = { store, now, validateConfig: false, payments: { [provider]: adapter },
    email: { configured: () => false }, router: { syncVoucher: async () => {}, disconnectVoucher: async () => {}, markInactive: async () => {} },
    env: { NODE_ENV: "test", BOOTSTRAP_MODE: "false", PAYMENT_MODE: provider,
      ADMIN_SESSION_SECRET: "test-admin-secret", PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", ...env } };
  const handler = createHandler(opts);
  return { store, opts, processor: handler.webhookProcessor, now, calls: () => calls,
    advance: (ms = 60000) => { time = new Date(+time + ms); },
    enqueue: (id = "evt1") => enqueuePaymentWebhook(store, provider, eventData(id), JSON.stringify(eventData(id)), now) };
}

for (const provider of ["mesomb", "flutterwave"]) {
  test(`${provider}: duplicate delivery and concurrent distinct events issue exactly one voucher`, async () => {
    const f = await fixture({ provider });
    const first = await f.enqueue(), duplicate = await f.enqueue(), second = await f.enqueue("evt2");
    assert.equal(first.id, duplicate.id);
    assert.equal(duplicate.duplicate, true);
    await Promise.all([f.processor.process(first.id), f.processor.process(first.id), f.processor.process(second.id)]);
    const s = await f.store.snapshot();
    assert.equal(s.vouchers.length, 1);
    assert.equal(s.payments[0].status, "paid");
    assert.ok(s.providerEvents.every((e) => e.status === "processed"));
    assert.equal(f.calls(), 2);
  });
}

test("verification outage persists retry, respects backoff, and recovers", async () => {
  let fail = true;
  const f = await fixture({ verify: (p) => { if (fail) throw Error("SECRET provider detail"); return verification(p); } });
  const job = await f.enqueue();
  assert.equal((await f.processor.process(job.id)).status, 502);
  let s = await f.store.snapshot();
  assert.equal(s.providerEvents[0].status, "retry");
  assert.equal(s.vouchers.length, 0);
  assert.ok(!JSON.stringify(s).includes("SECRET"));
  await f.processor.run();
  assert.equal(f.calls(), 1);
  fail = false;
  f.advance();
  await f.processor.run();
  s = await f.store.snapshot();
  assert.equal(s.vouchers.length, 1);
  assert.equal(s.providerEvents[0].totalAttempts, 2);
});

test("bounded retries dead-letter and controlled replay can recover without resetting total attempts", async () => {
  let fail = true;
  const f = await fixture({ verify: (p) => { if (fail) throw Error("outage"); return verification(p); } });
  const job = await f.enqueue();
  for (let i = 0; i < 5; i++) { await f.processor.run(); f.advance(3600000); }
  let s = await f.store.snapshot();
  assert.equal(s.providerEvents[0].status, "dead_letter");
  assert.equal(s.providerEvents[0].totalAttempts, 5);
  assert.equal(webhookSummary(s).deadLetters, 1);
  await f.processor.run();
  assert.equal(f.calls(), 5);
  fail = false;
  await f.store.transaction((s) => assert.equal(scheduleWebhookReplay(s, job.id, f.now).status, 202));
  await f.processor.run();
  s = await f.store.snapshot();
  assert.equal(s.vouchers.length, 1);
  assert.equal(s.providerEvents[0].totalAttempts, 6);
  assert.equal(scheduleWebhookReplay(s, job.id, f.now).status, 409);
});

test("amount, currency, order and reference mismatches are quarantined without access", async () => {
  for (const changes of [{ amount: 1 }, { currency: "USD" }, { transactionReference: "other" }, { providerReference: "other" }]) {
    const f = await fixture({ verify: (p) => verification(p, changes) });
    const job = await f.enqueue();
    assert.equal((await f.processor.process(job.id)).status, 400);
    const s = await f.store.snapshot();
    assert.equal(s.vouchers.length, 0);
    assert.equal(s.providerEvents[0].status, "dead_letter");
    assert.equal(s.providerEvents[0].lastError, "payment_details_mismatch");
  }
});

test("fulfillment conflicts remain replayable instead of being marked successfully handled", async () => {
  const f = await fixture();
  await f.store.transaction((s) => { s.vouchers.push({ id: "existing", customerId: "c1", status: "active", expiresAt: "2026-10-21T00:00:00Z" }); });
  const job = await f.enqueue();
  assert.equal((await f.processor.process(job.id)).status, 409);
  let s = await f.store.snapshot();
  assert.equal(s.providerEvents[0].status, "dead_letter");
  await f.store.transaction((s) => { s.vouchers[0].status = "expired"; scheduleWebhookReplay(s, job.id, f.now); });
  await f.processor.run();
  s = await f.store.snapshot();
  assert.equal(s.vouchers.filter((v) => v.paymentId === "p1").length, 1);
  assert.equal(s.providerEvents[0].status, "processed");
});

test("out-of-order verification cannot downgrade a paid payment or revive a refund", async () => {
  let status = "paid";
  const f = await fixture({ verify: (p) => verification(p, { status }) });
  await f.enqueue(); await f.processor.run();
  status = "failed";
  await f.enqueue("failed-event"); await f.processor.run();
  assert.equal((await f.store.snapshot()).payments[0].status, "paid");
  await f.store.transaction((s) => { s.payments[0].status = "refunded"; });
  status = "paid";
  await f.enqueue("late-success"); await f.processor.run();
  const s = await f.store.snapshot();
  assert.equal(s.payments[0].status, "refunded");
  assert.equal(s.vouchers.length, 1);
  assert.equal(s.providerEvents.at(-1).lastError, "payment_already_refunded");
});

test("event identity is provider-scoped, missing event IDs use payload hashes, conflicts are rejected", async () => {
  const f = await fixture();
  const a = await f.enqueue();
  const b = await enqueuePaymentWebhook(f.store, "flutterwave", eventData(), JSON.stringify(eventData()), f.now);
  assert.notEqual(a.id, b.id);
  const changed = await enqueuePaymentWebhook(f.store, "mesomb", { ...eventData(), paymentId: "other" }, "different", f.now);
  assert.equal(changed.status, 409);
  const data = { ...eventData(), eventId: undefined }, raw = JSON.stringify(data);
  const c = await enqueuePaymentWebhook(f.store, "mesomb", data, raw, f.now);
  assert.equal((await enqueuePaymentWebhook(f.store, "mesomb", data, raw, f.now)).id, c.id);
});

test("missing local payments are retained and can recover after the order is restored", async () => {
  const f = await fixture();
  await f.store.transaction((s) => { s.payments = []; });
  const job = await f.enqueue();
  assert.equal((await f.processor.process(job.id)).status, 404);
  await f.store.transaction((s) => { s.payments.push(payment()); });
  f.advance(); await f.processor.run();
  assert.equal((await f.store.snapshot()).vouchers.length, 1);
});

test("processing crash rolls back settlement and an expired lease can recover after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ndahi-webhook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.json"), f = await fixture({ store: createStore({ file }) });
  const job = await f.enqueue();
  const broken = createWebhookProcessor({ store: f.store, now: f.now,
    payments: { mesomb: { verifyPayment: (p) => verification(p) } },
    settle: (s) => { s.vouchers.push({ id: "must-roll-back" }); throw Error("crash before commit"); } });
  await assert.rejects(broken.process(job.id), /crash before commit/);
  const restarted = createStore({ file });
  assert.equal((await restarted.snapshot()).vouchers.length, 0);
  assert.equal((await restarted.snapshot()).providerEvents[0].status, "processing");
  f.advance();
  const handler = createHandler({ ...f.opts, store: restarted });
  await handler.webhookProcessor.run();
  assert.equal((await restarted.snapshot()).vouchers.length, 1);
});

test("provider timeout releases lease and leaves a retryable durable event", async () => {
  const f = await fixture();
  const job = await f.enqueue();
  const worker = createWebhookProcessor({ store: f.store, now: f.now, timeoutMs: 5,
    payments: { mesomb: { verifyPayment: () => new Promise(() => {}) } }, settle: () => assert.fail("must not settle") });
  assert.equal((await worker.process(job.id)).status, 502);
  const e = (await f.store.snapshot()).providerEvents[0];
  assert.equal(e.status, "retry");
  assert.equal(e.leaseToken, undefined);
});

test("refund committed during provider verification prevents fulfillment", async () => {
  let release, started;
  const verifying = new Promise((resolve) => { started = resolve; });
  const f = await fixture({ verify: (p) => { started(); return new Promise((resolve) => { release = () => resolve(verification(p)); }); } });
  const job = await f.enqueue(), processing = f.processor.process(job.id);
  await verifying;
  await f.store.transaction((s) => { s.payments[0].status = "refund-pending"; });
  release(); await processing;
  const s = await f.store.snapshot();
  assert.equal(s.vouchers.length, 0);
  assert.equal(s.payments[0].status, "refund-pending");
  assert.equal(s.providerEvents[0].status, "dead_letter");
});

test("existing voucher prevents reissuance even when local payment status was changed", async () => {
  const f = await fixture();
  await f.enqueue(); await f.processor.run();
  await f.store.transaction((s) => { s.payments[0].status = "failed"; });
  await f.enqueue("another-success"); await f.processor.run();
  assert.equal((await f.store.snapshot()).vouchers.length, 1);
});

test("server startup processes durable queued work without another provider delivery", async (t) => {
  const f = await fixture({ env: { PAYMENT_WEBHOOK_REPLAY_ENABLED: "true" } });
  await f.enqueue();
  const server = createServer(f.opts);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (let i = 0; i < 100 && !(await f.store.snapshot()).vouchers.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await f.store.snapshot()).vouchers.length, 1);
});

test("HTTP signatures, operator replay authorization, CSRF and audit trail", async (t) => {
  const f = await fixture({ env: { NODE_ENV: "production", CUSTOMER_APP_URL: "https://customer.test",
    ADMIN_APP_URL: "https://admin.test", ALLOWED_ADMIN_ORIGINS: "https://admin.test" },
    verify: (p) => verification(p, { amount: 1 }) });
  await f.store.transaction((s) => {
    for (const role of ["owner", "operator", "auditor", "reseller"]) s.adminSessions.push({
      tokenHash: hashSecret(role, "test-admin-secret"), role, csrfToken: "csrf", expiresAt: "2026-09-22T12:00:00Z",
    });
  });
  const server = createServer(f.opts);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const hook = (signature) => fetch(base + "/api/webhooks/mesomb", { method: "POST",
    headers: { "x-mesomb-webhook-signature": signature }, body: JSON.stringify(eventData()) });
  assert.equal((await hook("invalid")).status, 401);
  assert.equal((await f.store.snapshot()).providerEvents.length, 0);
  assert.equal((await hook("valid")).status, 400);
  const id = (await f.store.snapshot()).providerEvents[0].id;
  const replay = (role, csrf = "csrf", origin = "https://admin.test") => fetch(base + "/api/admin/payments/webhooks/replay", {
    method: "POST", headers: { cookie: `admin_session=${role}`, origin, "x-csrf-token": csrf }, body: JSON.stringify({ eventId: id }),
  });
  assert.equal((await replay("owner", "bad")).status, 403);
  assert.equal((await replay("owner", "csrf", "https://evil.test")).status, 403);
  assert.equal((await replay("auditor")).status, 403);
  assert.equal((await replay("reseller")).status, 403);
  assert.equal((await replay("missing")).status, 401);
  assert.equal((await replay("operator")).status, 202);
  assert.equal((await replay("operator")).status, 409);
  const s = await f.store.snapshot();
  assert.ok(s.auditLogs.some((a) => a.action === "payment.webhook_replay_requested" && a.meta.eventId === id));
});
