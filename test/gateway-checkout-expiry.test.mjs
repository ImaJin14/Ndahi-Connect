import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { blank } from '../lib/api/state.mjs';
import { createHandler, createStore } from '../server.mjs';
import { reservePurchase } from '../lib/domain/purchases.mjs';
import { checkoutTiming, checkoutDeadline, guestCheckoutDeadline, paymentView, createBillingService, recordGatewayFailure } from '../lib/billing.mjs';
import { enqueuePaymentWebhook } from '../lib/payment-webhooks.mjs';
import { MeSombPaymentAdapter } from '../lib/payments.mjs';
const base = new Date('2030-01-01T12:00:00Z'), at = seconds => new Date(+base + seconds * 1000);
const reserve = (s, seconds, input = {}) => reservePurchase(s, { phone: '670050099', name: 'Synthetic buyer', planId: 'weekly', network: 'mtn', ...input },
 { clock: () => at(seconds), provider: 'mesomb', requester: { ip: '127.0.0.1' }, graceSeconds: 120 });
test('request, portal countdown and recovery credential share the exact deadline without legacy grace', () => {
 const s = blank(), p = reserve(s, 0).payment; p.creationState = 'accepted';
 assert.equal(checkoutTiming({ PAYMENT_EXPIRY_GRACE_SECONDS: '120' }).graceSeconds, 0);
 assert.equal(p.paymentExpiresAt, p.paymentClosesAt);
 assert.equal(reserve(s, 299).body.code, 'PAYMENT_IN_PROGRESS');
 assert.equal(reserve(s, 300).status, 201);
 const legacy = { createdAt: at(0).toISOString(), paymentExpiresAt: at(300).toISOString(), paymentClosesAt: at(420).toISOString(), gatewayExpiresAt: at(90).toISOString() };
 assert.equal(checkoutDeadline(legacy), +at(90)); assert.equal(guestCheckoutDeadline(legacy), +at(90));
 assert.equal(paymentView(legacy).paymentClosesAt, at(90).toISOString());
});
test('refund and activation-review history never create an indefinite new-checkout block', () => {
 for (const extra of [{ status: 'paid', fulfillmentStatus: 'needs_review' }, { status: 'refund-pending', refund: { status: 'pending' } }, { status: 'paid', refund: { status: 'requested' } }]) {
  const s = blank(); s.customers.push({ id: 'c', phone: '670050099' });
  const old = { id: 'old', customerId: 'c', provider: 'mesomb', confirmedAt: at(-1000).toISOString(), createdAt: at(-1200).toISOString(), ...extra };
  s.payments.push(old); const copy = structuredClone(old);
  assert.equal(reserve(s, 0).status, 201); assert.deepEqual(old, copy);
 }
});
test('an actual admin suspension status prevents reservation and guests receive no bundle metadata', () => {
 const s = blank(); s.customers.push({ id: 'c', phone: '670050099', status: 'suspended' });
 assert.equal(reserve(s, 0).status, 403); assert.equal(s.payments.length, 0);
 s.customers[0].status = 'active'; s.vouchers.push({ id: 'private', customerId: 'c', planId: 'weekly', status: 'active', usedBytes: 999 });
 assert.equal(reserve(s, 0).body.activeBundle, undefined);
 const owner = reservePurchase(s, { planId: 'monthly', action: 'switch' }, { accountCustomerId: 'c', clock: () => at(0), provider: 'mesomb', requester: { ip: '127.0.0.1' } });
 assert.equal(owner.status, 201);
});
test('MeSomb EXPIRED is terminal and preserves optional gateway expiry evidence', async () => {
 const client = { async checkTransactions() { return [{ status: 'EXPIRED', pk: 'gateway', amount: 100, currency: 'XAF', expires_at: at(60).toISOString() }]; } };
 const adapter = new MeSombPaymentAdapter({ client });
 const result = await adapter.verifyPayment({ id: 'payment' });
 assert.equal(result.status, 'failed'); assert.equal(result.requestExpired, true); assert.equal(result.requestExpiresAt, at(60).toISOString());
});
async function fixture(t) {
 let now = at(0), gateway = 'PENDING', reads = 0, charges = 0;
 const states = new Map();
 const store = createStore({ persistent: false });
 const adapter = new MeSombPaymentAdapter({ applicationKey: 'synthetic', accessKey: 'synthetic', secretKey: 'synthetic', client: {
  async makeCollect(input) { charges++; states.set(input.trxID, 'PENDING'); return { success: true, transaction: { pk: input.trxID, status: 'PENDING' } }; },
  async checkTransactions(ids) { reads++; if (gateway === 'OFFLINE') throw Error('synthetic gateway outage'); return [{ pk: ids[0], status: states.get(ids[0]) || 'PENDING', amount: 500, currency: 'XAF' }]; },
 } });
 const handler = createHandler({ store, payments: { mesomb: adapter }, validateConfig: false, now: () => now, env: {
  NODE_ENV: 'test', PAYMENT_MODE: 'mesomb', CUSTOMER_APP_URL: 'http://customer.test', SECRET_PEPPER: 'synthetic-payments', CUSTOMER_SESSION_SECRET: 'synthetic-payments',
  BILLING_WORKER_ENABLED: 'false', NETWORK_QUEUE_ENABLED: 'false', SECURITY_ALERTS_ENABLED: 'false', LOG_LEVEL: 'silent',
 } });
 const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
 t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
 const url = 'http://127.0.0.1:' + server.address().port;
 const purchase = async key => {
  const r = await fetch(url + '/api/purchase', { method: 'POST', headers: { origin: 'http://customer.test', 'content-type': 'application/json' },
   body: JSON.stringify({ phone: '670050099', name: 'Synthetic buyer', planId: 'weekly', network: 'mtn', requestKey: key }) });
  return { status: r.status, body: await r.json() };
 };
 return { store, handler, purchase, counts: () => ({ reads, charges }), advance: n => { now = at(n); }, gateway: status => { gateway = status; for (const id of states.keys()) states.set(id, status); }, clock: () => now, adapter };
}
test('a fresh retry observes gateway expiry immediately and creates one new request without waiting local grace', async t => {
 const f = await fixture(t), first = await f.purchase('first-request-key');
 assert.equal(first.status, 201); f.advance(60); f.gateway('EXPIRED');
 const second = await f.purchase('second-request-key');
 assert.equal(second.status, 201); assert.notEqual(second.body.payment.id, first.body.payment.id);
 const old = (await f.store.snapshot()).payments.find(p => p.id === first.body.payment.id);
 assert.equal(old.status, 'expired'); assert.ok(old.checkoutClosedAt); assert.equal(old.gatewayExpiresAt, at(60).toISOString());
 assert.deepEqual(f.counts(), { reads: 1, charges: 2 });
});
test('pending gateway request keeps a finite private-safe guard and repeated keys never submit twice', async t => {
 const f = await fixture(t), first = await f.purchase('one');
 f.advance(10); const blocked = await f.purchase('two');
 assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'PAYMENT_IN_PROGRESS'); assert.equal(blocked.body.retryAfterSeconds, 290);
 assert.equal(blocked.body.payment, undefined); assert.equal(f.counts().charges, 1);
 const replay = await f.purchase('one'); assert.equal(replay.body.payment.id, first.body.payment.id); assert.equal(f.counts().charges, 1);
 f.advance(300); assert.equal((await f.purchase('two')).status, 201);
});
test('a gateway outage at expiry cannot keep new users blocked; old money remains reconcilable', async t => {
 const f = await fixture(t), first = await f.purchase('first');
 f.gateway('OFFLINE'); f.advance(60); assert.equal((await f.purchase('second')).status, 409);
 f.advance(300); assert.equal((await f.purchase('second')).status, 201);
 const old = (await f.store.snapshot()).payments.find(p => p.id === first.body.payment.id);
 assert.equal(old.status, 'expired'); assert.ok(old.lateCheckUntil);
});
test('a late paid callback remains accounted for and cannot overwrite a newer active bundle', async t => {
 const f = await fixture(t), first = await f.purchase('old');
 f.advance(300); const second = await f.purchase('new');
 await f.store.transaction(s => { s.vouchers.push({ id: 'new-voucher', paymentId: second.body.payment.id, customerId: s.customers[0].id, status: 'active', planId: 'weekly' }); });
 f.advance(1000); f.gateway('SUCCESS');
 await f.handler.billing.recheckPayment(first.body.payment.id);
 const state = await f.store.snapshot(), old = state.payments.find(p => p.id === first.body.payment.id);
 assert.equal(old.status, 'paid'); assert.equal(old.fulfillmentStatus, 'needs_review');
 assert.equal(state.vouchers[0].id, 'new-voucher');
 assert.equal((await f.purchase('third')).body.code, 'ACTIVE_BUNDLE_EXISTS');
});

