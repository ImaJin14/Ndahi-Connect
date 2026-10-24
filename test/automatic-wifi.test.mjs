import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticPoll } from '../customer-app/automatic-poll.js';
import { requestJson } from '../customer-app/compat.js';
import { pairingFixture, mainMac } from './helpers/wifi-pairing-fixture.mjs';

function timers() {
  let next = 0; const tasks = new Map();
  return { tasks, setTimer(fn, ms) { tasks.set(++next, { fn, ms }); return next; }, clearTimer(id) { tasks.delete(id); },
    async fire() { const [id, task] = tasks.entries().next().value; tasks.delete(id); await task.fn(); } };
}
test('poll pauses hidden/offline views, coalesces resume, fences late replies and never overlaps', async () => {
  const time = timers(); let visible = true, release, calls = 0, applied = 0, signal;
  const poll = automaticPoll({ ...time, active: () => visible, delay: () => 10000,
    run: async context => { calls++; signal = context.signal; await new Promise(r => { release = r; }); if (context.current()) applied++; } });
  poll.start(); assert.equal(time.tasks.size, 1); const first = time.fire();
  poll.wake(); poll.wake(); assert.equal(calls, 1); assert.equal(signal.aborted, true);
  visible = false; poll.wake(); release(); await first;
  assert.equal(applied, 0); assert.equal(time.tasks.size, 0);
  visible = true; poll.wake(); poll.wake(); assert.equal(time.tasks.size, 1);
  const second = time.fire(); assert.equal(calls, 2); release(); await second;
  assert.equal(applied, 1); assert.equal([...time.tasks.values()][0].ms, 10000);
  poll.stop(); assert.equal(time.tasks.size, 0); poll.wake(); assert.equal(time.tasks.size, 0);
});
test('poll respects adaptive failure delay and stops pending work without applying it', async () => {
  const time = timers(); let failures = 0, applied = 0;
  const poll = automaticPoll({ ...time, active: () => true, delay: () => Math.min(60000, 10000 * 2 ** failures), run: async ({ current }) => { failures++; if (current()) applied++; } });
  poll.start(); await time.fire(); assert.equal([...time.tasks.values()][0].ms, 20000);
  await time.fire(); assert.equal([...time.tasks.values()][0].ms, 40000);
  await time.fire(); assert.equal([...time.tasks.values()][0].ms, 60000);
  poll.stop(); assert.equal(applied, 3); assert.equal(time.tasks.size, 0);
});
test('caller cancellation aborts fetch and response body reads without waiting for the timeout', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let received;
  globalThis.fetch = async (_, options) => { received = options.signal; return { json: () => new Promise(() => {}) }; };
  const controller = new AbortController(), pending = requestJson('https://example.test', { signal: controller.signal }, 60000);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(received.aborted, true);
});
test('current device API shares trusted network evidence without authorizing a separate browser', async t => {
  const f = await pairingFixture({ now: new Date(), liveClock: true }); t.after(f.close);
  const identified = await f.call('/api/account/device-management/current/identify', { mac: mainMac, address: '10.20.0.1' });
  assert.equal(identified.body.state, 'connected'); assert.equal(identified.body.connectivity.hotspot.state, 'authenticated');
  const outside = await f.call('/api/account/device-management/current', undefined, { address: '198.51.100.10' });
  assert.equal(outside.body.state, 'unknown'); assert.equal(outside.body.connectivity.network.state, 'unconfirmed'); assert.equal(outside.body.connectivity.hotspot.state, 'unknown');
  const other = await f.call('/api/account/device-management/current', undefined, { session: 'secondary' });
  assert.equal(other.body.state, 'unknown'); assert.equal(other.body.connectivity.hotspot.state, 'unknown');
});

test('legacy suspended accounts cannot read or identify an active router session', async t => {
  const f = await pairingFixture({ now: new Date(), liveClock: true }); t.after(f.close);
  await f.call('/api/account/device-management/current/identify', { mac: mainMac, address: '10.20.0.1' });
  await f.store.transaction(s => { s.customers[0].suspended = true; });
  assert.equal((await f.call('/api/account/device-management/current')).status, 403);
  assert.equal((await f.call('/api/account/device-management/current/identify', { mac: mainMac, address: '10.20.0.1' })).status, 403);
  const evidence = await f.call('/api/account/connectivity');
  assert.equal(evidence.body.account.state, 'signed-out'); assert.equal(evidence.body.hotspot.state, 'unknown');
});
