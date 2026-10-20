import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, publicRoot, ownerRoot, guestMac, mainMac } from "./helpers/wifi-pairing-fixture.mjs";
import { pairingCode } from "../lib/wifi-pairing.mjs";
import { hashSecret } from "../lib/security.mjs";
import { requestWifiDisconnect } from "../lib/wifi-devices.mjs";
import { approveDevice, privateWifiPassword } from "../lib/wifi-approval.mjs";
import { RouterHotspot } from "../lib/router-hotspot.mjs";
import { randomUUID } from "node:crypto";

async function fixture(t, options) { const f = await pairingFixture(options); t.after(f.close); return f; }
const owner = "/api/account/device-management/connect";
const target = (key = "d".repeat(32), mac = guestMac) => ({ key, mac, address: "10.20.0.30" });
const redeem = (f, request, code, key = request.requestKey) => f.call(publicRoot + "/redeem", { id: request.body.request.id, key, approvalCode: code }, { session: "", controller: "" });

test("only the main browser receives a request-bound approval code; the guest redeems it once", async (t) => {
  const f = await fixture(t), request = await f.request();
  assert.equal(request.status, 201); assert.equal(request.body.code, undefined);
  assert.equal((await f.call(publicRoot + "/redeem", { id: request.body.request.id, key: request.requestKey, approvalCode: "123456" })).status, 409);
  const issued = await f.call(ownerRoot + "/approve", { id: request.body.request.id });
  assert.equal(issued.status, 200); assert.match(issued.body.approvalCode, /^\d{6}$/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call(publicRoot + "/status", { id: request.body.request.id, key: request.requestKey })).body.approvalCode, undefined);
  const secondary = await f.call(ownerRoot, undefined, { session: "secondary", controller: "" });
  assert.equal(secondary.body.requests[0].approvalCode, undefined);
  assert.equal((await redeem(f, request, issued.body.approvalCode, "b".repeat(32))).status, 404);
  assert.equal((await redeem(f, request, issued.body.approvalCode)).status, 202);
  assert.equal((await redeem(f, request, issued.body.approvalCode)).status, 200);
  await f.process(); assert.equal(f.calls.length, 1);
  const state = await f.store.snapshot();
  assert.equal(state.wifiDeviceGrants.find((g) => g.mac === guestMac).status, "approved");
  assert.equal(state.wifiPairingRequests[0].codeHash, undefined);
  assert.equal(state.wifiPairingRequests[0].codeNonce, undefined);
  assert.equal(f.calls[0].approvalRequired, true);
});

test("approval codes cannot be exchanged between requests, cancelled, expired or transferred main browsers", async (t) => {
  const f = await fixture(t), first = await f.request(), second = await f.request({ ...target("b".repeat(32), "AA:BB:CC:DD:EE:04"), address: "10.20.0.40" });
  const code = (await f.call(ownerRoot + "/approve", { id: first.body.request.id })).body.approvalCode;
  assert.equal((await redeem(f, second, code)).status, 409);
  assert.equal((await f.call(ownerRoot + "/decline", { id: first.body.request.id })).status, 200);
  assert.equal((await redeem(f, first, code)).status, 409);
  const g = await fixture(t), r = await g.request(), issued = await g.call(ownerRoot + "/approve", { id: r.body.request.id });
  await g.store.transaction((s) => { s.customers[0].wifiMainDevice.controllerHash = "replacement"; });
  assert.equal((await redeem(g, r, issued.body.approvalCode)).status, 409);
  g.advance(301); assert.equal((await redeem(g, r, issued.body.approvalCode)).status, 409);
  await g.process(); assert.equal(g.calls.length, 0);
});

