import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { blank } from '../server.mjs';
import { createPostgresStore } from '../lib/postgres-store.mjs';
import { deliverNotification, deliveryId } from '../lib/notification-delivery.mjs';
import { createNotificationEmailSender } from '../lib/notification-email.mjs';
const url = process.env.TEST_DATABASE_URL;
test('PostgreSQL push JSONB fingerprints, rollback, concurrent workers and reopened fallback are durable', { skip: url ? false : 'TEST_DATABASE_URL is not set' }, async () => {
  const schema = `ndahi_push139_${process.pid}`, admin = new pg.Client({ connectionString: url }); await admin.connect(); let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(x => /^\d+_.+\.sql$/.test(x)).sort()) await pool.query(await readFile(new URL(file, dir), 'utf8'));
    const store = createPostgresStore({ pool, initialState: blank }), reopened = createPostgresStore({ pool, initialState: blank });
    const subscription = { endpoint: 'https://fcm.googleapis.com/send/jsonb', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }, time = new Date('2030-01-01T12:00:00Z'), now = () => time;
    const seed = s => {
      s.customers.push({ id: 'c', phone: '670000001', email: 'verified@example.test', emailVerifiedAt: now().toISOString(), pushSubscriptions: [subscription] });
      s.notificationStates.push({ id: 'preferences:customer:c', actor: 'customer:c', emailFallback: true, expiryWarnings: true });
      s.vouchers.push({ id: 'v', customerId: 'c', status: 'active', planId: 'weekly', quotaBytes: null, expiresAt: '2030-01-01T12:30:00Z' });
    };
    await assert.rejects(store.transaction(s => { seed(s); throw Error('rolled back'); })); assert.equal((await reopened.snapshot()).customers.length, 0);
    await store.transaction(seed);
    let entered, release; const started = new Promise(r => { entered = r; }), held = new Promise(r => { release = r; }); let sent = 0;
    const options = { config: { enabled: true, publicKey: 'fixture', privateKey: 'fixture', subject: 'mailto:fixture@example.test' }, now, recipient: 'customer:c', eventId: 'security', version: '1', subscription,
      resolve: () => ({ version: '1', payload: { url: '/dashboard#account' } }), send: async () => { sent++; entered(); await held; } };
    const first = deliverNotification({ ...options, store }); await started;
    await deliverNotification({ ...options, store: reopened }); assert.equal(sent, 1); release(); await first;
    const saved = (await reopened.snapshot()).notificationStates.find(n => n.id === deliveryId('customer:c', 'security', subscription)); assert.equal(saved.status, 'sent');
    await deliverNotification({ ...options, store: reopened }); assert.equal(sent, 1);
    const mail = [], email = { sendAccountMessage: async m => { mail.push(m); return { messageId: 'accepted' }; } };
    await createNotificationEmailSender({ store, email, config: { enabled: false }, now })();
    await createNotificationEmailSender({ store: reopened, email, config: { enabled: false }, now })(); assert.equal(mail.length, 1);
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});
