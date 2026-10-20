import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, publicRoot, ownerRoot, guestMac } from "./helpers/wifi-pairing-fixture.mjs";
import { RouterHotspot } from "../lib/router-hotspot.mjs";
import { createNetworkSetup } from "../lib/network-setup.mjs";
import { createStore } from "../server.mjs";
import { totpSecret } from "../lib/security.mjs";

async function fixture(t, options) { const f = await pairingFixture(options); t.after(f.close); return f; }
const approve = async (f, response, options) => {
  const issued = await f.call(ownerRoot + "/approve", { id: response.body.request.id }, options);
  if (issued.body.approvalCode) response.approvalCode = issued.body.approvalCode;
  if (!response.approvalCode || (options && issued.status !== 200)) return issued;
  return f.call(publicRoot + "/redeem", { id: response.body.request.id, key: response.requestKey, approvalCode: response.approvalCode }, { session: "", controller: "" });
};
const status = (f, response, key = response.requestKey || "a".repeat(32)) => f.call(publicRoot + "/status", { id: response.body.request.id, key }, { session: "", controller: "" });

test("guest requests use a five-minute bearer code, survive lost responses, and never create an account session", async (t) => {
  const f = await fixture(t), r = await f.request();
  assert.equal(r.status, 201); assert.equal(r.body.code, undefined);
  assert.equal(r.body.request.name, "Galaxy Note 8"); assert.equal(r.body.request.macSuffix, "EE:03");
  assert.equal(Date.parse(r.body.request.expiresAt) - +f.now(), 300000);
  assert.equal(r.headers.has("set-cookie"), false);
  const again = await f.request();
  assert.equal(again.status, 200); assert.equal(again.body.code, r.body.code); assert.equal(again.body.request.id, r.body.request.id);
  assert.equal((await status(f, r)).body.code, r.body.code);
  assert.equal((await status(f, r, "b".repeat(32))).status, 404);
  const list = await f.call(ownerRoot), s = await f.store.snapshot();
  assert.doesNotMatch(JSON.stringify(list.body), /keyHash|codeHash|controllerHash/);
  assert.equal(list.body.requests[0].code, undefined);
  assert.notEqual(s.wifiPairingRequests[0].keyHash, "a".repeat(32));
  assert.equal(s.wifiPairingRequests[0].codeHash, undefined);
  assert.equal(s.dashboardSessions.length, 3);
  assert.equal((await f.call("/api/account/dashboard", undefined, { session: "", controller: "" })).status, 401);
});

test("off-network, disabled, invalid voucher, and missing-main requests fail without connecting", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request({}, { address: "198.51.100.5" })).status, 403);
  assert.equal((await f.request({ code: "NC-BBBB-2222" })).status, 401);
  await f.store.transaction((s) => { s.networkSetup.assistedConnections.enabled = false; });
  assert.equal((await f.request()).status, 503);
  await f.store.transaction((s) => { s.networkSetup.assistedConnections.enabled = true; delete s.customers[0].wifiMainDevice; });
  const waiting = await f.request(); assert.equal(waiting.status, 201); assert.equal(waiting.body.request.mainRequired, true); assert.equal(f.calls.length, 0);
  for (const env of [{ NETWORK_QUEUE_ENABLED: "false" }, { COVERAGE_ACCESS_ENABLED: "false" }]) {
    const g = await fixture(t, { env }); assert.equal((await g.request()).status, 503);
  }
});

test("only the main controlling browser can approve; CSRF, customer isolation and code attempt limits apply", async (t) => {
  const f = await fixture(t), r = await f.request();
  assert.equal((await approve(f, r, { session: "secondary", controller: "" })).status, 403);
  assert.equal((await approve(f, r, { csrf: "bad" })).status, 403);
  assert.equal((await approve(f, r, { session: "other", controller: "" })).status, 403);
  const other = await f.call(ownerRoot, undefined, { session: "other", controller: "" });
  assert.deepEqual(other.body.requests, []);
  const issued = await f.call(ownerRoot + "/approve", { id: r.body.request.id });
  assert.equal(issued.status, 200); assert.match(issued.body.approvalCode, /^\d{6}$/);
  const wrong = issued.body.approvalCode === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await f.call(publicRoot + "/redeem", { id: r.body.request.id, key: r.requestKey, approvalCode: wrong }, { session: "", controller: "" })).status, 401);
  assert.equal((await approve(f, r)).status, 409); assert.equal(f.calls.length, 0);
  assert.equal((await status(f, r)).body.request.status, "failed");
});

