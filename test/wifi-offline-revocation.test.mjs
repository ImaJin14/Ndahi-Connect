import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { pairingFixture, guestMac, mainMac, publicRoot, ownerRoot } from "./helpers/wifi-pairing-fixture.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";
import { RouterHotspot } from "../lib/router-hotspot.mjs";
import { bridgeHandler } from "../scripts/network-bridge.mjs";
import { totpCode, totpSecret } from "../lib/security.mjs";

const root = "/api/account/device-management", forget = root + "/forget";
async function fixture(t, options = {}) {
  const removed = [], f = await pairingFixture({ ...options, router: { revokeWifiDevice: async (device) => {
    removed.push(device); return { confirmed: true, outcome: "revoked" };
  }, ...options.router } });
  t.after(f.close);
  await f.store.transaction((s) => { approveDevice(s, "c1", { mac: guestMac, name: "Offline TV" }, f.now(), "test"); });
  const id = (await f.store.snapshot()).wifiDeviceGrants[0].id;
  return { ...f, removed, id, forget: (input = {}, auth) => f.call(forget, { approvalId: id, pin: "2468", ...input }, auth) };
}

test("saved offline approvals are scoped to their owner and removal needs session, CSRF and fresh proof", async (t) => {
  const f = await fixture(t);
  const list = await f.call(root);
  assert.equal(list.body.approvedDevices[0].name, "Offline TV");
  assert.equal((await f.call(root, undefined, { session: "other", controller: "" })).body.approvedDevices.length, 0);
  assert.equal((await f.forget({}, { session: "" })).status, 401);
  assert.equal((await f.forget({}, { csrf: "wrong" })).status, 403);
  assert.equal((await f.forget({}, { session: "other" })).status, 404);
  assert.equal((await f.forget({ pin: "0000" })).status, 401);
  assert.equal((await f.store.snapshot()).wifiDeviceGrants[0].status, "approved");
});

test("forgetting an offline device revokes its grant and confirms router cleanup before fresh approval", async (t) => {
  const f = await fixture(t);
  const result = await f.forget(); assert.equal(result.status, 202);
  let s = await f.store.snapshot(), id = s.wifiDeviceGrants[0].revocationCommandId;
  assert.equal(s.wifiDeviceGrants[0].status, "revoked");
  assert.equal(result.body.approvedDevices[0].removal, "pending");
  assert.equal((await f.forget()).status, 202);
  assert.equal((await f.store.snapshot()).routerCommands.filter((c) => c.action === "revoke_wifi_device").length, 1);
  const request = await f.request(); assert.equal(request.status, 201);
  const issued = await f.call(ownerRoot + "/approve", { id: request.body.request.id });
  assert.equal((await f.call(publicRoot + "/redeem", { id: request.body.request.id, key: request.requestKey, approvalCode: issued.body.approvalCode })).status, 409);
  assert.equal(f.calls.length, 0);
  await f.process(id); assert.equal(f.removed.length, 1);
  assert.equal(f.removed[0].mac, guestMac); assert.deepEqual(f.removed[0].targets, [{ voucherId: "v1", username: "NC-AAAA-1111" }]);
  assert.equal((await f.call(root)).body.approvedDevices.length, 0);
  assert.equal((await f.call(publicRoot + "/redeem", { id: request.body.request.id, key: request.requestKey, approvalCode: issued.body.approvalCode })).status, 202);
  await f.process(request.body.request.commandId); assert.equal(f.calls.length, 1);
  s = await f.store.snapshot(); assert.equal(s.wifiDeviceGrants[0].status, "approved"); assert.equal(s.wifiDeviceGrants[0].revocationCommandId, undefined);
});

