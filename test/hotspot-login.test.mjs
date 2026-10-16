import test from "node:test";
import assert from "node:assert/strict";
import { createAccountRoutes } from "../lib/api/account.mjs";
import { createStaticServer } from "../static-server.mjs";

const now = new Date("2030-01-01T00:00:00Z");
function fixture() {
  const state = {
    customers: [{ id: "customer-1" }, { id: "customer-2" }], payments: [],
    networkSetup: { runtimeRouterEnabled: true, connections: { router: { mode: "live" } } },
    vouchers: [{ id: "voucher-1", code: "NC-TEST-1234", customerId: "customer-1", status: "active", activatedAt: "2029-12-31T00:00:00Z", expiresAt: "2030-01-02T00:00:00Z", quotaBytes: 1000, usedBytes: 0, deviceLimit: 2, routerSyncStatus: "synchronized" }],
    events: [], routerCommands: [],
  };
  let session = { customerId: "customer-1" }, refreshed = false;
  const route = createAccountRoutes({ mutate: (fn) => fn(state), auth: () => session, clock: () => now, refreshCustomerSession: () => { refreshed = true; } });
  return {
    state, setSession(value) { session = value; },
    async call(path = "/api/account/hotspot-credentials", input) {
      const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.body = JSON.parse(value); } },
        req = input === undefined ? { method: "GET" } : { method: "POST", async *[Symbol.asyncIterator]() { yield JSON.stringify(input); } };
      await route(req, res, new URL("http://api.test" + path));
      return { ...res, refreshed };
    },
  };
}

test("HotSpot credentials are owned, synchronized, and never cached", async () => {
  const f = fixture(), result = await f.call();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { username: "NC-TEST-1234", password: "NC-TEST-1234" });
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.refreshed, true);
});

for (const [name, change, status] of [
  ["missing session", (f) => f.setSession(null), 401],
  ["missing customer", (f) => f.setSession({ customerId: "missing" }), 401],
  ["another customer's voucher", (f) => f.setSession({ customerId: "customer-2" }), 409],
  ["suspended account", (f) => { f.state.customers[0].status = "suspended"; }, 403],
  ["revoked voucher", (f) => { f.state.vouchers[0].status = "revoked"; }, 409],
  ["expired voucher", (f) => { f.state.vouchers[0].expiresAt = now.toISOString(); }, 409],
  ["invalid expiry", (f) => { f.state.vouchers[0].expiresAt = "invalid"; }, 409],
  ["exhausted quota", (f) => { f.state.vouchers[0].usedBytes = 1000; }, 409],
  ["unverified purchase", (f) => { f.state.vouchers[0].paymentId = "pending"; }, 409],
  ["disabled router", (f) => { f.state.networkSetup.runtimeRouterEnabled = false; }, 503],
  ["mock router", (f) => { f.state.networkSetup.connections.router.mode = "mock"; }, 503],
  ["pending synchronization", (f) => { f.state.vouchers[0].routerSyncStatus = "pending"; }, 202],
  ["failed synchronization", (f) => { f.state.vouchers[0].routerSyncStatus = "dead_letter"; }, 202],
]) test(`HotSpot login withholds credentials for ${name}`, async () => {
  const f = fixture(); change(f);
  const result = await f.call();
  assert.equal(result.status, status);
  assert.equal(result.body.password, undefined);
  assert.equal(result.body.username, undefined);
  assert.equal(result.headers["cache-control"], "no-store");
  if (status === 202) assert.equal(result.headers["retry-after"], "2");
});

test("HotSpot login accepts unlimited data and confirmed customer payments", async () => {
  const f = fixture();
  Object.assign(f.state.vouchers[0], { paymentId: "paid", quotaBytes: null });
  f.state.payments.push({ id: "paid", customerId: "customer-1", confirmedAt: now.toISOString(), status: "paid" });
  assert.equal((await f.call()).status, 200);
  f.state.payments[0].status = "processing";
  assert.equal((await f.call()).status, 409);
});

