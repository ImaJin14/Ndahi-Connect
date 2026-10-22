import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingFixture, guestMac } from './helpers/wifi-pairing-fixture.mjs';
import { approveDevice, deviceRevocation } from '../lib/wifi-approval.mjs';
import { observeSecondaryApprovals, approvalGeneration } from '../lib/secondary-approval-expiry.mjs';
import { createRouterCommandProcessor, enqueueRouterCommand } from '../lib/router-queue.mjs';
import { createUsageSyncScheduler } from '../lib/router-reconciliation.mjs';
import { notificationItems } from '../lib/notifications.mjs';

const bootAt = '2029-12-01T00:00:00Z';
async function fixture(t, options = {}) {
  const f = await pairingFixture(options); t.after(f.close);
  await f.store.transaction(s => approveDevice(s, 'c1', { mac: guestMac, name: 'Original phone' }, f.now(), 'test'));
  const processStartedAt = f.now();
  const rows = (devices = [], evidence = {}) => [{ voucherId: 'v1', devices, observation: { startedAt: f.now().toISOString(), completedAt: f.now().toISOString(), bootAt, ...evidence } }];
  const observe = (readings = rows(), extra = {}) => f.store.transaction(s => observeSecondaryApprovals(s, readings, f.now(), { processStartedAt, readStartedAt: f.now(), ...extra }));
  const grant = async () => (await f.store.snapshot()).wifiDeviceGrants[0];
  const age = async minutes => { await observe(); for (let i = 0; i < minutes; i++) { f.advance(60); await observe(); } };
  const sync = async (processor = f.handler.routerProcessor) => { await f.store.transaction(s => enqueueRouterCommand(s, { action: 'sync_usage' }, f.now)); return processor.process('router:sync_usage:global'); };
  return { ...f, rows, observe, grant, age, sync };
}

test('missing, stale, future and cross-boot evidence freeze duration without interfering with accounting', async t => {
  const f = await fixture(t); await f.age(10);
  for (const evidence of [undefined, { completedAt: '2020-01-01', startedAt: '2020-01-01', bootAt }, { completedAt: '2040-01-01', startedAt: '2040-01-01', bootAt }]) {
    f.advance(20); const rows = f.rows(); rows[0].observation = evidence;
    await f.observe(rows); f.advance(20); await f.observe();
    assert.equal((await f.grant()).secondaryOffline.durationMs, 600000);
  }
  f.advance(20); await f.observe(f.rows([], { bootAt: f.now().toISOString() }));
  assert.equal((await f.grant()).secondaryOffline.durationMs, 600000);
});

test('a router reboot between two short polls establishes a baseline instead of backdating absence', async t => {
  const f = await fixture(t); await f.age(29);
  f.advance(60); const newBoot = f.now().toISOString(); await f.observe(f.rows([], { bootAt: newBoot }));
  assert.equal((await f.grant()).status, 'approved');
  assert.equal((await f.grant()).secondaryOffline.durationMs, 29 * 60000);
  f.advance(60); await f.observe(f.rows([], { bootAt: newBoot }));
  assert.equal((await f.grant()).status, 'revoked');
});

test('an older present or missing response cannot erase newer absence evidence', async t => {
  const f = await fixture(t); await f.age(10);
  const started = f.now(); f.advance(60); await f.observe();
  const before = await f.grant();
  await f.observe(f.rows([{ mac: guestMac }]), { readStartedAt: started });
  await f.observe([], { readStartedAt: started });
  assert.deepEqual((await f.grant()).secondaryOffline, before.secondaryOffline);
});

test('same-tick reconnects fence an already running absence reading by a durable revision', async t => {
  const f = await fixture(t); await f.age(29);
  const g = await f.grant(), expectedGrants = [{ id: g.id, generation: approvalGeneration(g), revision: g.observationRevision }];
  await f.store.transaction(s => approveDevice(s, 'c1', { mac: guestMac }, f.now(), 'reconnect'));
  f.advance(60); await f.observe(f.rows(), { expectedGrants });
  assert.equal((await f.grant()).secondaryOffline, undefined);
  assert.equal((await f.grant()).status, 'approved');
});

