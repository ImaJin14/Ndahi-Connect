import assert from "node:assert/strict";
import http from "node:http";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture, guestMac, mainMac } from "../test/helpers/wifi-pairing-fixture.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
let checks = 0;
async function harness(width, { limit = 1, returning = false, occupied = false } = {}) {
  const website = http.createServer(); await new Promise(r => website.listen(0, "127.0.0.1", r));
  const portal = `http://127.0.0.1:${website.address().port}`, f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, router: { async disconnectWifiDevice() { return { confirmed: true, outcome: "disconnected" }; } } });
  await f.store.transaction(s => {
    s.vouchers[0].deviceLimit = limit; s.vouchers[0].planId = "custom-plan"; s.vouchers[0].wifiDevices = [];
    s.bundles.push({ id: "custom-plan", name: "Custom allowance", price: 500, quotaGb: 1, deviceLimit: limit, validityHours: 24 });
    delete s.customers[0].wifiMainDevice;
    if (returning || occupied) s.customers[0].wifiFirstConnectedAt = f.now().toISOString();
    if (occupied) s.vouchers[0].wifiDevices = [{ mac: mainMac, name: "Owner phone", address: "10.20.0.1", sessionId: "*old", startedAt: f.now().toISOString() }];
  });
  const staticServer = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.single.test/login" });
  website.on("request", (req, res) => staticServer.emit("request", req, res));
  const context = await browser.newContext({ viewport: { width, height: 950 } });
  await context.route("**/*", route => [portal, f.api].includes(new URL(route.request().url()).origin)
    ? route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }) : route.abort("blockedbyclient"));
  await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage(), errors = []; page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(15000);
  return { f, portal, page, errors, async close() { await context.close(); await f.close(); await new Promise(r => { website.close(r); website.closeAllConnections(); }); } };
}
try {
  for (const width of [320, 1280]) {
    let h = await harness(width);
    try {
      const { page } = h;
      await page.goto(h.portal + "/dashboard?main-device=" + encodeURIComponent(guestMac) + "#devices");
      await page.locator("#deviceManagement [data-device-proof]").waitFor({ state: "attached" });
      assert.equal(await page.locator("[data-select-main], .main-device-prompt, [data-pairing-controls]").count(), 0);
      assert.equal(new URL(page.url()).searchParams.has("main-device"), false);
      await page.goto(h.portal + "/pair?mac=" + guestMac + "&address=10.20.0.30");
      await page.waitForURL(/\/hotspot/);
      await page.locator("#message").filter({ hasText: /Waiting for the router/ }).waitFor();
      assert.equal((await h.f.store.snapshot()).wifiPairingRequests[0].kind, "bootstrap");
      assert.equal(await page.locator("#recoverWifiOwner").count(), 0);
      await h.f.process(); await page.waitForURL(/\/dashboard/);
      await page.locator("#deviceManagement [data-device-proof]").waitFor({ state: "attached" });
      assert.equal(new URL(page.url()).searchParams.has("main-device"), false);
      assert.equal(await page.locator(".main-device-prompt, [data-select-main]").count(), 0);
      assert.equal((await h.f.store.snapshot()).customers[0].wifiMainDevice, undefined);
      assert.deepEqual(h.errors, []); checks++; console.log(`PASS ${width}px single-device stale-link, signed-in first connection and completion without main setup`);
    } finally { await h.close(); }
    h = await harness(width, { returning: true });
    try {
      const { page } = h;
      await page.goto(h.portal + "/hotspot?mac=" + guestMac + "&address=10.20.0.30");
      await page.getByRole("button", { name: "Verify PIN and connect", exact: true }).waitFor();
      assert.doesNotMatch(await page.locator("#recoverWifiOwner").textContent(), /main device|recover|matching code/i);
      await page.getByLabel("Account PIN", { exact: true }).fill("2468");
      await page.getByRole("button", { name: "Verify PIN and connect", exact: true }).click();
      await page.locator("#message").filter({ hasText: /Waiting for the router/ }).waitFor();
      await h.f.process(); await page.waitForURL(/\/dashboard/);
      assert.equal(new URL(page.url()).searchParams.has("main-device"), false);
      assert.deepEqual(h.errors, []); checks++; console.log(`PASS ${width}px returning single owner uses ordinary PIN proof and router confirmation`);
    } finally { await h.close(); }
    h = await harness(width, { occupied: true });
    try {
      const { page } = h, before = (await h.f.store.snapshot()).vouchers[0];
      await page.goto(h.portal + "/hotspot?mac=" + guestMac + "&address=10.20.0.30");
      await page.getByRole("button", { name: "Switch connection to this device", exact: true }).waitFor();
      assert.match(await page.locator("#recoverWifiOwner").textContent(), /Owner phone/);
      await page.getByLabel("Account PIN", { exact: true }).fill("2468");
      await page.getByRole("button", { name: "Switch connection to this device", exact: true }).click();
      await page.locator("#message").filter({ hasText: /previous device is disconnected/ }).waitFor();
      let state = await h.f.store.snapshot(), p = state.wifiPairingRequests[0];
      assert.equal(h.f.calls.length, 0); assert.equal(state.vouchers[0].wifiDevices[0].mac, mainMac);
      await h.f.process(p.disconnectCommandId); await h.f.process(p.commandId);
      await page.waitForURL(/\/dashboard/);
      state = await h.f.store.snapshot();
      assert.deepEqual(state.vouchers[0].wifiDevices.map(d => d.mac), [guestMac]);
      assert.equal(state.vouchers[0].quotaBytes, before.quotaBytes); assert.equal(state.vouchers[0].expiresAt, before.expiresAt);
      assert.equal(new URL(page.url()).searchParams.has("main-device"), false);
      assert.deepEqual(h.errors, []); checks++; console.log(`PASS ${width}px explicit switch names the previous device and waits for exact router removal before connection`);
    } finally { await h.close(); }
    h = await harness(width, { limit: 2 });
    try {
      await h.page.goto(h.portal + "/dashboard?main-device=" + encodeURIComponent(guestMac) + "#devices");
      await h.page.getByRole("button", { name: "Yes, set as main device", exact: true }).waitFor();
      assert.equal(await h.page.locator("[data-select-main]").isVisible(), true);
      assert.deepEqual(h.errors, []); checks++; console.log(`PASS ${width}px two-device custom allowance still offers main setup with zero devices online`);
    } finally { await h.close(); }
  }
  console.log(`Completed ${checks} single-device browser journeys.`);
} finally { await browser.close(); }
