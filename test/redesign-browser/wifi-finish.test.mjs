import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture, guestMac } from "../helpers/wifi-pairing-fixture.mjs";
import { routerRevision } from "../../lib/device-identities.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Finish Wi-Fi sign-in (#372, canvas: PhoneWifiConnected; owner: tap to
// connect). A PIN sign-in on NDAHI Wi-Fi with a running bundle shows this
// device, the bundle and its time left, and the device slots; nothing connects
// until Connect this device. "You're online" shows only once the network
// confirms the device. The network's answers are set by the test.

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

test("a PIN sign-in on NDAHI Wi-Fi asks before connecting, then shows You're online", { timeout: 180000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  await f.store.transaction((s) => {
    const v = s.vouchers.find((x) => x.id === "v1");
    Object.assign(v, { accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaBytes: null, usedBytes: 0, expiresAt: new Date(Date.now() + 62 * 3600e3 + 120e3).toISOString(),
      customTerms: { name: "Personal Unlimited", validityHours: 168, accessType: "personal_unlimited", deviceLimit: 2 } });
    v.wifiDevices = v.wifiDevices.slice(0, 1);
    s.wifiDeviceGrants ??= [];
    s.wifiDeviceGrants.push({ id: "g1", customerId: "c1", voucherId: "v1", mac: "AA:BB:CC:DD:EE:01", name: "Galaxy A14", status: "approved", routerRevision: routerRevision(s), approvedAt: new Date(Date.now() - 864e5).toISOString() });
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.finish.test/login", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36" });
  const cors = { "access-control-allow-origin": portal, "access-control-allow-credentials": "true" };
  let hotspot = "unauthenticated", connects = 0;
  await context.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    // The network's view of this device, and the router confirming it.
    if (u.pathname.endsWith("/api/account/connectivity")) return route.fulfill({ headers: cors, json: { version: 1, expiresAt: new Date(Date.now() + 45000).toISOString(),
      account: { state: "authenticated" }, network: { state: "confirmed" }, subscription: { state: "active" }, router: { state: "reachable" }, hotspot: { state: hotspot } } });
    if (u.pathname.endsWith("/api/account/device-management/connect")) { connects++; hotspot = "authenticated"; return route.fulfill({ headers: cors, json: { request: { id: "r1", status: "connected", completionReady: true, deviceCapabilities: { mainDeviceSupported: true } } } }); }
    if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
    return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // A saved "You're online" tab without the network's confirmation keeps the fallback.
  await page.goto(portal + "/wifi-connected.html?next=%2Fdashboard");
  await page.waitForTimeout(2500);
  assert.equal(await page.locator("#wifiOnline").isVisible(), false);
  assert.equal(await page.getByRole("heading", { name: "Finish Wi-Fi sign-in.", level: 1 }).isVisible(), true);

  // Sign in with the PIN on NDAHI Wi-Fi.
  await page.goto(portal + "/login?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.30");
  await page.locator('[name="phone"]').fill("670050001");
  await page.locator('[name="pin"]').fill("2468");
  await page.locator("#loginSubmit").click();
  await page.locator("body[data-wifi-finish]").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("step"), "finish");
  assert.equal(await text(page.locator(".wifi-finish > .eyebrow")), "SIGNED IN · ONE LAST STEP");
  assert.equal(await text(page.getByRole("heading", { level: 1 })), "Finish Wi-Fi sign-in.");
  assert.equal(await text(page.locator(".wifi-finish__lede")), "Your account is ready. Let this device use your bundle so the internet opens up.");
  assert.deepEqual(await page.locator(".wifi-finish__row").evaluateAll((rows) => rows.map((row) => row.innerText.replace(/\s+/g, " ").trim())),
    ["This device Android phone", "Bundle Personal Unlimited · 2 days 14 h left", "Device slots 1 of 2 used"]);
  assert.equal(connects, 0, "nothing connects until the customer taps");
  assert.equal(await page.getByRole("link", { name: "Not now — just view my account" }).getAttribute("href"), "/dashboard");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  // Connect this device, then "You're online" once the network confirms it.
  await page.getByRole("button", { name: "Connect this device" }).click();
  await page.locator("body[data-wifi-online]").waitFor();
  assert.equal(connects, 1);
  assert.equal(new URL(page.url()).pathname, "/wifi-connected.html");
  assert.equal(await text(page.getByRole("heading", { level: 1, name: "You're online" })), "You're online");
  assert.equal(await text(page.locator(".wifi-online__text")), "This phone now uses your bundle. You can close this page — the internet works in every app.");
  assert.equal(await text(page.locator(".wifi-online__tip")), "If you're asked to sign in again tomorrow, turn off \"Private Wi-Fi address\" for NDAHI in your Wi-Fi settings.");
  assert.equal(await page.getByRole("link", { name: "Go to my home" }).getAttribute("href"), "/dashboard");
  assert.equal(await page.locator("#wifiFallback").isVisible(), false);
  assert.deepEqual(await lowContrastText(page), []);
  assert.deepEqual(errors, []);
});