test("the first owner connection bootstraps exactly once and a second device requires approval or explicit recovery", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { delete s.customers[0].wifiMainDevice; s.vouchers[0].wifiDevices = []; });
  assert.equal((await f.call(owner, target(), { csrf: "bad" })).status, 403);
  assert.equal((await f.call(owner, target(), { session: "" })).status, 401);
  const results = await Promise.all([f.call(owner, target()), f.call(owner, { ...target("e".repeat(32), mainMac), address: "10.20.0.1" })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
  const connected = results.find((r) => r.status === 202); assert.equal(connected.body.request.firstDevice, true);
  await f.process(connected.body.request.commandId);
  const state = await f.store.snapshot();
  assert.ok(state.customers[0].wifiFirstConnectedAt); assert.equal(state.customers[0].wifiMainDevice, undefined);
  const next = await f.call(owner, { ...target("f".repeat(32), "AA:BB:CC:DD:EE:05"), address: "10.20.0.50" });
  assert.equal(next.status, 409); assert.equal(next.body.code, "DEVICE_APPROVAL_REQUIRED");
  const waiting = await f.request({ ...target("a".repeat(32), "AA:BB:CC:DD:EE:06"), address: "10.20.0.60" });
  assert.equal(waiting.status, 201); assert.equal(waiting.body.request.mainRequired, true);
  assert.equal((await f.call("/api/account/hotspot-credentials")).status, 409);
});

test("approved devices reconnect without another code and revocation blocks a queued reconnect", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { approveDevice(s, "c1", { mac: guestMac }, f.now(), "test"); });
  const r = await f.request(); assert.equal(r.status, 202);
  await f.store.transaction((s) => { s.wifiDeviceGrants[0].status = "revoked"; });
  await f.process(); assert.equal(f.calls.length, 0);
});

test("owner recovery requires fresh proof and revokes previous control before connecting a replacement", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call(owner, { ...target(), recover: true, pin: "0000" })).status, 401);
  f.advance(2);
  const recovered = await f.call(owner, { ...target(), recover: true, pin: "2468" });
  assert.equal(recovered.status, 202);
  assert.equal((await f.store.snapshot()).customers[0].wifiMainDevice.controllerHash, "");
  await f.process(); assert.equal(f.calls.length, 1);
  const c = (await f.store.snapshot()).customers[0]; assert.equal(c.wifiMainDevice.mac, mainMac);
});

test("screenless approval requires the current main controller and an explicit target confirmation", async (t) => {
  const f = await fixture(t), input = { ...target(), confirm: true };
  assert.equal((await f.call(ownerRoot + "/manual", input, { controller: "" })).status, 403);
  assert.equal((await f.call(ownerRoot + "/manual", { ...input, confirm: false })).status, 403);
  assert.equal((await f.call(ownerRoot + "/manual", input)).status, 202);
  await f.process(); assert.equal(f.calls.length, 1);
});

test("disabling new approvals never exposes public router passwords", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.networkSetup.assistedConnections.enabled = false; });
  const config = await f.call(publicRoot + "/config"); assert.equal(config.body.enabled, false); assert.equal(config.body.approvalRequired, true);
  const credentials = await f.call("/api/account/hotspot-credentials");
  assert.equal(credentials.status, 409); assert.equal(credentials.body.password, undefined);
  assert.equal((await f.request()).status, 503);
});

test("private router credentials replace the voucher password and invalidate old remembered logins", async () => {
  const key = randomUUID(), voucherCode = "NC-" + randomUUID().slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, "$1-$2"),
    router = new RouterHotspot({ approvalKey: key }), writes = [];
  const tables = { "ip/hotspot/user/profile": [{ name: "ndahi-users-3-presence-v1", "shared-users": "3", "keepalive-timeout": "2m", "idle-timeout": "none" }],
    "system/scheduler": [], "ip/hotspot/user": [{ ".id": "*user", name: voucherCode, comment: "ndahi:voucher:v1", password: voucherCode }],
    "ip/hotspot/cookie": [{ ".id": "*cookie", user: voucherCode }] };
  router.request = async (path, method = "GET", values) => {
    if (method === "GET") return structuredClone(tables[path] || []);
    writes.push({ path, method, values });
    if (path === "ip/hotspot/user/*user") Object.assign(tables["ip/hotspot/user"][0], values);
    return {};
  };
  const result = await router.syncVoucher({ id: "v1", code: voucherCode, planId: "family", status: "active", deviceLimit: 3, quotaBytes: 1000,
    expiresAt: "2030-01-01T00:00:00Z", approvalRequired: true });
  assert.equal(result.synchronized, true);
  const write = writes.find((w) => w.path === "ip/hotspot/user/*user");
  assert.equal(write.values.password, privateWifiPassword("v1", key));
  assert.notEqual(write.values.password, voucherCode);
  assert.ok(writes.some((w) => w.method === "DELETE" && w.path === "ip/hotspot/cookie/*cookie"));
  assert.equal(JSON.stringify(result).includes(write.values.password), false);
});


