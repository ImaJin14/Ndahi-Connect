import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createStore } from '../server.mjs';
import { notificationItems, deliverActivityPush } from '../lib/notifications.mjs';
import { deliveryId, subscriptionVersion, deliverNotification } from '../lib/notification-delivery.mjs';
import { createNotificationEmailSender } from '../lib/notification-email.mjs';
import { notificationTarget } from '../shared-app/notification-target.js';
import { pairingFixture } from './helpers/wifi-pairing-fixture.mjs';
const config = { enabled: true, publicKey: 'fixture', privateKey: 'fixture', subject: 'mailto:fixture@example.test' };
const sub = () => ({ endpoint: 'https://fcm.googleapis.com/send/synthetic', keys: { auth: 'a'.repeat(22), p256dh: 'B'.repeat(87) } });
async function fixture() {
  const store = createStore({ persistent: false }); let time = new Date('2030-01-01T12:00:00Z');
  await store.transaction(s => {
    s.customers.push({ id: 'c', phone: '670000001', email: 'verified@example.test', emailVerifiedAt: time.toISOString(), emailVerificationRequired: true, activeVoucherId: 'v', pushSubscriptions: [] });
    s.notificationStates.push({ id: 'preferences:customer:c', actor: 'customer:c', pushEnabled: false, emailFallback: true, expiryWarnings: true, pushSince: time.toISOString() });
    s.vouchers.push({ id: 'v', customerId: 'c', code: 'NC-AAAA-2222', status: 'active', planId: 'weekly', quotaBytes: 1e9, usedBytes: 999000000,
      activatedAt: time.toISOString(), expiresAt: new Date(+time + 1800000).toISOString(), lastUsageSyncAt: time.toISOString(), usageAlerts: { low: { status: 'no_subscription', at: time.toISOString() } } });
  });
  return { store, now: () => time, advance: ms => { time = new Date(+time + ms); } };
}
test('push fingerprints ignore JSONB key ordering and retain prior sent delivery identities', async () => {
  const f = await fixture(), a = sub(), b = { ...a, keys: { p256dh: a.keys.p256dh, auth: a.keys.auth } };
  assert.equal(subscriptionVersion(a), subscriptionVersion(b));
  const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
  await f.store.transaction(s => {
    s.customers[0].pushSubscriptions = [b];
    s.notificationStates.push({ id: 'delivery:' + digest(['customer:c', 'event', digest([a.endpoint, a.keys])]), actor: 'customer:c', version: 'v1', status: 'sent', attempts: 1 });
  });
  const result = await deliverNotification({ ...f, config, recipient: 'customer:c', eventId: 'event', version: 'v1', subscription: b,
    resolve: () => ({ version: 'v1', payload: {} }), send: () => { throw Error('replayed previously sent notification'); } });
  assert.equal(result.delivered, false);
  assert.equal((await f.store.snapshot()).notificationStates.find(n => n.id === deliveryId('customer:c', 'event', b)).status, 'sent');
});
test('voucher notification requires committed server-confirmed paid ownership and never carries a code in push', async () => {
  const f = await fixture();
  const seed = s => { s.payments.push({ id: 'p', customerId: 'c', status: 'paid', confirmedAt: f.now().toISOString() }); s.vouchers[0].paymentId = 'p'; };
  await assert.rejects(f.store.transaction(s => { seed(s); throw Error('rollback'); }));
  assert.equal(notificationItems(await f.store.snapshot(), { type: 'customer', id: 'c' }, f.now()).some(n => n.id.startsWith('voucher-ready:')), false);
  await f.store.transaction(s => { seed(s); s.customers[0].pushSubscriptions = [sub()]; Object.assign(s.notificationStates[0], { pushEnabled: true }); });
  const sent = []; await deliverActivityPush({ ...f, config, send: async (_s, text) => sent.push(JSON.parse(text)) });
  assert.ok(sent.some(n => n.url === '/dashboard#vouchers'));
  assert.doesNotMatch(JSON.stringify(sent), /NC-AAAA|verified@example|670000001/);
  await f.store.transaction(s => { s.payments[0].customerId = 'someone-else'; });
  assert.equal(notificationItems(await f.store.snapshot(), { type: 'customer', id: 'c' }, f.now()).some(n => n.id.startsWith('voucher-ready:')), false);
});
test('connection intent and superseded disconnect do not become router-confirmed push events', async () => {
  const f = await fixture(); await f.store.transaction(s => {
    s.wifiPairingRequests.push({ id: 'r', customerId: 'c', mac: 'AA:BB:CC:DD:EE:01', status: 'connecting', at: f.now().toISOString() });
    s.routerCommands.push({ id: 'connect', targetId: 'r', action: 'connect_wifi_device', device: { voucherId: 'v' }, status: 'processing' },
      { id: 'disconnect', action: 'disconnect_wifi_device', device: { voucherId: 'v', mac: 'AA:BB:CC:DD:EE:01' }, status: 'processed', result: 'superseded', processedAt: f.now().toISOString() });
  });
  let items = notificationItems(await f.store.snapshot(), { type: 'customer', id: 'c' }, f.now());
  assert.equal(items.some(n => n.id.startsWith('wifi-connected:')), false);
  assert.equal(items.find(n => n.id === 'wifi-disconnect:disconnect').pushEligible, false);
  await f.store.transaction(s => { Object.assign(s.routerCommands[0], { status: 'processed', result: 'connected', processedAt: f.now().toISOString() }); });
  items = notificationItems(await f.store.snapshot(), { type: 'customer', id: 'c' }, f.now()); assert.equal(items.filter(n => n.id === 'wifi-connected:connect').length, 1);
});
test('verified-email fallback leases across independent workers and retries with one stable provider key', async () => {
  const f = await fixture(), calls = []; await f.store.transaction(s => { s.notificationStates[0].expiryWarnings = false; }); let entered, release;
  const started = new Promise(r => { entered = r; }), held = new Promise(r => { release = r; });
  const email = { configured: () => true, sendAccountMessage: async m => { calls.push(m); entered(); await held; return { messageId: 'accepted' }; } };
  const first = createNotificationEmailSender({ ...f, email, config })(); await started;
  await createNotificationEmailSender({ ...f, email, config })(); release(); await first;
  await createNotificationEmailSender({ ...f, email, config })();
  assert.equal(calls.length, 1, 'one low-data mail leased once');
  assert.equal(new Set(calls.map(m => m.deliveryKey)).size, 1);
  assert.doesNotMatch(JSON.stringify(calls), /NC-AAAA/);
});
test('fallback obeys current verified mailbox, opt-in, categories, read/archive and stale readings', async () => {
  for (const change of [s => { delete s.customers[0].emailVerifiedAt; }, s => { s.customers[0].suspended = true; },
    s => { s.notificationStates[0].emailFallback = false; }, s => { s.notificationStates[0].categories = { usage: false }; },
    s => { s.vouchers[0].lastUsageSyncAt = '2029-01-01T00:00:00Z'; s.notificationStates[0].expiryWarnings = false; },
    s => { const items = notificationItems(s, { type: 'customer', id: 'c' }, new Date('2030-01-01T12:00:00Z')); for (const item of items) s.notificationStates.push({ id: 'inbox:' + item.id, actor: 'customer:c', notificationId: item.id, archivedVersion: item.version }); }]) {
    const f = await fixture(), calls = []; await f.store.transaction(change);
    await createNotificationEmailSender({ ...f, config, email: { sendAccountMessage: async m => calls.push(m) } })(); assert.equal(calls.length, 0);
  }
});
test('fallback never competes with accepted or still-retrying push delivery', async () => {
  for (const status of ['sent', 'retry', 'sending', undefined, 'failed']) {
    const f = await fixture(), calls = []; await f.store.transaction(s => {
      s.customers[0].pushSubscriptions = [sub()]; s.notificationStates[0].pushEnabled = true;
      if (status) for (const item of notificationItems(s, { type: 'customer', id: 'c' }, f.now())) s.notificationStates.push({ id: deliveryId('customer:c', item.id, sub()), actor: 'customer:c', notificationId: item.id, version: item.version, status });
    });
    await createNotificationEmailSender({ ...f, config, email: { sendAccountMessage: async m => calls.push(m) } })(); assert.equal(calls.length, status === 'failed' ? 2 : 0);
  }
});
test('fallback cancels a consent/recipient change between claim and provider I/O', async () => {
  const f = await fixture(), calls = []; let transactions = 0;
  const store = { snapshot: () => f.store.snapshot(), transaction: async cb => {
    transactions++; if (transactions === 2) await f.store.transaction(s => { s.notificationStates[0].emailFallback = false; s.customers[0].email = 'other@example.test'; });
    return f.store.transaction(cb);
  } };
  await createNotificationEmailSender({ ...f, store, config, email: { sendAccountMessage: async m => calls.push(m) } })(); assert.equal(calls.length, 0);
});
test('notification targets reject credentials, encoded/external/malformed destinations in both service workers', async () => {
  for (const input of ['https://evil.test', '//evil.test', '/dashboard?pin=1234', '/dashboard#key=secret', '/dashboard#%61ccount', '/dashboard\\evil', 'http://[', null]) assert.equal(notificationTarget(input), null);
  for (const app of ['customer', 'admin']) {
    const handlers = {}, opened = [], self = { location: { origin: 'https://portal.test' }, addEventListener: (n, f) => { handlers[n] = f; }, clients: { matchAll: async () => [], openWindow: async url => opened.push(url) }, registration: { showNotification: async () => {} } };
    vm.runInNewContext(await readFile(new URL('../' + app + '-app/sw.js', import.meta.url), 'utf8'), { self, URL, Promise });
    for (const url of ['https://evil.test', '/dashboard?key=secret', '/dashboard#pin=1234', 'http://[']) handlers.notificationclick({ notification: { close() {}, data: { url } }, waitUntil() { throw Error('unsafe URL navigated'); } });
    let pending; handlers.notificationclick({ notification: { close() {}, data: { url: '/dashboard#vouchers' } }, waitUntil: p => { pending = p; } }); await pending;
    assert.deepEqual(opened, ['https://portal.test/dashboard#vouchers']);
  }
});
test('fallback preference validates, persists across sessions and never changes payment/account state', async t => {
  const f = await pairingFixture(); t.after(f.close);
  assert.equal((await f.call('/api/account/notifications', { action: 'preferences', emailFallback: 'yes' })).status, 400);
  const before = await f.store.snapshot();
  assert.equal((await f.call('/api/account/notifications', { action: 'preferences', emailFallback: true })).status, 200);
  assert.equal((await f.call('/api/account/notifications', undefined, { session: 'secondary' })).body.preferences.emailFallback, true);
  const after = await f.store.snapshot(); assert.deepEqual(after.payments, before.payments); assert.deepEqual(after.vouchers, before.vouchers);
});

test('unknown email acknowledgements retry with the same identity and stop after five attempts', async () => {
  const f = await fixture(), keys = [];
  await f.store.transaction(s => { s.notificationStates[0].expiryWarnings = false; s.vouchers[0].usageAlerts = { 100: { status: 'no_subscription', at: f.now().toISOString() } }; s.vouchers[0].status = 'exhausted'; s.vouchers[0].usedBytes = 1e9; });
  const sender = () => createNotificationEmailSender({ ...f, config, email: { sendAccountMessage: async m => { keys.push(m.deliveryKey); throw Error('accepted but reply was lost'); } } })();
  for (let n = 0; n < 7; n++) { await sender(); f.advance(3600000); }
  assert.equal(keys.length, 5); assert.equal(new Set(keys).size, 1);
});
