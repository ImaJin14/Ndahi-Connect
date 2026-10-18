import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler, createStore } from '../server.mjs';
import { hashSecret } from '../lib/security.mjs';
import { RouterHotspot, routerSeconds } from '../lib/router-hotspot.mjs';
import { createRouterCommandProcessor, enqueueRouterCommand } from '../lib/router-queue.mjs';
import { requestWifiDisconnect, wifiDeviceView } from '../lib/wifi-devices.mjs';
import { createRouterReconciler } from '../lib/router-reconciliation.mjs';
import { sessionStore, requestJson } from '../customer-app/compat.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';

const now = new Date('2030-01-01T00:10:00Z');
const device = { mac: 'AA:BB:CC:DD:EE:01', sessionId: '*A', startedAt: '2030-01-01T00:05:00.000Z', address: '10.20.0.30', uptime: '5m', usedBytes: 100 };
const voucher = () => ({ id: 'v1', code: 'NC-TEST-1234', customerId: 'c1', status: 'active', quotaBytes: 5e9, usedBytes: 200, planId: 'weekly', deviceLimit: 2,
  activatedAt: '2029-12-31T00:00:00Z', expiresAt: '2030-01-02T00:00:00Z', wifiDevices: [structuredClone(device)], wifiDevicesAt: now.toISOString() });
async function stateFixture() {
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher()); });
  return store;
}
function routerFixture() {
  const router = new RouterHotspot({ now: () => now });
  const state = {
    users: [{ '.id': '*U', name: 'NC-TEST-1234', comment: 'ndahi:voucher:v1' }, { name: 'NC-OTHER-1234', comment: 'ndahi:voucher:v2' }],
    active: [{ '.id': '*A', user: 'NC-TEST-1234', 'mac-address': device.mac, uptime: '5m' },
      { '.id': '*B', user: 'NC-OTHER-1234', 'mac-address': device.mac, uptime: '3m' }],
    cookies: [{ '.id': '*C', user: 'NC-TEST-1234', 'mac-address': device.mac }, { '.id': '*D', user: 'NC-OTHER-1234', 'mac-address': device.mac }],
  };
  const writes = [];
  router.request = async (path, method = 'GET') => {
    if (method === 'DELETE') {
      writes.push(path);
      const id = decodeURIComponent(path.split('/').at(-1));
      if (path.startsWith('ip/hotspot/active/')) state.active = state.active.filter((r) => r['.id'] !== id);
      else state.cookies = state.cookies.filter((r) => r['.id'] !== id);
      return {};
    }
    return structuredClone(path === 'ip/hotspot/user' ? state.users : path === 'ip/hotspot/active' ? state.active : state.cookies);
  };
  const target = { voucherId: 'v1', username: 'NC-TEST-1234', ...device };
  return { router, state, writes, target };
}

test('scoped router disconnection confirms removal and leaves another voucher using the same MAC untouched', async () => {
  const f = routerFixture();
  assert.deepEqual(await f.router.disconnectWifiDevice(f.target), { confirmed: true, outcome: 'disconnected' });
  assert.deepEqual(f.writes, ['ip/hotspot/cookie/*C', 'ip/hotspot/active/*A']);
  assert.equal(f.state.active[0].user, 'NC-OTHER-1234');
  assert.equal(f.state.cookies[0].user, 'NC-OTHER-1234');
  assert.deepEqual(await f.router.disconnectWifiDevice(f.target), { confirmed: true, outcome: 'absent' }, 'a lost response can be retried safely');
});

for (const [label, change] of [
  ['a new router session', (f) => { f.state.active[0]['.id'] = '*NEW'; }],
  ['a reused router ID after reconnect', (f) => { f.state.active[0].uptime = '1m'; }],
  ['changed voucher ownership', (f) => { f.state.users[0].comment = 'ndahi:voucher:someone-else'; }],
]) test(`a delayed disconnect preserves ${label}`, async () => {
  const f = routerFixture(); change(f);
  assert.equal((await f.router.disconnectWifiDevice(f.target)).outcome, 'superseded');
  assert.deepEqual(f.writes, []);
});

test('legacy MAC-only live commands refuse to claim success or disconnect unrelated sessions', async () => {
  const f = routerFixture();
  await assert.rejects(f.router.disconnectDevice(device.mac), { code: 'UNSCOPED_DISCONNECT' });
  assert.deepEqual(f.writes, []);
});

