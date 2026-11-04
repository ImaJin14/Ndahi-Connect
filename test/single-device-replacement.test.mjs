import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, guestMac, mainMac } from "./helpers/wifi-pairing-fixture.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";
const root = "/api/account/device-management/connect";
const input = (key = "a", mac = guestMac) => ({ key: key.repeat(32), mac, address: mac === guestMac ? "10.20.0.30" : "10.20.0.40" });
async function fixture(t, options = {}) {
  const disconnected = [], f = await pairingFixture({ router: { async disconnectWifiDevice(d) { disconnected.push(d); return { confirmed: true, outcome: "disconnected" }; }, ...options.router } }); t.after(f.close);
  await f.store.transaction(s => { s.vouchers[0].deviceLimit = 1; s.vouchers[0].wifiDevices.length = 1; s.customers[0].wifiFirstConnectedAt = f.now().toISOString(); });
  const occupied = (await f.call(root, input())).body.replacement;
  assert.equal(occupied.name, "imajin");
  const replace = (extra = {}) => f.call(root, { ...input(), replace: true, replacement: occupied, pin: "2468", ...extra });
  return { ...f, disconnected, occupied, replace };
}
test("switching requires explicit exact-session consent and fresh owner proof, including a saved replacement device", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => { approveDevice(s, "c1", { mac: guestMac, voucherId: "v1" }, f.now(), "main_approval"); });
  assert.equal((await f.call(root, input())).body.code, "SINGLE_DEVICE_SLOT_OCCUPIED");
  assert.equal((await f.replace({ replacement: { ...f.occupied, sessionId: "wrong" } })).body.code, "SINGLE_DEVICE_SLOT_OCCUPIED");
  assert.equal((await f.replace({ pin: undefined })).status, 401);
  assert.equal(f.disconnected.length, 0); assert.equal(f.calls.length, 0);
});
test("replacement reserves one slot, waits for confirmed removal and preserves paid allowance", async t => {
  const f = await fixture(t), before = (await f.store.snapshot()).vouchers[0], started = await f.replace();
  assert.equal(started.status, 202); assert.equal(started.body.request.connectionPhase, "disconnecting");
  const state = await f.store.snapshot(), p = state.wifiPairingRequests[0];
  assert.equal((await f.process(p.commandId)).deferred, true); assert.equal(f.calls.length, 0);
  assert.equal((await f.replace()).body.request.id, p.id, "lost response resumes the committed switch");
  assert.equal((await f.replace({ ...input("b", "AA:BB:CC:DD:EE:04") })).body.code, "CONNECTION_IN_PROGRESS");
  assert.equal((await f.store.snapshot()).vouchers[0].wifiDevices.length, 1, "slot stays occupied until router confirmation");
  await f.process(p.disconnectCommandId); f.advance(1); await f.process(p.commandId);
  const final = await f.store.snapshot(), v = final.vouchers[0];
  assert.equal(final.wifiPairingRequests[0].status, "connected");
  assert.deepEqual(v.wifiDevices.map(d => d.mac), [guestMac]);
  assert.equal(f.disconnected.length, 1); assert.equal(f.calls.length, 1);
  for (const field of ["quotaBytes", "usedBytes", "expiresAt", "activatedAt", "deviceLimit", "code"]) assert.equal(v[field], before[field]);
  assert.deepEqual(final.customers[0].wifiMainDevice, state.customers[0].wifiMainDevice, "registration remains dormant");
});
for (const result of [null, { confirmed: false }, { confirmed: true, outcome: "superseded" }]) test("unconfirmed or superseded disconnect never admits a replacement: " + JSON.stringify(result), async t => {
  const f = await fixture(t, { router: { async disconnectWifiDevice() { return result; } } });
  assert.equal((await f.replace()).status, 202); const p = (await f.store.snapshot()).wifiPairingRequests[0];
  await f.process(p.disconnectCommandId); await f.process(p.commandId);
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.store.snapshot()).vouchers[0].wifiDevices.map(d => d.mac), [mainMac]);
});
for (const change of ["pin", "session", "expiry", "quota", "router", "newer-session", "upgrade"]) test(`delayed switch rechecks ${change} before disconnecting`, async t => {
  const f = await fixture(t); await f.replace(); const p = (await f.store.snapshot()).wifiPairingRequests[0];
  await f.store.transaction(s => {
    if (change === "pin") s.customers[0].pinHash = "changed";
    if (change === "session") s.dashboardSessions = [];
    if (change === "expiry") s.vouchers[0].expiresAt = f.now().toISOString();
    if (change === "quota") s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes;
    if (change === "router") s.networkSetup.connections.router.revision = "router-2";
    if (change === "newer-session") s.vouchers[0].wifiDevices[0].sessionId = "new-session";
    if (change === "upgrade") s.vouchers[0].deviceLimit = 2;
  });
  await f.process(p.disconnectCommandId); await f.process(p.commandId);
  assert.equal(f.disconnected.length, 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.store.snapshot()).vouchers[0].wifiDevices.length, 1);
});
test("single downgrade dormancy preserves registration and valid multi-device upgrade restores its controller", async t => {
  const f = await fixture(t), registration = (await f.store.snapshot()).customers[0].wifiMainDevice;
  let info = (await f.call("/api/account/device-management")).body;
  assert.equal(info.isMainController, false); assert.equal(info.mainDevice, null);
  const current = await f.call("/api/account/wifi-devices");
  assert.equal(current.body.devices[0].main, undefined);
  await f.store.transaction(s => { s.vouchers[0].deviceLimit = 2; });
  info = (await f.call("/api/account/device-management")).body;
  assert.equal(info.isMainController, true); assert.equal(info.setupRequired, false);
  assert.deepEqual((await f.store.snapshot()).customers[0].wifiMainDevice, registration);
  await f.store.transaction(s => { s.customers[0].pinHash = "changed"; });
  info = (await f.call("/api/account/device-management")).body;
  assert.equal(info.isMainController, false); assert.equal(info.setupRequired, true);
});
test("a saved reconnect cannot bypass a newly occupied single slot when its worker executes", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => { s.vouchers[0].wifiDevices = []; approveDevice(s, "c1", { mac: guestMac, voucherId: "v1" }, f.now(), "bootstrap"); });
  const created = await f.call(root, input()); assert.equal(created.status, 202);
  await f.store.transaction(s => { s.vouchers[0].wifiDevices = [{ mac: mainMac, sessionId: "other", startedAt: f.now().toISOString() }]; });
  await f.process(); assert.equal(f.calls.length, 0);
});

test("a queued single reconnect requires a fresh router reading at execution", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => { s.vouchers[0].wifiDevices = []; approveDevice(s, "c1", { mac: guestMac, voucherId: "v1" }, f.now(), "bootstrap"); });
  assert.equal((await f.call(root, input())).status, 202);
  f.advance(121); await f.process();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.snapshot()).wifiPairingRequests[0].status, "failed");
});