test("offline removal works after bundle expiry and cancels pending codes and unclaimed reconnect jobs", async (t) => {
  const f = await fixture(t), queued = await f.request(); assert.equal(queued.status, 202);
  await f.store.transaction((s) => {
    s.wifiPairingRequests.push({ id: "old-code", customerId: "c1", voucherId: "v1", mac: guestMac,
      status: "awaiting_code", codeNonce: randomUUID(), codeHash: "fixture", expiresAt: new Date(+f.now() + 60000).toISOString() });
    s.vouchers[0].status = "expired";
  });
  assert.equal((await f.forget()).status, 202);
  const s = await f.store.snapshot();
  assert.ok(s.wifiPairingRequests.every((p) => p.status === "cancelled"));
  assert.ok(s.wifiPairingRequests.every((p) => !p.codeHash && !p.codeNonce));
  await f.process(queued.body.request.commandId); assert.equal(f.calls.length, 0);
  await f.process(s.wifiDeviceGrants[0].revocationCommandId); assert.equal(f.removed.length, 1);
});

test("an in-flight reconnect must finish before removal and cannot silently restore a revoked grant", async (t) => {
  let release, started;
  const began = new Promise((r) => { started = r; }), block = new Promise((r) => { release = r; });
  const f = await fixture(t, { router: { connectWifiDevice: async (d) => { started(); await block;
    return { confirmed: true, device: { mac: d.mac, address: d.loginAddress, sessionId: "*new", startedAt: new Date().toISOString() } }; } } });
  const request = await f.request(), running = f.process(request.body.request.commandId);
  try { await began; assert.equal((await f.forget()).status, 409); assert.equal((await f.store.snapshot()).wifiDeviceGrants[0].status, "approved"); }
  finally { release(); await running; }
  assert.equal((await f.forget()).status, 202);
});

test("failed router cleanup retains observed slots and blocks reauthorization until support retry confirms it", async (t) => {
  let fail = true;
  const f = await fixture(t, { router: { revokeWifiDevice: async () => { if (fail) throw Error("Synthetic router outage"); return { confirmed: true, outcome: "revoked" }; } } });
  await f.store.transaction((s) => { s.vouchers[0].wifiDevices.push({ mac: guestMac, sessionId: "*tv", startedAt: f.now().toISOString() }); });
  await f.forget(); let s = await f.store.snapshot(), id = s.wifiDeviceGrants[0].revocationCommandId;
  await f.process(id); s = await f.store.snapshot();
  assert.equal(s.routerCommands.find((c) => c.id === id).status, "retry");
  assert.equal(s.vouchers[0].wifiDevices.length, 3);
  assert.equal((await f.call(root + "/main", { mac: guestMac, pin: "2468" })).status, 409);
  f.advance(31); fail = false; await f.process(id);
  assert.equal((await f.store.snapshot()).vouchers[0].wifiDevices.length, 2);
});

test("forgetting a saved main device uses fresh PIN despite stale authenticator fields and revokes controller access", async (t) => {
  const f = await fixture(t), secret = totpSecret();
  await f.store.transaction((s) => { approveDevice(s, "c1", { mac: mainMac }, f.now(), "test"); s.customers[0].totpSecret = secret; });
  const id = (await f.store.snapshot()).wifiDeviceGrants.find((g) => g.mac === mainMac).id;
  assert.equal((await f.forget({ approvalId: id, pin: undefined, otp: totpCode(secret,+f.now()) })).status, 401);
  f.advance(2);
  const result = await f.forget({ approvalId: id }); assert.equal(result.status, 202);
  assert.equal((await f.store.snapshot()).customers[0].wifiMainDevice, undefined);
  assert.equal((await f.call(ownerRoot)).body.isMainController, false);
  assert.match(result.headers.get("set-cookie"), /Max-Age=0/i);
});

test("a saved removal job cannot act on another router revision or an approval granted later", async (t) => {
  for (const change of [(s) => { s.networkSetup.connections.router.revision = "router-2"; }, (s) => { s.wifiDeviceGrants[0].status = "approved"; }]) {
    const f = await fixture(t); await f.forget(); const s = await f.store.snapshot(), id = s.wifiDeviceGrants[0].revocationCommandId;
    await f.store.transaction(change); await f.process(id);
    assert.equal(f.removed.length, 0); assert.equal((await f.store.snapshot()).routerCommands.find((c) => c.id === id).result, "superseded");
  }
});