test('API context rollout defaults off, requires exact true, and requests evidence only when enabled', async t => {
  for (const flag of [undefined, 'false', 'TRUE', 'true']) {
    let options;
    const f = await fixture(t, { env: { WIFI_SECONDARY_EXPIRY_ENABLED: flag }, router: { async readUsage(input) { options = input; return [{ voucherId: 'v1', usedBytes: 333, devices: [] }]; } } });
    assert.equal((await f.call('/api/account/wifi-devices')).body.secondaryApprovalExpiryMinutes, flag === 'true' ? 30 : null);
    await f.age(29); f.advance(60); await f.sync();
    assert.equal((await f.grant()).status, 'approved'); // Old bridge has no boot evidence.
    assert.equal((await f.grant()).secondaryOffline.observedAt, null);
    assert.equal((await f.store.snapshot()).vouchers[0].usedBytes, 333);
    assert.deepEqual(options, flag === 'true' ? { secondaryApprovalExpiry: true } : undefined);
    await f.store.transaction(s => s.vouchers[0].status = 'expired');
    const scheduler = createUsageSyncScheduler({ store: f.store, now: f.now, env: { WIFI_SECONDARY_EXPIRY_ENABLED: flag } });
    assert.equal((await scheduler()).queued, flag === 'true');
  }
});

test('pending, confirmed and failed cleanup update one notification without changing its historical name', async t => {
  const f = await fixture(t); await f.age(30);
  const notices = async () => notificationItems(await f.store.snapshot(), { type: 'customer', id: 'c1' }, f.now()).filter(n => n.id.startsWith('approval-expiry:'));
  let n = (await notices())[0]; assert.match(n.body, /pending confirmation/); const id = n.id;
  await f.store.transaction(s => { const g = s.wifiDeviceGrants[0]; g.name = 'Renamed later'; const job = s.routerCommands.find(c => c.id === g.revocationCommandId); job.status = 'dead_letter'; job.deadLetteredAt = f.now().toISOString(); });
  n = (await notices())[0]; assert.equal(n.id, id); assert.equal(n.actionRequired, true); assert.match(n.body, /Original phone.*failed/); assert.doesNotMatch(n.body, /Renamed later/);
  await f.store.transaction(s => s.wifiDeviceGrants[0].expiries[0].routerConfirmedAt = f.now().toISOString());
  n = (await notices())[0]; assert.equal(n.id, id); assert.equal(n.actionRequired, false); assert.match(n.body, /cleanup is confirmed/);
  assert.equal((await notices()).length, 1);
});

test('expiry targets remain bound to the old grant even if a new bundle or reused MAC appears', async t => {
  let target;
  const f = await fixture(t, { router: { async revokeWifiDevice(input) { target = input; return { confirmed: true, outcome: 'revoked' }; } } });
  await f.age(30); const g = await f.grant();
  await f.store.transaction(s => { s.vouchers.push({ ...s.vouchers[0], id: 'new-bundle', code: 'NC-BBBB-2222' }); s.vouchers.push({ ...s.vouchers[0], id: 'other-customer', customerId: 'c2', code: 'NC-CCCC-3333', wifiDevices: [{ mac: guestMac }] }); });
  await f.handler.routerProcessor.process(g.revocationCommandId);
  assert.deepEqual(target.targets, [{ voucherId: 'v1', username: 'NC-AAAA-1111' }]);
  assert.equal((await f.store.snapshot()).vouchers.find(v => v.id === 'other-customer').wifiDevices.length, 1);
});

test('a delayed cleanup keeps reapproval blocked, and a late completion cannot erase a newer generation', async t => {
  let release, started;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { started = r; });
  const f = await fixture(t, { router: { async revokeWifiDevice() { started(); await gate; return { confirmed: true, outcome: 'revoked' }; } } });
  await f.age(30); const g = await f.grant(), running = f.handler.routerProcessor.process(g.revocationCommandId);
  await ready;
  try {
    await f.store.transaction(s => { assert.ok(deviceRevocation(s, 'c1', guestMac)); approveDevice(s, 'c1', { mac: guestMac }, f.now(), 'blocked'); });
    assert.equal((await f.grant()).status, 'revoked');
    // Model a migrated/imported replacement while the external worker is paused.
    await f.store.transaction(s => { Object.assign(s.wifiDeviceGrants[0], { status: 'approved', generation: 'new-generation' }); s.vouchers[0].wifiDevices.push({ mac: guestMac, sessionId: '*new' }); });
  } finally { release(); }
  await running;
  assert.equal((await f.grant()).revocationConfirmedAt, undefined);
  assert.ok((await f.store.snapshot()).vouchers[0].wifiDevices.some(d => d.sessionId === '*new'));
});
