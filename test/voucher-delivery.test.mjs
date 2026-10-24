import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, createStore } from '../server.mjs';
import { automaticVoucherDownload, purchasedVoucher, purchaseVoucherDestination, downloadVoucherPdf } from '../customer-app/voucher-delivery.js';
import { customerDestination, customerEntry } from '../customer-app/customer-destination.js';

test('voucher continuation strips unrelated credentials and pauses automatic Wi-Fi handoff', () => {
  const target = purchaseVoucherDestination('payment-1');
  assert.equal(customerDestination(target + '&pin=1234&key=secret&next=https://evil.test'), target);
  for (const input of ['/voucher-ready.html?payment=https://evil.test', '/voucher-ready.html?payment=%5cevil']) assert.equal(customerDestination(input), '/dashboard');
  const evidence = { version: 1, expiresAt: '2030-01-01T13:00:00Z', account: { state: 'authenticated' }, network: { state: 'confirmed' }, subscription: { state: 'active' }, router: { state: 'reachable' }, hotspot: { state: 'unauthenticated' } };
  assert.equal(customerEntry({ next: target, evidence, now: Date.parse('2030-01-01T12:00:00Z'), hasCandidate: true, hotspotEnabled: true }), target);
});
test('automatic download is limited to supported non-Apple standalone contexts without captive identity', () => {
  const safe = { supported: true, standalone: true, apple: false, webView: false, captive: false };
  assert.equal(automaticVoucherDownload(safe), true);
  for (const change of [{ supported: false }, { standalone: false }, { apple: true }, { webView: true }, { captive: true }]) assert.equal(automaticVoucherDownload({ ...safe, ...change }), false);
});
test('only the exact confirmed paid voucher is selected, including retained history', () => {
  const voucher = { id: 'v', paymentId: 'p', code: 'NC-AAAA-2222', status: 'expired', activatedAt: '2030-01-01T00:00:00Z' };
  const result = { payments: [{ id: 'p', status: 'paid', confirmedAt: '2030-01-01T00:00:00Z' }], vouchers: [voucher] };
  assert.equal(purchasedVoucher(result, 'p'), voucher); assert.equal(purchasedVoucher(result, 'another'), null);
  for (const patch of [{ status: 'pending' }, { confirmedAt: null }, { fulfillmentStatus: 'needs_review' }]) assert.equal(purchasedVoucher({ ...result, payments: [{ ...result.payments[0], ...patch }] }, 'p'), null);
});
test('download failure and invalid PDF never offer a fake document, valid PDF offers without claiming saved', async () => {
  const offered = [], doc = { createElement: () => ({ click() { offered.push(this.download); }, remove() {} }), body: { appendChild() {} } }, urls = { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} };
  for (const response of [new Response('unavailable', { status: 503 }), new Response('<html>login</html>', { headers: { 'content-type': 'application/pdf' } })]) await assert.rejects(downloadVoucherPdf({ api: 'https://api.test', id: 'v', document: doc, urls, fetcher: async () => response }));
  assert.equal(offered.length, 0);
  let options;
  const message = await downloadVoucherPdf({ api: 'https://api.test', id: 'v', document: doc, urls, fetcher: async (_u, o) => { options = o; return new Response('%PDF-fixture', { headers: { 'content-type': 'application/pdf' } }); } });
  assert.equal(options.credentials, 'include'); assert.equal(options.cache, 'no-store'); assert.equal(offered.length, 1); assert.match(message, /offered to your browser/);
});
test('duplicate verified callbacks retain one NC voucher and private repeatable PDF after PIN setup', async t => {
  const store = createStore({ persistent: false });
  const server = createServer({ store, env: { NODE_ENV: 'test', PAYMENT_MODE: 'mock', EMAIL_MODE: 'mock', MIKROTIK_MODE: 'mock', OMADA_MODE: 'not-configured', BILLING_WORKER_ENABLED: 'false', SESSION_COOKIE_SECURE: 'false', CUSTOMER_SESSION_SECRET: 'voucher-fixture', ADMIN_PIN: '9999' } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const api = `http://127.0.0.1:${server.address().port}`;
  const call = (path, input, cookie = '') => fetch(api + path, { method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const requestKey = randomUUID().replaceAll('-', ''), created = await (await call('/api/purchase', { phone: '670080091', planId: 'weekly', requestKey })).json(), id = created.payment.id;
  assert.equal((await call(`/api/payments/${id}/confirm`, {})).status, 200);
  assert.equal((await call(`/api/payments/${id}/confirm`, {})).status, 200);
  let snapshot = await store.snapshot(); assert.equal(snapshot.vouchers.length, 1); const voucher = snapshot.vouchers[0]; assert.match(voucher.code, /^NC-[A-Z0-9]{4}-[A-Z0-9]{4}$/); assert.equal(voucher.paymentId, id);
  const setup = await call('/api/account/setup/checkout', { paymentId: id, requestKey }), setupCookie = setup.headers.getSetCookie().find(x => x.startsWith('checkout_setup=')).split(';')[0];
  assert.equal((await call('/api/account/vouchers/' + voucher.id + '/download', undefined, setupCookie)).status, 401, 'limited PIN setup cookie cannot download private history');
  const signed = await call('/api/account/setup/pin', { checkoutSetup: true, pin: '2468', confirmPin: '2468' }, setupCookie), cookie = signed.headers.getSetCookie().find(x => x.startsWith('customer_session=')).split(';')[0];
  const dashboard = await (await call('/api/account/dashboard', undefined, cookie)).json(); assert.equal(purchasedVoucher(dashboard, id).id, voucher.id);
  for (let n = 0; n < 2; n++) {
    const pdf = await call('/api/account/vouchers/' + voucher.id + '/download', undefined, cookie); assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('cache-control'), 'no-store'); assert.match(Buffer.from(await pdf.arrayBuffer()).toString('ascii', 0, 5), /^%PDF-/);
  }
  assert.equal((await call('/api/account/vouchers/' + voucher.id + '/download')).status, 401);
  snapshot = await store.snapshot(); assert.equal(snapshot.vouchers.length, 1); assert.equal(snapshot.payments.length, 1); assert.equal(snapshot.payments[0].status, 'paid'); assert.equal(snapshot.customers[0].email || '', '');
});
