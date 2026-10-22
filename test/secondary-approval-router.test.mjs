import test from 'node:test';
import assert from 'node:assert/strict';
import { RouterHotspot } from '../lib/router-hotspot.mjs';
import { guestMac } from './helpers/wifi-pairing-fixture.mjs';
const at = new Date('2030-01-01T12:00:00Z');
function router(resources = [{ uptime: '1d' }, { uptime: '1d' }]) {
  const r = new RouterHotspot({ now: () => at }), calls = [];
  r.request = async (path, method = 'GET') => {
    calls.push([path, method]);
    if (path === 'system/resource') { const next = resources.shift(); if (next instanceof Error) throw next; return next; }
    if (path === 'ip/hotspot/user') return [{ name: 'NC-AAAA-1111', comment: 'ndahi:voucher:v1', server: 'ndahi-hotspot', 'bytes-in': '4' }];
    if (path === 'ip/hotspot/active') return [];
    if (path === 'ip/dhcp-server/lease') return [];
    throw Error(path);
  };
  return { r, calls };
}

test('complete scoped readings carry router boot evidence only on the opted-in path', async () => {
  const { r, calls } = router();
  const rows = await r.readUsage({ secondaryApprovalExpiry: true });
  assert.equal(rows[0].observation.bootAt, '2029-12-31T12:00:00.000Z');
  assert.deepEqual(rows[0].devices, []);
  assert.equal(rows[0].usedBytes, 4);
  assert.equal(calls.filter(([path]) => path === 'system/resource').length, 2);
  calls.length = 0;
  const normal = await r.readUsage();
  assert.equal(normal[0].observation, undefined);
  assert.equal(calls.some(([path]) => path === 'system/resource'), false);
});

test('a reboot during a read, invalid uptime or denied permission never provides absence proof', async () => {
  for (const resources of [[{ uptime: '1d' }, { uptime: '2s' }], [Error('denied'), Error('denied')], [{}, {}]]) {
    const { r } = router(resources); const rows = await r.readUsage({ secondaryApprovalExpiry: true });
    assert.equal(rows[0].observation, undefined); assert.equal(rows[0].usedBytes, 4);
  }
});

test('bounded expiry cleanup removes only the matched voucher MAC and leaves another customer untouched', async () => {
  const r = new RouterHotspot({ now: () => at }), deleted = [], other = { '.id': '*other', user: 'NC-BBBB-2222', 'mac-address': guestMac, server: 'ndahi-hotspot' };
  let active = [{ '.id': '*old', user: 'NC-AAAA-1111', 'mac-address': guestMac, server: 'ndahi-hotspot' }, other];
  let cookies = [{ '.id': '*cookie', user: 'NC-AAAA-1111', 'mac-address': guestMac }, other];
  r.request = async (path, method) => {
    if (method === 'DELETE') { deleted.push(path); active = active.filter(r => !path.endsWith('/' + encodeURIComponent(r['.id']))); cookies = cookies.filter(r => !path.endsWith('/' + encodeURIComponent(r['.id']))); return null; }
    if (path === 'ip/hotspot/user') return [{ name: 'NC-AAAA-1111', comment: 'ndahi:voucher:v1', server: 'ndahi-hotspot' }];
    if (path === 'ip/hotspot/active') return active;
    if (path === 'ip/hotspot/cookie') return cookies;
    throw Error(path);
  };
  const input = { mac: guestMac, targets: [{ voucherId: 'v1', username: 'NC-AAAA-1111' }], deadline: new Date(+at + 10000).toISOString() };
  assert.deepEqual(await r.revokeWifiDevice(input), { confirmed: true, outcome: 'revoked' });
  assert.equal(deleted.length, 2); assert.equal(deleted.some(p => p.includes('other')), false);
  assert.deepEqual(active, [other]); assert.deepEqual(cookies, [other]);
  deleted.length = 0; input.deadline = new Date(+at - 1).toISOString();
  await assert.rejects(r.revokeWifiDevice(input), /timed out/); assert.equal(deleted.length, 0);
});