test('router removal must be verified rather than inferred from an accepted delete', async () => {
  const f = routerFixture(), read = f.router.request;
  f.router.request = (path, method) => method === 'DELETE' && path.includes('/active/') ? Promise.resolve({}) : read(path, method);
  await assert.rejects(f.router.disconnectWifiDevice(f.target), /still reports this session/);
});

test('accepted and retried operations retain the device slot until a confirmed router result', async () => {
  const store = await stateFixture();
  const request = await store.transaction((s) => requestWifiDisconnect(s, s.vouchers[0], { mac: device.mac }, () => now));
  assert.equal(request.status, 202);
  assert.equal(request.body.devices.length, 1);
  assert.equal(request.body.devices[0].disconnect.status, 'disconnecting');
  await store.transaction((s) => requestWifiDisconnect(s, s.vouchers[0], { mac: device.mac }, () => now));
  assert.equal((await store.snapshot()).routerCommands.length, 1, 'repeated clicks coalesce');
  assert.equal((await store.snapshot()).routerCommands[0].kind, 'wifi_disconnect', 'older workers must not claim a new scoped job during rolling deployment');
  const failed = createRouterCommandProcessor({ store, now: () => now, maxAttempts: 1, router: { disconnectWifiDevice: async () => { throw Error('unreachable'); } } });
  await failed.process(request.body.operation.id);
  let state = await store.snapshot();
  assert.equal(wifiDeviceView(state, state.vouchers[0]).devices[0].disconnect.status, 'failed');
  assert.equal(state.vouchers[0].wifiDevices.length, 1);
  await store.transaction((s) => requestWifiDisconnect(s, s.vouchers[0], { mac: device.mac }, () => now));
  const processor = createRouterCommandProcessor({ store, now: () => now, router: { disconnectWifiDevice: async () => ({ confirmed: true, outcome: 'disconnected' }) } });
  await processor.process(request.body.operation.id);
  state = await store.snapshot();
  assert.equal(state.vouchers[0].wifiDevices.length, 0);
  assert.equal(state.vouchers[0].usedBytes, 200);
  assert.equal(state.vouchers[0].status, 'active');
  assert.equal(wifiDeviceView(state, state.vouchers[0]).disconnects[0].status, 'disconnected');
  assert.ok(state.routerCommands.some((c) => c.action === 'sync_usage' && c.status === 'queued'));
});

test('an old bridge returning apparent success cannot confirm disconnection', async () => {
  const store = await stateFixture();
  const request = await store.transaction((s) => requestWifiDisconnect(s, s.vouchers[0], { mac: device.mac }, () => now));
  const processor = createRouterCommandProcessor({ store, now: () => now, router: { disconnectWifiDevice: async () => ({ disconnected: true }) } });
  assert.equal((await processor.process(request.body.operation.id)).retried, true);
  assert.equal((await store.snapshot()).vouchers[0].wifiDevices.length, 1);
});

test('a reading started before a confirmed disconnect cannot restore the ended session', async () => {
  const store = await stateFixture();
  let clock = +now, finishReading, readingStarted;
  const started = new Promise((resolve) => { readingStarted = resolve; });
  const reading = new Promise((resolve) => { finishReading = resolve; });
  const sync = await store.transaction((s) => enqueueRouterCommand(s, { action: 'sync_usage' }, () => new Date(clock)));
  const request = await store.transaction((s) => requestWifiDisconnect(s, s.vouchers[0], { mac: device.mac }, () => new Date(clock)));
  const router = {
    readUsage: async () => { readingStarted(); return reading; },
    disconnectWifiDevice: async () => ({ confirmed: true, outcome: 'disconnected' }),
  };
  const processor = createRouterCommandProcessor({ store, router, now: () => new Date(clock) });
  const pendingRead = processor.process(sync.id);
  await started;
  clock += 1000;
  await processor.process(request.body.operation.id);
  finishReading([{ voucherId: 'v1', usedBytes: 300, devices: [device] }]);
  await pendingRead;
  let state = await store.snapshot();
  assert.deepEqual(state.vouchers[0].wifiDevices, [], 'the old reading cannot revive the removed device');
  assert.equal(state.vouchers[0].usedBytes, 300, 'valid usage counters still advance');
  assert.equal(state.routerCommands.find((c) => c.id === sync.id).status, 'queued', 'a fresh reading is requested');
  clock += 1000;
  const replacement = { ...device, sessionId: '*NEW', startedAt: new Date(clock).toISOString() };
  router.readUsage = async () => [{ voucherId: 'v1', usedBytes: 300, devices: [replacement] }];
  await processor.process(sync.id);
  state = await store.snapshot();
  assert.equal(state.vouchers[0].wifiDevices[0].sessionId, '*NEW', 'a later deliberate reconnection appears normally');
});