test("legacy simulated connection endpoints cannot bypass mandatory approval", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/vouchers/redeem", { phone: "670050001", code: "NC-AAAA-1111", deviceId: "bypass" })).status, 409);
  assert.equal((await f.call("/api/account/devices/connect", { deviceId: "bypass" })).status, 409);
  assert.equal((await f.store.snapshot()).sessions.length, 0); assert.equal(f.calls.length, 0);
});

test("device removal revokes both remembered approval and unused main-device codes", async (t) => {
  const f = await fixture(t), r = await f.request();
  const issued = await f.call(ownerRoot + "/approve", { id: r.body.request.id });
  await f.store.transaction((s) => {
    approveDevice(s, "c1", { mac: guestMac }, f.now(), "test");
    s.vouchers[0].wifiDevices.push({ mac: guestMac, sessionId: "*prior", startedAt: f.now().toISOString() });
    assert.equal(requestWifiDisconnect(s, s.vouchers[0], { mac: guestMac, sessionId: "*prior" }, f.now).status, 202);
  });
  assert.equal((await redeem(f, r, issued.body.approvalCode)).status, 409);
  assert.equal((await f.store.snapshot()).wifiDeviceGrants[0].status, "revoked");
});

test("main-issued codes remain usable during a supported pepper rotation", async (t) => {
  const f = await fixture(t, { env: { SECRET_PEPPER: "rotated-test-pepper", SECRET_PEPPER_PREVIOUS: "pairing-tests" } }), r = await f.request();
  await f.call(ownerRoot + "/approve", { id: r.body.request.id });
  let oldCode;
  await f.store.transaction((s) => {
    const p = s.wifiPairingRequests[0]; oldCode = pairingCode(p.id, p.codeNonce, "pairing-tests"); p.codeHash = hashSecret(oldCode, "pairing-tests");
  });
  const list = await f.call(ownerRoot); assert.equal(list.body.requests[0].approvalCode, oldCode);
  assert.equal((await redeem(f, r, oldCode)).status, 202);
});

test("the router connects with private credentials and a verified approval profile without exposing its stored password", async () => {
  const key = randomUUID(), now = new Date("2030-01-01T12:00:00Z"), router = new RouterHotspot({ approvalKey: key, now: () => now });
  const sessions = [], tables = {
    "ip/hotspot/host": [{ ".id": "*host", server: "ndahi-hotspot", "mac-address": guestMac, address: "10.20.0.30" }],
    "ip/dhcp-server/lease": [], "ip/hotspot/active": sessions,
    "ip/hotspot/user": [{ name: "NC-AAAA-1111", comment: "ndahi:voucher:v1", server: "ndahi-hotspot", profile: "ndahi-users-3-approval-v1", "bytes-in": "0" }],
    "ip/hotspot/user/profile": [{ name: "ndahi-users-3-approval-v1", "shared-users": "3", "keepalive-timeout": "2m", "idle-timeout": "none" }],
  };
  router.request = async (path, method, body) => {
    if (path === "ip/hotspot/active/login") {
      assert.equal(body.password, privateWifiPassword("v1", key)); assert.notEqual(body.password, body.user);
      sessions.push({ ".id": "*session", user: body.user, address: body.ip, "mac-address": body["mac-address"], server: "ndahi-hotspot", uptime: "1s" }); return {};
    }
    return tables[path];
  };
  const result = await router.connectWifiDevice({ mac: guestMac, address: "10.20.0.30", loginAddress: "10.20.0.30", hostId: "*host", voucherId: "v1", username: "NC-AAAA-1111",
    expiresAt: new Date(+now + 86400000).toISOString(), deadline: new Date(+now + 30000).toISOString(), deviceLimit: 3, quotaBytes: 1000, approvalRequired: true });
  assert.equal(result.confirmed, true);
  assert.equal((await router.readState()).vouchers[0].approvalPolicyReady, true);
  assert.equal(JSON.stringify(result).includes(privateWifiPassword("v1", key)), false);
});

test("owner first connection waits for router provisioning without claiming success or rejecting credentials", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { delete s.customers[0].wifiMainDevice; s.vouchers[0].routerSyncStatus = "pending"; });
  const reply = await f.call(owner, target());
  assert.equal(reply.status, 202); assert.equal(reply.body.code, "HOTSPOT_PENDING");
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0); assert.equal(f.calls.length, 0);
});
