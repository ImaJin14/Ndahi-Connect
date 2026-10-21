import assert from "node:assert/strict";
import http from "node:http";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture, guestMac } from "../test/helpers/wifi-pairing-fixture.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";

const website = http.createServer();
await new Promise((resolve) => website.listen(0, "127.0.0.1", resolve));
const portal = `http://127.0.0.1:${website.address().port}`;
const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, router: {
  async disconnectWifiDevice() { return { confirmed: true, outcome: "disconnected" }; },
  async readUsage() { return (await f.store.snapshot()).vouchers.map((v) => ({ voucherId: v.id, usedBytes: v.usedBytes, devices: v.wifiDevices || [] })); },
} });
const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.current.test/login" });
website.on("request", (req, res) => assets.emit("request", req, res));
await f.store.transaction((s) => {
  approveDevice(s, "c1", { mac: guestMac }, f.now(), "test");
  s.vouchers[0].wifiDevices.push({ mac: guestMac, address: "10.20.0.30", sessionId: "*guest", startedAt: f.now().toISOString() });
});
let browser;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
  await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(() => {
    for (const store of ["localStorage", "sessionStorage"]) Object.defineProperty(window, store, { get() { throw new DOMException("Storage denied", "SecurityError"); } });
  });
  await context.route("**/*", (route) => [portal, f.api].includes(new URL(route.request().url()).origin)
    ? route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }) : route.abort("blockedbyclient"));
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000); page.on("pageerror", (error) => errors.push(error.message));
  const card = page.locator("#currentWifi");
  await page.goto(portal + "/dashboard");
  await card.locator('[data-current-state="unknown"]').waitFor();
  assert.equal(await card.getByRole("button", { name: "Disconnect this device", exact: true }).count(), 0);
  console.log("PASS an account login and other connected sessions do not label an unidentified browser Connected");

  await page.goto(portal + "/dashboard?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.30");
  await card.locator('[data-current-state="connected"]').waitFor();
  assert.equal(await card.getByRole("link", { name: "Connect to Wi-Fi", exact: true }).count(), 0);
  assert.equal(await card.getByRole("button", { name: "Disconnect this device", exact: true }).isVisible(), true);
  assert.match(await card.textContent(), /Last checked:/);
  console.log("PASS fresh router-verified current session replaces Connect with Connected and an adjacent Disconnect at 320px without storage");

  // Commit the disconnect, lose its HTTP reply, and let the card reconcile the
  // existing operation. It must not claim the slot is free or issue a new login.
  await page.route("**/api/account/wifi-devices/disconnect", async (route) => {
    const response = await route.fetch({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } });
    assert.equal(response.status(), 202); assert.equal(route.request().postDataJSON().retainApproval, true);
    await route.abort("failed");
  }, { times: 1 });
  await card.getByRole("button", { name: "Disconnect this device", exact: true }).click();
  await card.locator('[data-current-state="disconnecting"]').waitFor();
  assert.equal(await card.getByRole("link", { name: "Connect to Wi-Fi", exact: true }).count(), 0);
  let state = await f.store.snapshot();
  assert.equal(state.vouchers[0].wifiDevices.length, 3);
  const operation = state.routerCommands.find((c) => c.action === "disconnect_wifi_device");
  await f.handler.routerProcessor.process(operation.id);
  await card.locator('[data-current-state="disconnected"]').waitFor();
  state = await f.store.snapshot();
  assert.equal(state.wifiDeviceGrants.find((g) => g.mac === guestMac).status, "approved");
  assert.equal(f.calls.length, 0);
  const connect = new URL(await card.getByRole("link", { name: "Connect to Wi-Fi", exact: true }).getAttribute("href"), portal);
  assert.equal(connect.searchParams.get("mac"), guestMac); assert.equal(connect.searchParams.get("address"), "10.20.0.30");
  console.log("PASS lost disconnect response remains pending until router confirmation, retains saved approval and preserves reconnect identity without storage");

  await f.store.transaction((s) => { s.vouchers[0].wifiDevicesAt = new Date(+f.now() - 121000).toISOString(); });
  await card.getByRole("button", { name: "Refresh connection status", exact: true }).click();
  // A targeted confirmed disconnect remains valid briefly; after its freshness
  // window expires a stale complete reading must not claim Connected.
  f.advance(121);
  await page.reload();
  await card.locator('[data-current-state="stale"]').waitFor();
  assert.equal(await card.getByRole("button", { name: "Disconnect this device", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("PASS stale readings never claim Connected or expose a destructive session action");
  await context.close();
} finally {
  await browser?.close(); await f.close();
  await new Promise((resolve) => { website.close(resolve); website.closeAllConnections(); });
}
