import test from 'node:test';
import assert from 'node:assert/strict';
import { blank } from '../lib/api/state.mjs';
import { redeemVoucher } from '../lib/domain/vouchers.mjs';

function fixture() {
  const state = blank();
  state.customers.push({ id: 'customer', phone: '670000001', name: 'Ada' });
  state.vouchers.push({ id: 'voucher', code: 'NC-ABCD-2345', planId: 'weekly', status: 'active', customerId: 'customer', deviceLimit: 1, quotaBytes: null, usedBytes: 0 });
  const clock = () => new Date();
  const redeem = (phone, code = 'ABCD-2345', ip = '198.51.100.1') => redeemVoucher(state, { phone, code, deviceId: 'phone' }, { clock, requester: { ip }, generic: 'Invalid details.' });
  return { state, redeem };
}

test('unrelated failed voucher entries on a shared IP do not block a valid customer', () => {
  const { state, redeem } = fixture();
  for (let i = 0; i < 20; i++) assert.equal(redeem(`670000${String(i + 100).padStart(3, '0')}`, 'WRONG').status, 401);
  assert.equal(redeem('670000001').status, 200);
  assert.equal(state.sessions.length, 1);
});

test('voucher attempts remain limited per normalized phone across IPs', () => {
  const { state, redeem } = fixture();
  for (let i = 0; i < 20; i++) assert.equal(redeem('+237 670 000 009', 'WRONG', `198.51.100.${i + 1}`).status, 401);
  assert.equal(redeem('670000009', 'WRONG', '203.0.113.1').status, 429);
  assert.equal(state.securityEvents.filter(e => e.type === 'redeem.failed' && e.meta?.phone === '670000009').length, 20);
  assert.equal(redeem('670000001').status, 200);
});

test('legacy events without a phone count toward the larger shared IP ceiling and expire', () => {
  const { state, redeem } = fixture();
  const event = { type: 'redeem.failed', ip: '198.51.100.1', meta: {}, at: new Date().toISOString() };
  state.securityEvents.push(...Array.from({ length: 99 }, () => ({ ...event })));
  assert.equal(redeem('670000001').status, 200);
  state.securityEvents.push({ ...event });
  assert.equal(redeem('670000001').status, 429);
  for (const item of state.securityEvents) item.at = new Date(Date.now() - 901000).toISOString();
  assert.equal(redeem('670000001').status, 200);
});
