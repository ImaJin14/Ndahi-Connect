import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, guestMac, mainMac } from "./helpers/wifi-pairing-fixture.mjs";
import { approveDevice, deviceGrant } from "../lib/wifi-approval.mjs";
import { requestWifiDisconnect } from "../lib/wifi-devices.mjs";

const root = "/api/account/device-management/current";
async function fixture(t, options) {
  const f = await pairingFixture(options); t.after(f.close);
  await f.store.transaction((s) => {
    approveDevice(s, "c1", { mac: guestMac }, f.now(), "test");
    s.vouchers[0].wifiDevices.push({ mac: guestMac, address: "10.20.0.30", sessionId: "*guest", startedAt: f.now().toISOString() });
  });
  const identify = () => f.call(root + "/identify", { mac: guestMac, address: "10.20.0.30" });
  const status = () => f.call(root);
  return { ...f, identify, status };
}

test("an owner connection reports Connecting then binds only its own browser after router confirmation", async (t) => {
  const f = await fixture(t);
  const response = await f.call("/api/account/device-management/connect", { key: "f".repeat(32), mac: guestMac, address: "10.20.0.30" });
  assert.equal(response.status, 202);
  assert.equal((await f.status()).body.state, "connecting");
  await f.process((await f.store.snapshot()).wifiPairingRequests.find((p) => p.id === response.body.request.id).commandId);
  assert.equal((await f.status()).body.state, "connected");
  assert.equal((await f.call(root, undefined, { session: "secondary" })).body.state, "unknown");
});

test("a current device needs a router-verified browser association, fresh exact session and account isolation", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.status()).body.state, "unknown");
  const identified = await f.identify();
  assert.equal(identified.body.state, "connected");
  assert.equal(identified.body.device.mac, guestMac);
  assert.equal((await f.call(root, undefined, { session: "secondary" })).body.state, "unknown");
  assert.equal((await f.call(root, undefined, { session: "other" })).body.state, "unavailable");
  assert.equal((await f.call(root + "/identify", { mac: guestMac, address: "10.20.0.30" }, { csrf: "wrong" })).status, 403);
  f.advance(121); assert.equal((await f.status()).body.state, "stale");
});

test("missing or changed router identity and off-network visits cannot claim Connected", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call(root + "/identify", { mac: guestMac })).body.state, "unknown");
  await f.identify();
  assert.equal((await f.call(root, undefined, { address: "198.51.100.7" })).body.state, "unknown");
  await f.store.transaction((s) => { s.vouchers[0].wifiDevices.find((d) => d.mac === guestMac).address = "10.20.0.31"; });
  assert.equal((await f.status()).body.state, "unknown");
  await f.store.transaction((s) => { s.networkSetup.connections.router.revision = "router-2"; });
  assert.equal((await f.status()).body.state, "unknown");
});

test("a lying or unavailable router cannot bind another session as this browser", async (t) => {
  for (const readGuestDevice of [async () => { throw Error("offline"); }, async () => ({ mac: mainMac, address: "10.20.0.30", hostId: "*host", server: "ndahi-hotspot" })]) {
    const f = await fixture(t, { router: { readGuestDevice } });
    assert.notEqual((await f.identify()).body.state, "connected");
    assert.equal((await f.status()).body.state, "unknown");
  }
});

test("failed re-identification invalidates the old association instead of reviving Connected on the next poll", async (t) => {
  let online = true;
  const f = await fixture(t, { router: { async readGuestDevice(input) {
    if (!online) throw Error("unavailable");
    return { ...input, loginAddress: input.address, hostId: "*guest", server: "ndahi-hotspot" };
  } } });
  assert.equal((await f.identify()).body.state, "connected");
  online = false; f.advance(6);
  assert.equal((await f.identify()).body.state, "unknown");
  assert.equal((await f.status()).body.state, "unknown");
});

test("signing out while router identification is in flight cannot bind the expired session", async (t) => {
  let release, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { router: { async readGuestDevice(input) { started(); await gate; return { ...input, loginAddress: input.address, hostId: "*guest", server: "ndahi-hotspot" }; } } });
  const pending = f.identify(); await waiting;
  await f.store.transaction((s) => { s.dashboardSessions = s.dashboardSessions.filter((a) => a.id !== "main"); });
  release();
  assert.equal((await pending).status, 401);
  assert.equal((await f.store.snapshot()).dashboardSessions.some((a) => a.currentWifi), false);
});