test("approval reserves a slot and Connecting becomes Connected only after router confirmation", async (t) => {
  const f = await fixture(t), r = await f.request();
  const approved = await approve(f, r);
  assert.equal(approved.status, 202); assert.equal(approved.body.request.status, "connecting"); assert.equal(f.calls.length, 0);
  assert.equal((await approve(f, r)).status, 200);
  await f.process();
  const result = await status(f, r), s = await f.store.snapshot();
  assert.equal(result.body.request.status, "connected"); assert.equal(f.calls.length, 1);
  assert.ok(s.vouchers[0].wifiDevices.some((d) => d.mac === guestMac && d.sessionId === "*new"));
  assert.ok(Date.parse(f.calls[0].deadline) < Date.parse(r.body.request.expiresAt));
  await f.process(); assert.equal(f.calls.length, 1);
});

test("an enrolled authenticator does not require its code to approve Wi-Fi pairing", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.customers[0].totpSecret = totpSecret(); });
  const r = await f.request();
  assert.equal((await approve(f, r)).status, 202);
  await f.process(); assert.equal((await status(f, r)).body.request.status, "connected");
});

test("two approvals cannot consume the last slot; stale readings require a refresh", async (t) => {
  const f = await fixture(t), r = await f.request(), other = await f.request({ key: "b".repeat(32), mac: "AA:BB:CC:DD:EE:04", address: "10.20.0.40" });
  const results = await Promise.all([approve(f, r), approve(f, other)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
  assert.equal((await f.store.snapshot()).routerCommands.filter((c) => c.action === "connect_wifi_device").length, 1);
  const g = await fixture(t), request = await g.request(); g.advance(121);
  const stale = await approve(g, request);
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "DEVICE_REFRESH_REQUIRED");
  assert.ok((await g.store.snapshot()).routerCommands.some((c) => c.action === "sync_usage"));
});

test("expired, declined and cancelled requests cannot be approved or replayed", async (t) => {
  for (const state of ["expired", "declined", "cancelled"]) {
    const f = await fixture(t), r = await f.request();
    if (state === "expired") { await approve(f, r); f.advance(300); }
    else if (state === "declined") await f.call(ownerRoot + "/decline", { id: r.body.request.id });
    else await f.call(publicRoot + "/cancel", { id: r.body.request.id, key: "a".repeat(32) });
    assert.equal((await approve(f, r)).status, 409);
    assert.equal((await status(f, r)).body.request.status, state);
    await f.process(); assert.equal(f.calls.length, 0);
    const finished = await f.request();
    assert.equal(finished.status, 409); assert.equal(finished.body.code, "PAIRING_RESTART_REQUIRED");
    assert.equal(finished.body.approvalCode, undefined);
    const fresh = await f.request({ key: "b".repeat(32) });
    assert.equal(fresh.status, 201); assert.equal(fresh.body.request.status, "pending");
    assert.notEqual(fresh.body.request.id, r.body.request.id);
  }
});

test("worker rechecks main replacement, PIN reset, router revision, suspension and bundle data", async (t) => {
  for (const revoke of [
    (s) => { s.customers[0].wifiMainDevice.controllerHash = "replacement"; },
    (s) => { s.customers[0].pinHash = "reset"; },
    (s) => { s.networkSetup.connections.router.revision = "router-2"; },
    (s) => { s.customers[0].status = "suspended"; },
    (s) => { s.vouchers[0].usedBytes = 1e9; },
    (s) => { s.networkSetup.assistedConnections.enabled = false; },
  ]) {
    const f = await fixture(t), r = await f.request(); await approve(f, r);
    await f.store.transaction(revoke); await f.process();
    assert.equal(f.calls.length, 0); assert.equal((await status(f, r)).body.request.status, "failed");
  }
});

test("unconfirmed router replies retry without reporting connected and expire without another login", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { router: { async connectWifiDevice() { attempts++; return { confirmed: false }; } } }), r = await f.request();
  await approve(f, r); await f.process();
  assert.equal((await status(f, r)).body.request.status, "connecting");
  f.advance(301); await status(f, r); await f.process();
  assert.equal(attempts, 1); assert.equal((await status(f, r)).body.request.status, "expired");
});

