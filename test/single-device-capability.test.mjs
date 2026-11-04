import test from "node:test";
import assert from "node:assert/strict";
import { deviceCapabilities } from "../lib/device-capabilities.mjs";
import { pairingFixture, ownerRoot, publicRoot, guestMac } from "./helpers/wifi-pairing-fixture.mjs";
import { connectAuthorization } from "../lib/wifi-pairing.mjs";

const connectRoot = "/api/account/device-management/connect";
const input = () => ({ mac: guestMac, address: "10.20.0.30", key: "a".repeat(32) });
async function fixture(t, { fresh = false, limit = 1 } = {}) {
  const f = await pairingFixture(); t.after(f.close);
  await f.store.transaction(s => {
    s.vouchers[0].deviceLimit = limit; s.vouchers[0].wifiDevices = [];
    if (fresh) delete s.customers[0].wifiMainDevice;
    else s.customers[0].wifiFirstConnectedAt = f.now().toISOString();
  });
  return f;
}
for (const limit of [1, 2, 4]) test(`capability follows issued limit ${limit} independently of plan name and online count`, async t => {
  const f = await fixture(t, { fresh: true, limit });
  await f.store.transaction(s => { s.vouchers[0].planId = "custom-plan"; });
  const info = await f.call("/api/account/device-management");
  assert.equal(info.body.deviceCapabilities.deviceLimit, limit);
  assert.equal(info.body.deviceCapabilities.mainDeviceSupported, limit > 1);
  assert.equal(info.body.setupRequired, limit > 1);
  const state = await f.store.snapshot();
  state.vouchers[0].wifiDevices = Array.from({ length: 7 }, () => ({}));
  assert.equal(deviceCapabilities(state, "c1", f.now()).mainDeviceSupported, limit > 1);
});
for (const unavailable of ["expired", "exhausted", "suspended", "missing"]) test(`no main-device setup for ${unavailable} entitlement`, async t => {
  const f = await fixture(t, { fresh: true, limit: 3 });
  await f.store.transaction(s => {
    if (unavailable === "expired") s.vouchers[0].expiresAt = f.now().toISOString();
    if (unavailable === "exhausted") s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes;
    if (unavailable === "suspended") s.customers[0].suspended = true;
    if (unavailable === "missing") s.vouchers = [];
  });
  assert.equal(deviceCapabilities(await f.store.snapshot(), "c1", f.now()).connectionMode, "unavailable");
  if (unavailable !== "suspended") assert.equal((await f.call("/api/account/device-management")).body.setupRequired, false);
});
test("single-device first connection is authenticated, router-verified and never asks for a main device", async t => {
  const f = await fixture(t, { fresh: true });
  assert.equal((await f.call(connectRoot, input(), { session: "" })).status, 401);
  assert.equal((await f.call(connectRoot, input(), { address: "198.51.100.9" })).status, 403);
  const result = await f.call(connectRoot, input());
  assert.equal(result.status, 202);
  assert.equal(result.body.request.mainRequired, false);
  assert.equal(result.body.request.firstDevice, undefined);
  await f.handler.routerProcessor.run();
  const state = await f.store.snapshot();
  assert.equal(state.wifiPairingRequests[0].status, "connected");
  assert.equal(state.customers[0].wifiMainDevice, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].deviceLimit, 1);
  assert.equal(f.calls[0].approvalRequired, true, "private router access policy stays enabled");
  const status = await f.call(publicRoot + "/status", { id: result.body.request.id, key: input().key });
  assert.equal(status.body.request.completionReady, true);
  assert.equal(status.body.request.mainRequired, false);
});
test("returning single owner verifies a new device without recovering or destroying main registration", async t => {
  const f = await fixture(t), before = (await f.store.snapshot()).customers[0].wifiMainDevice;
  assert.equal((await f.call(connectRoot, input())).body.code, "OWNER_VERIFICATION_REQUIRED");
  const verified = await f.call(connectRoot, { ...input(), recover: true, pin: "2468" });
  assert.equal(verified.status, 202);
  assert.equal(verified.body.request.mainRequired, false);
  await f.handler.routerProcessor.run();
  assert.deepEqual((await f.store.snapshot()).customers[0].wifiMainDevice, before);
});
test("single-device main setup, manual approvals and old public/signed-in request paths cannot grant access", async t => {
  const f = await fixture(t);
  for (const suffix of ["main", "main/options"]) {
    const denied = await f.call("/api/account/device-management/" + suffix, { mac: guestMac, pin: "2468" });
    assert.equal(denied.status, 409); assert.equal(denied.body.code, "MAIN_DEVICE_UNSUPPORTED");
  }
  assert.equal((await f.call(ownerRoot + "/manual", { ...input(), confirm: true })).status, 403);
  assert.equal((await f.call(ownerRoot + "/request", input())).body.code, "SINGLE_DEVICE_OWNER_CONNECT");
  assert.equal((await f.request()).body.code, "OWNER_SIGN_IN_REQUIRED");
  const info = (await f.call("/api/account/device-management")).body;
  assert.equal(info.mainDevice, null); assert.equal(info.isMainController, false); assert.equal(info.setupRequired, false);
  assert.equal(f.calls.length, 0);
});
test("queued main approval cannot execute after allowance becomes single-device", async t => {
  const f = await fixture(t, { limit: 3 });
  const created = await f.request({ protocol: 3 });
  await f.store.transaction(s => {
    const p = s.wifiPairingRequests[0]; p.kind = "manual"; p.status = "connecting"; p.commandId = "queued"; p.approvedBy = s.customers[0].wifiMainDevice.controllerHash;
    s.vouchers[0].deviceLimit = 1;
  });
  const state = await f.store.snapshot();
  assert.equal(connectAuthorization(state, { id: "queued", targetId: created.body.request.id }, f.now(), "pairing-tests").code, "PAIRING_REVOKED");
});