test("session-only disconnect retains approval, waits for confirmation and cannot reconnect in the background", async (t) => {
  const f = await fixture(t, { router: { async disconnectWifiDevice() { return { confirmed: true, outcome: "disconnected" }; } } });
  await f.identify();
  const target = (await f.status()).body.device;
  const response = await f.call("/api/account/wifi-devices/disconnect", { ...target, retainApproval: true });
  assert.equal(response.status, 202);
  assert.equal((await f.status()).body.state, "disconnecting");
  let s = await f.store.snapshot();
  assert.equal(s.routerCommands.find((c) => c.id === response.body.operation.id).kind, "wifi_session_disconnect", "old workers must not revoke a retaining job");
  assert.ok(deviceGrant(s, "c1", guestMac));
  assert.ok(s.vouchers[0].wifiDevices.some((d) => d.mac === guestMac), "slot is retained before confirmation");
  assert.equal((await f.request({ key: "d".repeat(32) })).status, 409, "explicit reconnect must wait for disconnect confirmation");
  await f.handler.routerProcessor.process(response.body.operation.id);
  assert.equal((await f.status()).body.state, "disconnected");
  s = await f.store.snapshot();
  assert.ok(deviceGrant(s, "c1", guestMac));
  assert.equal(s.vouchers[0].wifiDevices.some((d) => d.mac === guestMac), false);
  await f.status(); await f.status();
  assert.equal(f.calls.length, 0, "read/refresh must not issue a login");
  const reconnect = await f.request({ key: "c".repeat(32) });
  assert.equal(reconnect.status, 202, "explicit reconnect still uses the saved grant");
});

test("main-device session disconnect preserves its designation and requires existing owner proof", async (t) => {
  const f = await fixture(t, { router: { async disconnectWifiDevice() { return { confirmed: true, outcome: "disconnected" }; } } });
  const before = (await f.store.snapshot()).customers[0].wifiMainDevice;
  const target = (await f.store.snapshot()).vouchers[0].wifiDevices[0];
  assert.equal((await f.call("/api/account/wifi-devices/disconnect", { ...target, retainApproval: true })).status, 403);
  const reply = await f.call("/api/account/device-management/disconnect", { ...target, retainApproval: true, pin: "2468" });
  assert.equal(reply.status, 202);
  await f.handler.routerProcessor.process(reply.body.operation.id);
  assert.deepEqual((await f.store.snapshot()).customers[0].wifiMainDevice, before);
});

test("an old session or a missing exact identity cannot disconnect a replacement", async (t) => {
  const f = await fixture(t), target = (await f.store.snapshot()).vouchers[0].wifiDevices.at(-1);
  assert.equal((await f.call("/api/account/wifi-devices/disconnect", { mac: guestMac, retainApproval: true })).status, 400);
  await f.store.transaction((s) => { s.vouchers[0].wifiDevices.at(-1).sessionId = "*replacement"; });
  assert.equal((await f.call("/api/account/wifi-devices/disconnect", { ...target, retainApproval: true })).status, 404);
  assert.equal((await f.store.snapshot()).routerCommands.some((c) => c.action === "disconnect_wifi_device"), false);
});

test("Forget and legacy revocation remain monotonic across a retaining disconnect", async (t) => {
  const f = await fixture(t, { router: { async disconnectWifiDevice() { return { confirmed: true, outcome: "disconnected" }; } } });
  const target = (await f.store.snapshot()).vouchers[0].wifiDevices.at(-1);
  const response = await f.call("/api/account/wifi-devices/disconnect", { ...target, retainApproval: true });
  await f.store.transaction((s) => { s.wifiDeviceGrants.find((g) => g.mac === guestMac).status = "revoked"; });
  await f.handler.routerProcessor.process(response.body.operation.id);
  assert.equal(deviceGrant(await f.store.snapshot(), "c1", guestMac), undefined);
  const g = await fixture(t);
  await g.store.transaction((s) => { assert.equal(requestWifiDisconnect(s, s.vouchers[0], target, g.now).status, 202); });
  assert.equal(deviceGrant(await g.store.snapshot(), "c1", guestMac), undefined);
});

test("an explicit session disconnect cancels queued connects but waits for an in-flight connection", async (t) => {
  for (const processing of [false, true]) {
    const f = await fixture(t), target = (await f.store.snapshot()).vouchers[0].wifiDevices.at(-1);
    const request = await f.request(); assert.equal(request.status, 202);
    if (processing) await f.store.transaction((s) => { s.routerCommands.find((c) => c.id === request.body.request.id || c.action === "connect_wifi_device").status = "processing"; });
    const response = await f.call("/api/account/wifi-devices/disconnect", { ...target, retainApproval: true });
    assert.equal(response.status, processing ? 409 : 202);
    const s = await f.store.snapshot();
    assert.ok(deviceGrant(s, "c1", guestMac));
    assert.equal(s.wifiPairingRequests[0].status, processing ? "connecting" : "cancelled");
    assert.equal(f.calls.length, 0);
  }
});