test("a login started before expiry may finish bounded confirmation, but an abandoned lease cannot restart it", async (t) => {
  let finish;
  const f = await fixture(t, { router: { connectWifiDevice(device) { return new Promise((resolve) => { finish = () => resolve({ confirmed: true,
    device: { mac: device.mac, address: device.loginAddress, sessionId: "*late", startedAt: f.now().toISOString() } }); }); } } }), r = await f.request();
  await approve(f, r); f.advance(295);
  const processing = f.process();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  f.advance(6);
  assert.equal((await status(f, r)).body.request.status, "connecting");
  finish(); await processing;
  assert.equal((await status(f, r)).body.request.status, "connected");
  const g = await fixture(t), request = await g.request(); await approve(g, request);
  await g.store.transaction((s) => { const command = s.routerCommands.find((c) => c.action === "connect_wifi_device");
    command.status = "processing"; command.leaseUntil = new Date(+g.now() + 315000).toISOString(); command.leaseToken = "abandoned";
  });
  g.advance(316); assert.equal((await status(g, request)).body.request.status, "expired");
  await g.process(); assert.equal(g.calls.length, 0);
});

test("status polling is bearer limited without exhausting the shared sign-in IP budget", async (t) => {
  const f = await fixture(t, { env: { AUTH_EDGE_CUSTOMER_MAX: "1" } }), r = await f.request();
  assert.equal((await f.call(publicRoot + "/config", { id: r.body.request.id, key: "a".repeat(32) })).status, 405);
  assert.equal((await status(f, r)).status, 200); assert.equal((await status(f, r)).status, 429);
  for (let i = 0; i < 5; i++) { f.advance(2); assert.equal((await status(f, r)).status, 200); }
  assert.equal((await approve(f, r)).status, 202);
  const s = await f.store.snapshot();
  assert.equal(s.rateLimitEvents.filter((e) => e.scope === "customer-auth").length, 0);
});

function routerFixture() {
  let now = new Date("2030-01-01T12:00:00Z"), lost = false, writes = 0;
  const router = new RouterHotspot({ now: () => now }), tables = {
    "ip/hotspot/host": [{ ".id": "*guest", server: "ndahi-hotspot", "mac-address": guestMac, address: "10.20.0.30" }],
    "ip/dhcp-server/lease": [{ status: "bound", "active-mac-address": guestMac, "active-address": "10.20.0.30", "host-name": "Galaxy Note 8" }],
    "ip/hotspot/user": [{ name: "NC-AAAA-1111", comment: "ndahi:voucher:v1", server: "ndahi-hotspot", profile: "ndahi-users-3-presence-v1", "bytes-in": "20" }],
    "ip/hotspot/active": [], "ip/hotspot/user/profile": [{ name: "ndahi-users-3-presence-v1", "shared-users": "3", "keepalive-timeout": "2m", "idle-timeout": "none" }],
  };
  router.request = async (path, method, body) => {
    if (path === "ip/hotspot/active/login") {
      writes++; assert.equal(method, "POST"); assert.equal(body.ip, "10.20.0.30"); assert.equal(body["mac-address"], guestMac);
      tables["ip/hotspot/active"].push({ ".id": "*session", server: "ndahi-hotspot", "mac-address": guestMac, address: body.ip, user: body.user, uptime: "1s" });
      if (lost) throw Error("Response lost after login"); return {};
    }
    return tables[path];
  };
  const device = { mac: guestMac, address: "10.20.0.30", loginAddress: "10.20.0.30", hostId: "*guest", voucherId: "v1", username: "NC-AAAA-1111",
    expiresAt: new Date(+now + 86400000).toISOString(), deadline: new Date(+now + 30000).toISOString(), deviceLimit: 3, quotaBytes: 10000 };
  return { router, tables, device, writes: () => writes, loseResponse() { lost = true; }, expire() { now = new Date(+now + 31000); } };
}

