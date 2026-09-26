import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { RouterHotspot } from "../lib/router-hotspot.mjs";
import { bridgeHandler } from "../scripts/network-bridge.mjs";
import { savedRouterAdapter } from "../lib/network-runtime.mjs";
import { seal } from "../lib/network-secrets.mjs";
import { OmadaProvisioner } from "../lib/network-omada.mjs";

test("Hotspot bridge arms absolute expiry before enabling users and applies quota/device limits", async () => {
  const router = new RouterHotspot({}), writes = [];
  router.request = async (path, method = "GET", payload) => { if (method !== "GET") writes.push({ path, method, payload }); return []; };
  const payload = { schemaVersion: 1, voucherId: "voucher-1", username: "NC-ABCD-1234", password: "NC-ABCD-1234", profileId: "weekly", expiresAt: "2035-01-01T00:00:00Z", simultaneousUsers: 2, limitBytesTotal: 5000000000, enabled: true };
  await router.syncPayload(payload);
  assert.equal(writes[0].path, "ip/hotspot/user/profile");
  assert.equal(writes[0].payload["shared-users"], "2");
  assert.equal(writes[1].path, "system/scheduler");
  assert.match(writes[1].payload["on-event"], /:timestamp/);
  assert.equal(writes[2].path, "ip/hotspot/user");
  assert.equal(writes[2].payload["limit-bytes-total"], "5000000000");
  assert.equal(writes[2].payload.disabled, "false");
  await assert.rejects(router.syncPayload({ ...payload, voucherId: '"; /system reset-configuration' }), /Invalid/);
  await assert.rejects(router.disconnectDevice("browser-random-id"), /trusted hotspot MAC/);
});

test("Hotspot adapter refuses to overwrite unmanaged credentials and reports unknown session mapping", async () => {
  const router = new RouterHotspot({});
  router.request = async () => [{ name: "NC-ABCD-1234", comment: "owned-by-someone-else" }];
  await assert.rejects(router.upsert("ip/hotspot/user", "NC-ABCD-1234", { comment: "ndahi:voucher:1" }), /unmanaged/);
  const state = await router.readState();
  assert.equal(state.sessions, null);
  assert.deepEqual(state.vouchers, []);
});

test("management bridge authenticates, restricts actions, and serializes mutations", async (t) => {
  let current = 0, maximum = 0;
  const router = { readUsage: async () => { current++; maximum = Math.max(maximum, current); await new Promise((r) => setTimeout(r, 10)); current--; return []; } };
  const server = http.createServer(bridgeHandler({ router, username: "bridge", password: "x".repeat(32) }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Basic ${Buffer.from(`bridge:${"x".repeat(32)}`).toString("base64")}` };
  assert.equal((await fetch(url + "/ndahi/readUsage", { method: "POST" })).status, 401);
  assert.equal((await fetch(url + "/ndahi/execute", { method: "POST", headers })).status, 404);
  const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(url + "/ndahi/readUsage", { method: "POST", headers, body: "{}" })));
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(maximum, 1);
});

test("saved runtime routes enforcement to encrypted active connection and fails closed on revoked origins", async () => {
  const env = { NETWORK_CONFIG_KEY: "b".repeat(64), NETWORK_ALLOWED_ORIGINS: "https://router.test" };
  const state = { networkSetup: { runtimeRouterEnabled: false, connections: { router: { mode: "live", secret: seal({ url: "https://router.test", username: "u", password: "private" }, env) } } } };
  const router = savedRouterAdapter({ env, store: { snapshot: async () => state }, fallback: { readUsage: async () => "legacy" }, factory: (connection) => ({ readUsage: async () => { assert.equal(connection.password, "private"); return "saved"; } }) });
  assert.equal(await router.readUsage(), "legacy");
  state.networkSetup.runtimeRouterEnabled = true;
  assert.equal(await router.readUsage(), "saved");
  env.NETWORK_ALLOWED_ORIGINS = "";
  await assert.rejects(router.readUsage(), /NETWORK_ALLOWED_ORIGINS/);
});

test("version-matched Omada fixture supports preview, verified update, and backup restoration", async () => {
  let ssid = { id: "ssid1", name: "Original", security: 1, password: "original-secret", vlan: 0, isolation: true };
  const original = structuredClone(ssid);
  const profile = {
    versionPath: "/openapi/fixture/version", versionField: "version", versions: ["fixture-1"],
    ssid: { fields: { name: "name", security: "security", password: "password", vlan: "vlan", isolation: "isolation" }, values: { security: { open: 0, wpa2: 1 } },
      update: { path: "/openapi/fixture/ssids/{ssidId}", method: "PATCH" } },
  };
  const adapter = new OmadaProvisioner({ url: "https://controller.test", controllerId: "c", siteId: "s", wlanId: "w", clientId: "client", clientSecret: "secret" }, { profile,
    fetcher: async (url, options) => {
      let result;
      if (url.includes("authorize")) result = { accessToken: "token" };
      else if (url.includes("/version")) result = { version: "fixture-1" };
      else if (options.method === "PATCH") { Object.assign(ssid, JSON.parse(options.body)); result = {}; }
      else result = { data: [ssid], totalRows: 1 };
      return Response.json({ errorCode: 0, result });
    },
  });
  const plan = await adapter.preview({ ssidId: "ssid1", name: "NDAHI", security: "wpa2", password: "new-password", vlan: 20 });
  assert.equal(plan.before.payload.password, "original-secret");
  await adapter.apply(plan, async () => {});
  assert.equal(ssid.name, "NDAHI"); assert.equal(ssid.password, "new-password");
  await adapter.rollback(plan);
  assert.deepEqual(ssid, original);
  const stale = await adapter.preview({ ssidId: "ssid1", name: "New name", security: "open", vlan: 0 });
  ssid.name = "External edit";
  await assert.rejects(adapter.apply(stale, async () => {}), /changed/);
  await assert.rejects(adapter.rollback(stale), /changed outside/);
});


test("Omada adoption waits for controller confirmation rather than treating acceptance as completion", async () => {
  let status = "pending", polls = 0, waits = 0;
  const mac = "AA:BB:CC:DD:EE:FF";
  const profile = { versionPath: "/openapi/fixture/version", versionField: "version", versions: ["fixture"],
    adopt: { method: "POST", path: "/openapi/fixture/adopt", macField: "mac", stateField: "status", pendingStates: ["pending"], adoptedStates: ["connected"] } };
  const adapter = new OmadaProvisioner({ url: "https://controller.test", controllerId: "c", siteId: "s", wlanId: "w" }, { profile,
    wait: async () => { waits++; status = "connected"; },
    fetcher: async (url, options) => {
      let result;
      if (url.includes("authorize")) result = { accessToken: "token" };
      else if (url.includes("version")) result = { version: "fixture" };
      else if (options.method === "POST") { status = "adopting"; result = {}; }
      else { polls++; result = { data: [{ mac, status }], totalRows: 1 }; }
      return Response.json({ errorCode: 0, result });
    },
  });
  const plan = await adapter.preview({ action: "adopt", mac });
  const progress = [];
  await adapter.apply(plan, async (step) => progress.push(step));
  assert.equal(waits, 1); assert.ok(polls >= 4);
  assert.ok(progress.some((v) => v.includes("Waiting for AP")));
});
