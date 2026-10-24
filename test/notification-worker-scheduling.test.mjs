import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createStore } from '../server.mjs';

test('listening server dispatches opted-in verified email fallback even with Web Push unconfigured', async t => {
  const store = createStore({ persistent: false }), now = new Date('2030-01-01T12:00:00Z'), sent = [];
  await store.transaction(s => {
    s.customers.push({ id: 'c', phone: '670000001', email: 'verified@example.test', emailVerifiedAt: now.toISOString(), emailVerificationRequired: true });
    s.notificationStates.push({ id: 'preferences:customer:c', actor: 'customer:c', emailFallback: true, expiryWarnings: true });
    s.vouchers.push({ id: 'v', customerId: 'c', status: 'active', planId: 'weekly', quotaBytes: null, expiresAt: new Date(+now + 1800000).toISOString() });
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  let resolveDelivery;
  const delivery = new Promise(resolve => { resolveDelivery = resolve; });
  const server = createServer({ store, now: () => now, email: { configured: () => true, sendAccountMessage: async message => { sent.push(message); resolveDelivery(); return { messageId: 'synthetic-accepted' }; } }, env: {
    NODE_ENV: 'test', PAYMENT_MODE: 'mock', EMAIL_MODE: 'mock', MIKROTIK_MODE: 'mock', OMADA_MODE: 'not-configured', ADMIN_PIN: '9999',
    BILLING_WORKER_ENABLED: 'false', MONITORING_ENABLED: 'false', SECURITY_ALERTS_ENABLED: 'false', NETWORK_QUEUE_ENABLED: 'false', WEBHOOK_REPLAY_ENABLED: 'false', ROUTER_RECONCILIATION_ENABLED: 'false',
    WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '', WEB_PUSH_SUBJECT: '',
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  let timeout;
  try {
    t.mock.timers.tick(15000);
    await Promise.race([delivery, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Background email fallback was never scheduled without Web Push')), 1000); })]);
    assert.equal(sent.length, 1); assert.equal(sent[0].to, 'verified@example.test'); assert.equal(sent[0].path, '/dashboard#bundles');
  } finally { clearTimeout(timeout); }
});