test('legacy pending jobs cannot reach an older live bridge with an unscoped MAC', async () => {
  const store = await stateFixture();
  await store.transaction((s) => {
    s.networkSetup = { runtimeRouterEnabled: true };
    enqueueRouterCommand(s, { action: 'disconnect_device', targetId: device.mac }, () => now);
  });
  let calls = 0;
  const processor = createRouterCommandProcessor({ store, now: () => now, router: { disconnectDevice: async () => { calls++; } } });
  assert.equal((await processor.process()).deadLettered, true);
  assert.equal(calls, 0);
});

test('critical login and connection module graphs avoid unsupported syntax and runtime shortcuts', async () => {
  const require = createRequire(import.meta.url);
  const { babelParse } = require('../node_modules/playwright/lib/transform/babelBundle.js');
  const visited = new Set();
  async function check(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const ast = babelParse(await readFile(file, 'utf8'), file, true);
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      assert.ok(!['OptionalMemberExpression', 'OptionalCallExpression', 'ClassPrivateProperty', 'StaticBlock'].includes(node.type), `${file}: ${node.type}`);
      assert.ok(!(node.type === 'LogicalExpression' && node.operator === '??'), `${file}: nullish syntax`);
      if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
        const object = node.callee.object?.name, property = node.callee.property?.name;
        assert.ok(!(object === 'AbortSignal' && property === 'timeout') && !(object === 'Object' && property === 'fromEntries'), `${file}: unsupported runtime API`);
      }
      for (const [key, value] of Object.entries(node)) if (!['loc', 'comments', 'tokens'].includes(key)) {
        if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
      }
    }
    walk(ast);
    for (const item of ast.program.body) if (item.type === 'ImportDeclaration') {
      const ref = item.source.value;
      await check(ref.startsWith('/shared/') ? resolve('shared-app', ref.slice(8)) : resolve(dirname(file), ref));
    }
  }
  for (const entry of ['login.js', 'verify.js', 'hotspot.js']) await check(resolve('customer-app', entry));
  assert.ok(visited.size >= 8);
});

test('departed devices disappear only on successful router readings, without ending the bundle', async () => {
  const store = await stateFixture();
  await store.transaction((s) => enqueueRouterCommand(s, { action: 'sync_usage' }, () => now));
  const failed = createRouterCommandProcessor({ store, now: () => now, router: { readUsage: async () => { throw Error('tunnel down'); } } });
  await failed.process();
  assert.equal((await store.snapshot()).vouchers[0].wifiDevices.length, 1);
  await store.transaction((s) => { s.routerCommands[0].nextAttemptAt = now.toISOString(); });
  const success = createRouterCommandProcessor({ store, now: () => now, router: { readUsage: async () => [{ voucherId: 'v1', usedBytes: 200, devices: [] }] } });
  await success.process();
  const state = await store.snapshot();
  assert.deepEqual(state.vouchers[0].wifiDevices, []);
  assert.equal(state.vouchers[0].status, 'active');
  assert.equal(state.vouchers[0].usedBytes, 200);
});

test('existing vouchers migrate to the owned reachability profile through reconciliation', async () => {
  const store = await stateFixture();
  await createRouterReconciler({ store, now: () => now, router: { readState: async () => ({ vouchers: [{ voucherId: 'v1', enabled: true, sessionPolicyReady: false }], sessions: null }) } })();
  const state = await store.snapshot();
  assert.equal(state.vouchers[0].networkReconciliation.issue, 'session_policy_outdated');
  assert.equal(state.routerCommands[0].action, 'sync_voucher');
  assert.equal(routerSeconds('00:02:00'), 120);
  assert.equal(routerSeconds('1d2h3m4s'), 93784);
  assert.equal(routerSeconds('none'), 0);
});