test('concurrent retries after gateway expiry reserve at most one fresh payment', async t => {
 const f = await fixture(t); await f.purchase('old'); f.advance(60); f.gateway('EXPIRED');
 const results = await Promise.all([f.purchase('new-one'), f.purchase('new-two')]);
 assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
 assert.equal(f.counts().charges, 2);
 assert.equal((await f.store.snapshot()).payments.filter(p => p.status === 'pending').length, 1);
});
test('verified gateway expiry delivered by a webhook releases the same finite request guard', async t => {
 const f = await fixture(t), first = await f.purchase('old'); f.advance(60); f.gateway('EXPIRED');
 const event = await enqueuePaymentWebhook(f.store, 'mesomb', { paymentId: first.body.payment.id, eventId: 'expiry-event', transactionId: first.body.payment.id }, '{}', f.clock);
 const result = await f.handler.webhookProcessor.process(event.id);
 assert.equal(result.status, 200);
 assert.equal((await f.store.snapshot()).payments[0].status, 'expired');
 assert.equal((await f.purchase('new')).status, 201);
});

test('repeated expiry reports retain the first observed gateway deadline', () => {
 const p = { createdAt: at(0).toISOString(), status: 'pending', paymentExpiresAt: at(300).toISOString() };
 recordGatewayFailure(p, { requestExpired: true }, at(60));
 recordGatewayFailure(p, { requestExpired: true }, at(120));
 assert.equal(p.gatewayExpiresAt, at(60).toISOString());
 assert.equal(p.checkoutClosedAt, at(60).toISOString());
});

test('legacy missing snapshots keep the same fixed fallback for block, countdown and private key', () => {
 const p = { createdAt: at(0).toISOString(), status: 'pending', provider: 'mesomb' };
 assert.equal(checkoutDeadline(p, { pendingSeconds: 3600 }), +at(300));
 assert.equal(paymentView(p, { timing: { pendingSeconds: 3600 }, now: at(0) }).paymentClosesAt, at(300).toISOString());
 assert.equal(guestCheckoutDeadline(p), +at(300));
});
