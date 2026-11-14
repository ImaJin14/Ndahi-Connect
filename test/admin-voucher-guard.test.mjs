import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createServer, createStore, blank } from '../server.mjs';
import { createPostgresStore } from '../lib/postgres-store.mjs';
import { hashSecret } from '../lib/security.mjs';

const at = '2030-01-01T12:00:00.000Z', origin = 'http://admin.test';
async function fixture(t, postgres) {
  let store, otherStore;
  if (postgres) {
    const schema = `ndahi_guard_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(x => /^\d+_.+\.sql$/.test(x)).sort()) await pool.query(await readFile(new URL(file, dir), 'utf8'));
    store = createPostgresStore({ pool, initialState: blank });
    // Independent store objects: correctness must come from database locks.
    otherStore = createPostgresStore({ pool, initialState: blank });
  } else store = otherStore = createStore({ persistent: false });
  const secret = randomUUID();
  await store.transaction(s => {
    s.customers.push({ id: 'c1', phone: '670000001', name: 'Guard test' });
    s.adminUsers.push({ id: 'staff', username: 'guard-test', role: 'operator', active: true });
    s.adminSessions.push({ userId: 'staff', tokenHash: hashSecret('token', secret), csrfToken: 'csrf', expiresAt: '2030-01-02T00:00:00Z' });
    s.vouchers.push({ id: 'active-a', customerId: 'c1', planId: 'daily', code: 'NC-GUARD-A', status: 'active', activatedAt: at, expiresAt: '2030-01-02T00:00:00Z', quotaBytes: 1e9, usedBytes: 0, deviceLimit: 1 });
  });
  const servers = [];
  for (const database of [store, otherStore]) {
    const server = createServer({ store: database, now: () => new Date(at), validateConfig: false, env: {
      NODE_ENV: 'test', ADMIN_SESSION_SECRET: secret, SESSION_COOKIE_SECURE: 'false', ADMIN_APP_URL: origin, ALLOWED_ADMIN_ORIGINS: origin,
      PAYMENT_MODE: 'mock', EMAIL_MODE: 'mock', MIKROTIK_MODE: 'mock', OMADA_MODE: 'mock', BILLING_WORKER_ENABLED: 'false', NETWORK_QUEUE_ENABLED: 'false', SECURITY_ALERTS_ENABLED: 'false', PAYMENT_WEBHOOK_WORKER_ENABLED: 'false',
    } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  }
  t.after(async () => { for (const server of servers) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return { store, call: async (body, index = 0) => {
    const response = await fetch(`http://127.0.0.1:${servers[index].address().port}/api/admin/vouchers/generate`, { method: 'POST', headers: { cookie: 'admin_session=token', origin, 'content-type': 'application/json', 'x-csrf-token': 'csrf' }, body: JSON.stringify({ purpose: 'assigned', customerId: 'c1', planId: 'weekly', saleType: 'sold', replaceActive: true, ...body }) });
    return { status: response.status, body: await response.json() };
  } };
}
for (const postgres of [false, true]) {
  const options = { skip: postgres && !process.env.TEST_DATABASE_URL ? 'TEST_DATABASE_URL is not set' : false };
  const label = postgres ? 'PostgreSQL independent API instances' : 'serialized memory store';
  test(`${label}: concurrent replacements commit once and reject stale consent without side effects`, options, async t => {
    const f = await fixture(t, postgres);
    const results = await Promise.all([f.call({ expectedActiveVoucherId: 'active-a' }), f.call({ expectedActiveVoucherId: 'active-a' }, 1)]);
    assert.deepEqual(results.map(x => x.status).sort(), [201, 409]);
    const success = results.find(x => x.status === 201), conflict = results.find(x => x.status === 409);
    assert.equal(conflict.body.code, 'ACTIVE_BUNDLE_CHANGED'); assert.equal(conflict.body.activeBundle.id, success.body.voucher.id);
    const s = await f.store.snapshot();
    assert.equal(s.vouchers.length, 2); assert.equal(s.vouchers.filter(v => v.status === 'active').length, 1);
    assert.equal(s.vouchers.find(v => v.id === 'active-a').replacedByVoucherId, success.body.voucher.id);
    assert.equal(s.auditLogs.filter(a => a.action === 'voucher.generated').length, 1);
    assert.equal(s.auditLogs.filter(a => a.action === 'voucher.admin_replaced').length, 1);
    assert.equal(s.routerCommands.length, 2); assert.equal(s.routerCommands.filter(c => c.action === 'disconnect_voucher').length, 1);
    assert.equal(s.vouchers.reduce((sum, v) => sum + (v.saleAmount || 0), 0), success.body.plan.price);
  });
  test(`${label}: explicit null, disappearance and invalid guards cannot create plans or vouchers`, options, async t => {
    const f = await fixture(t, postgres), before = await f.store.snapshot();
    const custom = { planMode: 'custom', name: 'Must not persist', price: 100, quotaGb: 1, validityHours: 24, deviceLimit: 1 };
    for (const expectedActiveVoucherId of [null, 'different-id']) {
      const result = await f.call({ ...custom, expectedActiveVoucherId });
      assert.equal(result.status, 409); assert.equal(result.body.code, 'ACTIVE_BUNDLE_CHANGED'); assert.equal(result.body.activeBundle.id, 'active-a');
    }
    for (const expectedActiveVoucherId of ['', ' ', false, 4, {}, []]) assert.equal((await f.call({ ...custom, expectedActiveVoucherId })).status, 400);
    assert.equal((await f.call({ expectedActiveVoucherId: 'active-a', replaceActive: false })).body.code, 'ACTIVE_BUNDLE_EXISTS');
    let after = await f.store.snapshot();
    for (const key of ['vouchers', 'bundles', 'routerCommands', 'auditLogs']) assert.deepEqual(after[key], before[key], key);
    await f.store.transaction(s => { s.vouchers[0].status = 'expired'; });
    const gone = await f.call({ expectedActiveVoucherId: 'active-a' });
    assert.equal(gone.status, 409); assert.equal(gone.body.activeBundle, null);
    const results = await Promise.all([f.call({ expectedActiveVoucherId: null }), f.call({ expectedActiveVoucherId: null }, 1)]);
    assert.deepEqual(results.map(x => x.status).sort(), [201, 409]);
    after = await f.store.snapshot(); assert.equal(after.vouchers.length, 2); assert.equal(after.vouchers[1].status, 'expired');
    assert.equal(after.auditLogs.filter(a => a.action === 'voucher.admin_replaced').length, 0);
    assert.equal(after.routerCommands.length, 1);
  });
}
