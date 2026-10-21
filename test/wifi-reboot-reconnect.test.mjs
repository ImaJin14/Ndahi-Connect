import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler, createStore } from "../server.mjs";
import { pairingFixture, mainMac, guestMac, publicRoot } from "./helpers/wifi-pairing-fixture.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";
import { wifiDeviceView } from "../lib/wifi-devices.mjs";

async function fixture(t, options) {
  const f = await pairingFixture(options); t.after(f.close); return f;
}

test("saved main identity survives a fresh store and reconnects without browser cookies after router sessions and DHCP details change", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/account/device-management/main", { mac: mainMac, pin: "2468" })).status, 200);
  const before = (await f.store.snapshot()).customers[0].wifiMainDevice;
  const directory = await mkdtemp(join(tmpdir(), "ndahi-reboot-persist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "synthetic-state.json"), committed = createStore({ file });
  await committed.transaction(async (s) => Object.assign(s, await f.store.snapshot()));
  const restored = createStore({ file }), connections = [];
  await restored.transaction((s) => {
    s.vouchers[0].wifiDevices = [];
    s.vouchers[0].wifiDevicesAt = f.now().toISOString();
  });
  const router = {
    async readGuestDevice({ mac, address }) { return { mac, address, loginAddress: address, hostId: "*after-reboot", server: "ndahi-hotspot", name: mac === mainMac ? "" : "imajin" }; },
    async connectWifiDevice(device) {
      connections.push(device);
      return { confirmed: true, device: { mac: device.mac, address: device.address, sessionId: "*new-session", startedAt: f.now().toISOString(), usedBytes: 0 } };
    },
  };
  const handler = createHandler({ store: restored, router, now: f.now, validateConfig: false, env: {
    NODE_ENV: "production", SECRET_PEPPER: "pairing-tests", CUSTOMER_SESSION_SECRET: "pairing-tests", SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: "http://customer.test", TRUST_PROXY: "render", COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: "203.0.113.10",
    NETWORK_QUEUE_ENABLED: "true", SECURITY_ALERTS_ENABLED: "false", BILLING_WORKER_ENABLED: "false", LOG_LEVEL: "warn",
  } });
  handler.routerProcessor.wake = () => {};
  const server = http.createServer(handler); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const request = async (mac, key) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${publicRoot}/request`, {
      method: "POST", headers: { origin: "http://customer.test", "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ phone: "670050001", code: "NC-AAAA-1111", mac, address: "10.20.0.95", key }),
    });
    return { status: response.status, body: await response.json() };
  };
  const reconnect = await request(mainMac, "b".repeat(32));
  assert.equal(reconnect.status, 202);
  await handler.routerProcessor.process(reconnect.body.request.commandId);
  let state = await restored.snapshot();
  assert.equal(connections.length, 1);
  assert.equal(state.wifiPairingRequests.at(-1).status, "connected");
  assert.deepEqual(state.customers[0].wifiMainDevice, before);
  const main = wifiDeviceView(state, state.vouchers[0]).devices[0];
  assert.equal(main.main, true); assert.equal(main.name, "imajin"); assert.equal(main.nameLastReported, true);
  assert.equal(state.wifiDeviceGrants[0].name, "imajin");
  const unknown = await request(guestMac, "c".repeat(32));
  assert.equal(unknown.status, 201); assert.equal(unknown.body.request.status, "pending");
  state = await restored.snapshot(); assert.equal(state.wifiPairingRequests.at(-1).kind, undefined);
  assert.equal(connections.length, 1, "a router restart must not approve an unknown MAC");
});

test("an approved reconnect reports a dead-lettered router reading honestly and can reconnect after operator recovery", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    approveDevice(s, "c1", { mac: mainMac, name: "imajin" }, f.now(), "main_selection");
    s.vouchers[0].wifiDevicesAt = new Date(+f.now() - 121000).toISOString();
    s.routerCommands.push({ id: "router:sync_usage:global", kind: "router_command", action: "sync_usage", status: "dead_letter" });
  });
  const failed = await f.request({ mac: mainMac });
  assert.equal(failed.status, 409); assert.equal(failed.body.code, "ROUTER_READ_FAILED");
  assert.equal(f.calls.length, 0); assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
  await f.store.transaction((s) => {
    s.routerCommands[0].status = "processed";
    s.vouchers[0].wifiDevicesAt = f.now().toISOString(); s.vouchers[0].wifiDevices = [];
  });
  const recovered = await f.request({ mac: mainMac }); assert.equal(recovered.status, 202);
  await f.process(recovered.body.request.commandId); assert.equal(f.calls.length, 1);
});

test("a completed connection key cannot masquerade as a current connection after reboot", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { approveDevice(s, "c1", { mac: mainMac, name: "imajin" }, f.now(), "main_selection"); });
  const initial = await f.request({ mac: mainMac }); assert.equal(initial.status, 202);
  const duplicate = await f.request({ mac: mainMac });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.request.id, initial.body.request.id);
  await f.process(initial.body.request.commandId);
  await f.store.transaction((s) => { s.vouchers[0].wifiDevices = []; s.vouchers[0].wifiDevicesAt = f.now().toISOString(); });
  const stale = await f.request({ mac: mainMac, address: "10.20.0.95" });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "PAIRING_RESTART_REQUIRED");
  const fresh = await f.request({ mac: mainMac, address: "10.20.0.95", key: "b".repeat(32) });
  assert.equal(fresh.status, 202); assert.notEqual(fresh.body.request.id, initial.body.request.id);
  const command = (await f.store.snapshot()).wifiPairingRequests.find((p) => p.id === fresh.body.request.id).commandId;
  await f.process(command); assert.equal(f.calls.length, 2);
  assert.equal((await f.store.snapshot()).customers[0].wifiMainDevice.mac, mainMac);
});

test("saved device names survive a missing DHCP label but do not cross a router revision", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    approveDevice(s, "c1", { mac: mainMac, name: "imajin" }, f.now(), "main_selection");
    approveDevice(s, "c1", { mac: mainMac, name: "" }, f.now(), "reconnect");
    assert.equal(s.wifiDeviceGrants[0].name, "imajin");
    delete s.vouchers[0].wifiDevices[0].name;
    const row = wifiDeviceView(s, s.vouchers[0]).devices[0];
    assert.equal(row.name, "imajin"); assert.equal(row.main, true); assert.equal(row.nameLastReported, true);
    s.networkSetup.connections.router.revision = "replacement-router";
    approveDevice(s, "c1", { mac: mainMac, name: "" }, f.now(), "reconnect");
    assert.equal(s.wifiDeviceGrants[0].name, "");
    assert.equal(wifiDeviceView(s, s.vouchers[0]).devices[0].name, undefined);
  });
});