test('denied session storage and missing AbortController do not break optional state or timeout handling', async (t) => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch, previousController = globalThis.AbortController;
  t.after(() => { globalThis.window = previousWindow; globalThis.fetch = previousFetch; globalThis.AbortController = previousController; });
  globalThis.window = { get sessionStorage() { throw Error('denied'); } };
  assert.equal(sessionStore.set('test-return', '/dashboard'), false);
  assert.equal(sessionStore.get('test-return'), '/dashboard');
  sessionStore.remove('test-return');
  assert.equal(sessionStore.get('test-return'), null);
  globalThis.AbortController = undefined;
  globalThis.fetch = async () => new Promise(() => {});
  await assert.rejects(requestJson('https://fixture.test', {}, 5), { name: 'TimeoutError' });
});

async function apiFixture(t) {
  const store = await stateFixture();
  await store.transaction((s) => {
    s.customers.push({ id: 'c1', phone: '670040001' }, { id: 'c2', phone: '670040002' });
    for (const id of ['c1', 'c2']) s.dashboardSessions.push({ id, customerId: id, tokenHash: hashSecret(id, 'customer-secret'), csrfToken: 'csrf', expiresAt: '2030-01-01T01:00:00Z' });
    s.adminSessions.push({ id: 'admin', tokenHash: hashSecret('admin', 'admin-secret'), role: 'operator', csrfToken: 'csrf', expiresAt: '2030-01-01T01:00:00Z' });
    s.networkSetup = { runtimeRouterEnabled: true };
  });
  const handler = createHandler({ store, now: () => now, validateConfig: false, env: { NODE_ENV: 'production', CUSTOMER_SESSION_SECRET: 'customer-secret', ADMIN_SESSION_SECRET: 'admin-secret',
    CUSTOMER_APP_URL: 'http://customer.test', ALLOWED_ADMIN_ORIGINS: 'http://admin.test', NETWORK_QUEUE_ENABLED: 'false', BILLING_WORKER_ENABLED: 'false' }, router: {} });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { user = 'c1', admin = false, csrf = 'csrf', input } = {}) => {
    const response = await fetch(base + path, { method: input ? 'POST' : 'GET', headers: {
      cookie: admin ? 'admin_session=admin' : `customer_session=${user}`,
      origin: admin ? 'http://admin.test' : 'http://customer.test', 'x-csrf-token': csrf, 'content-type': 'application/json',
    }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { call, store, handler };
}

test('customer disconnect operations enforce ownership and CSRF, remain pending after refresh, and have private status', async (t) => {
  const f = await apiFixture(t), path = '/api/account/wifi-devices/disconnect';
  assert.equal((await f.call(path, { input: { mac: device.mac }, csrf: 'wrong' })).status, 403);
  assert.equal((await f.call(path, { input: { mac: device.mac }, user: 'c2' })).status, 404);
  const requested = await f.call(path, { input: { mac: device.mac, sessionId: device.sessionId } });
  assert.equal(requested.status, 202);
  const list = await f.call('/api/account/wifi-devices');
  assert.equal(list.body.devices.length, 1);
  assert.equal(list.body.devices[0].disconnect.status, 'disconnecting');
  const statusPath = '/api/account/wifi-devices/operations/' + encodeURIComponent(requested.body.operation.id);
  assert.equal((await f.call(statusPath)).status, 200);
  assert.equal((await f.call(statusPath, { user: 'c2' })).status, 404);
});

test('operators use the same trusted router mapping and stale lists cannot claim a free slot', async (t) => {
  const f = await apiFixture(t);
  const request = await f.call('/api/admin/wifi-devices/disconnect', { admin: true, input: { voucherId: 'v1', mac: device.mac, sessionId: device.sessionId } });
  assert.equal(request.status, 202);
  assert.equal(request.body.devices.length, 1);
  const records = await f.call('/api/admin/records?collection=wifiDevices', { admin: true });
  assert.equal(records.status, 200);
  assert.equal(records.body.items[0].disconnect.status, 'disconnecting');
  await f.store.transaction((s) => { s.vouchers[0].wifiDevicesAt = '2030-01-01T00:00:00Z'; });
  assert.equal((await f.call('/api/account/wifi-devices/disconnect', { input: { mac: device.mac } })).status, 409);
});