test("passkey removal challenges bind the session, saved grant version and exact device", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.customers[0].passkeys = [{ id: "AA", transports: ["internal"] }];
    approveDevice(s, "c1", { mac: "AA:BB:CC:DD:EE:09" }, f.now(), "test");
  });
  const options = await f.call(forget + "/options", { approvalId: f.id }); assert.equal(options.status, 200);
  const s = await f.store.snapshot(), challenge = s.customerPasskeyChallenges.find((c) => c.id === options.body.challengeId);
  assert.equal(challenge.type, "wifi_forget"); assert.equal(challenge.sessionId, "main");
  assert.deepEqual(JSON.parse(challenge.target), [f.id, "router-1", s.wifiDeviceGrants[0].approvedAt]);
  const other = s.wifiDeviceGrants.find((g) => g.mac.endsWith("09"));
  assert.equal((await f.forget({ approvalId: other.id, pin: undefined, challengeId: challenge.id, response: { id: "AA" } })).status, 401);
  assert.equal((await f.store.snapshot()).wifiDeviceGrants.filter((g) => g.status === "approved").length, 2);
});

test("router removal clears only the managed voucher's target MAC, including offline cookies", async () => {
  const router = new RouterHotspot({}), deadline = new Date(Date.now() + 30000).toISOString();
  const tables = { "ip/hotspot/user": [{ name: "NC-AAAA-1111", comment: "ndahi:voucher:v1", server: "ndahi-hotspot" }],
    "ip/hotspot/active": [{ ".id": "*other-device", user: "NC-AAAA-1111", "mac-address": mainMac, server: "ndahi-hotspot" }],
    "ip/hotspot/cookie": [{ ".id": "*offline", user: "NC-AAAA-1111", "mac-address": guestMac },
      { ".id": "*other-user", user: "NC-BBBB-2222", "mac-address": guestMac }, { ".id": "*other-device", user: "NC-AAAA-1111", "mac-address": mainMac }] };
  router.request = async (path, method) => { if (method !== "DELETE") return structuredClone(tables[path] || []);
    const at = path.lastIndexOf("/"), table = path.slice(0, at), id = decodeURIComponent(path.slice(at + 1)); tables[table] = tables[table].filter((r) => r[".id"] !== id); return {}; };
  assert.equal((await router.revokeWifiDevice({ mac: guestMac, targets: [{ voucherId: "v1", username: "NC-AAAA-1111" }], deadline })).confirmed, true);
  assert.equal(tables["ip/hotspot/cookie"].length, 2); assert.equal(tables["ip/hotspot/active"].length, 1);
  tables["ip/hotspot/active"].push({ ".id": "*returned", user: "NC-AAAA-1111", "mac-address": guestMac, server: "ndahi-hotspot" });
  await router.revokeWifiDevice({ mac: guestMac, targets: [{ voucherId: "v1", username: "NC-AAAA-1111" }], deadline });
  assert.equal(tables["ip/hotspot/active"].length, 1);
  await assert.rejects(router.revokeWifiDevice({ mac: guestMac, targets: [], deadline: new Date(Date.now() - 1000).toISOString() }), /timed out/);
});

test("the authenticated management bridge dispatches the scoped saved-access removal", async (t) => {
  const key = randomUUID(), calls = [], server = http.createServer(bridgeHandler({ username: "test", password: key,
    router: { revokeWifiDevice: async (device) => { calls.push(device); return { confirmed: true, outcome: "revoked" }; } },
    logger: { info() {}, error() {} } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const url = "http://127.0.0.1:" + server.address().port + "/ndahi/revokeWifiDevice", device = { mac: guestMac, targets: [] };
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  const response = await fetch(url, { method: "POST", headers: { authorization: "Basic " + Buffer.from("test:" + key).toString("base64") }, body: JSON.stringify({ device }) });
  assert.equal(response.status, 200); assert.deepEqual(calls, [device]);
});