test("customer HotSpot configuration permits only the configured HTTPS form origin", async (t) => {
  const server = createStaticServer("customer", { apiUrl: "https://api.test", hotspotLoginUrl: "https://connect.hotspot.test/login" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, page = await fetch(base + "/hotspot"), config = await fetch(base + "/config.js");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /form-action 'self' https:\/\/connect\.hotspot\.test(?:;|$)/);
  assert.match(await page.text(), /id="hotspotLogin" method="post"/);
  assert.match(await config.text(), /"hotspotLoginUrl":"https:\/\/connect\.hotspot\.test\/login"/);
  for (const hotspotLoginUrl of ["http://connect.test/login", "https://connect.test/other", "https://user:password@connect.test/login", "https://connect.test/login?next=external", "https://connect.test/login#fragment"]) {
    assert.throws(() => createStaticServer("customer", { hotspotLoginUrl }), /HOTSPOT_LOGIN_URL/);
  }
});

for (const [name, change, code] of [
  ["synced usage at the quota", (f) => { f.state.vouchers[0].usedBytes = 1000; }, "QUOTA_EXHAUSTED"],
  ["an exhausted bundle", (f) => { f.state.vouchers[0].status = "exhausted"; }, "QUOTA_EXHAUSTED"],
  ["an expired bundle", (f) => { f.state.vouchers[0].status = "expired"; }, "BUNDLE_EXPIRED"],
  ["a lapsed bundle", (f) => { f.state.vouchers[0].expiresAt = now.toISOString(); }, "BUNDLE_EXPIRED"],
  ["a revoked bundle", (f) => { f.state.vouchers[0].status = "revoked"; }, undefined],
]) test(`HotSpot login explains ${name}`, async () => {
  const f = fixture(); change(f);
  const result = await f.call();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, code);
});

test("customers see and free only their own router-reported Wi-Fi devices", async () => {
  const f = fixture(), voucher = f.state.vouchers[0];
  voucher.wifiDevices = [{ mac: "AA:BB:CC:DD:EE:01", address: "10.20.0.30", uptime: "5m", usedBytes: 10 }, { mac: "AA:BB:CC:DD:EE:02", address: "10.20.0.31", uptime: "1m", usedBytes: 5 }];
  voucher.wifiDevicesAt = now.toISOString();
  f.state.vouchers.push({ id: "voucher-2", customerId: "customer-2", status: "active", wifiDevices: [{ mac: "AA:BB:CC:DD:EE:09" }] });
  const list = await f.call("/api/account/wifi-devices");
  assert.equal(list.status, 200);
  assert.equal(list.body.deviceLimit, 2);
  assert.deepEqual(list.body.devices.map((d) => d.mac), ["AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02"]);
  assert.match(list.body.csrfToken, /\S{16,}/);
  const other = await f.call("/api/account/wifi-devices/disconnect", { mac: "AA:BB:CC:DD:EE:09" });
  assert.equal(other.status, 404);
  assert.deepEqual(f.state.routerCommands, []);
  const freed = await f.call("/api/account/wifi-devices/disconnect", { mac: "aa:bb:cc:dd:ee:01" });
  assert.equal(freed.status, 200);
  assert.deepEqual(freed.body.devices.map((d) => d.mac), ["AA:BB:CC:DD:EE:02"]);
  assert.deepEqual(f.state.routerCommands.map((c) => c.id), ["router:disconnect_device:AA:BB:CC:DD:EE:01"]);
  assert.deepEqual(f.state.vouchers[1].wifiDevices.map((d) => d.mac), ["AA:BB:CC:DD:EE:09"]);
  f.setSession(null);
  assert.equal((await f.call("/api/account/wifi-devices")).status, 401);
});

test("issuing HotSpot credentials queues a prompt router read for the new device", async () => {
  const f = fixture();
  await f.call();
  assert.deepEqual(f.state.routerCommands.map((c) => [c.id, c.status, c.nextAttemptAt]),
    [["router:sync_usage:global", "queued", new Date(+now + 5000).toISOString()]]);
  f.state.routerCommands[0].status = "dead_letter";
  await f.call();
  assert.equal(f.state.routerCommands[0].status, "dead_letter");
  const refused = fixture();
  refused.state.vouchers[0].routerSyncStatus = "pending";
  await refused.call();
  assert.deepEqual(refused.state.routerCommands, []);
});