test("RouterOS verifies the exact guest, managed voucher, limits, policy and login deadline before writing", async () => {
  for (const [change, code] of [
    [(f) => { f.tables["ip/hotspot/host"][0][".id"] = "*replacement"; }, "WIFI_TARGET_CHANGED"],
    [(f) => { f.tables["ip/hotspot/host"][0].address = "10.20.0.31"; }, "WIFI_TARGET_CHANGED"],
    [(f) => { f.tables["ip/hotspot/user"][0].comment = "unmanaged"; }, "BUNDLE_UNAVAILABLE"],
    [(f) => { f.tables["ip/hotspot/active"].push({ "mac-address": guestMac, user: "different" }); }, "WIFI_ALREADY_CONNECTED"],
    [(f) => { f.tables["ip/hotspot/active"] = Array.from({ length: 3 }, () => ({ user: f.device.username })); }, "DEVICE_LIMIT"],
    [(f) => { f.tables["ip/hotspot/user"][0]["bytes-in"] = "10000"; }, "QUOTA_EXHAUSTED"],
    [(f) => { f.tables["ip/hotspot/user/profile"][0]["shared-users"] = "5"; }, "SESSION_POLICY_OUTDATED"],
    [(f) => f.expire(), "PAIRING_EXPIRED"],
  ]) {
    const f = routerFixture(); change(f);
    await assert.rejects(f.router.connectWifiDevice(f.device), (e) => e.code === code && e.permanent);
    assert.equal(f.writes(), 0);
  }
});

test("RouterOS confirms a lost login response and retries an existing session without duplicate login", async () => {
  const f = routerFixture(); f.loseResponse();
  assert.equal((await f.router.connectWifiDevice(f.device)).confirmed, true);
  assert.equal((await f.router.connectWifiDevice(f.device)).device.sessionId, "*session");
  assert.equal(f.writes(), 1);
});

test("owner setup requires an explicit pilot check and read-only live-router readiness", async () => {
  const store = createStore({ persistent: false }), reads = [];
  const env = { NETWORK_CONFIG_KEY: "a".repeat(64), NETWORK_ALLOWED_ORIGINS: "https://router.test", COVERAGE_ACCESS_ENABLED: "true", NETWORK_QUEUE_ENABLED: "true" };
  const setup = createNetworkSetup({ store, env, routerFactory: () => ({ async request(path, method) {
    assert.equal(method, undefined); reads.push(path); return path === "ip/hotspot" ? [{ name: "ndahi-hotspot" }] : [];
  } }) });
  await setup.handle("connection", { kind: "router", mode: "live", url: "https://router.test", username: "fixture", password: "fixture" }, "owner");
  await store.transaction((s) => { s.networkSetup.runtimeRouterEnabled = true; });
  await assert.rejects(setup.handle("assisted-connections", { enabled: true }, "owner"), /Verify pre-login/);
  await setup.handle("assisted-connections", { enabled: true, tested: true }, "owner");
  assert.equal((await setup.handle("status", {}, "owner")).assistedConnectionsEnabled, true); assert.equal(reads.length, 4);
  await store.transaction((s) => { s.wifiPairingRequests = [{ status: "pending" }, { status: "connected" }]; });
  await setup.handle("assisted-connections", { enabled: false }, "owner");
  assert.deepEqual((await store.snapshot()).wifiPairingRequests.map((p) => p.status), ["cancelled", "connected"]);
  assert.equal(reads.length, 4);
});
