import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture, guestMac } from "../helpers/wifi-pairing-fixture.mjs";
import { routerRevision } from "../../lib/device-identities.mjs";
import { voucherQrUrl } from "../../lib/voucher-qr.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Scan to connect (#371, canvas PhoneScanConnect; owner 27 Nov: the first name,
// time left and slots before the PIN, as drawn; names, not pronouns). The card,
// the PIN, then You're online; Join NDAHI Wi-Fi first; Someone else is signed in
// here; and full slots go to Replace a device. The router's answers are set by
// the test.

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

test("a scan shows the account's card, connects after the PIN and handles the other states", { timeout: 240000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  let qr;
  await f.store.transaction((s) => {
    const v = s.vouchers.find((x) => x.id === "v1"), c = s.customers.find((x) => x.id === "c1");
    Object.assign(v, { accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaBytes: null, usedBytes: 0, expiresAt: new Date(Date.now() + 62 * 3600e3 + 120e3).toISOString(),
      customTerms: { name: "Personal Unlimited", validityHours: 168, accessType: "personal_unlimited", deviceLimit: 2 } });
    v.wifiDevices = v.wifiDevices.slice(0, 1);
    s.wifiDeviceGrants ??= [];
    s.wifiDeviceGrants.push({ id: "g1", customerId: "c1", voucherId: "v1", mac: "AA:BB:CC:DD:EE:01", name: "Galaxy A14", status: "approved", routerRevision: routerRevision(s), approvedAt: new Date(Date.now() - 864e5).toISOString() });
    c.name = "Amina Ndi"; s.customers.find((x) => x.id === "c2").name = "Kofi Tabe";
    qr = new URLSearchParams(new URL(voucherQrUrl(v, c, portal)).hash.slice(1)).get("qr");
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.scan.test/login", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const cors = { "access-control-allow-origin": portal, "access-control-allow-credentials": "true" };
  let connectAnswer = { status: 200, json: { request: { id: "r1", status: "connecting" } } };
  const open = async (path, cookie) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/api/account/device-management/connect")) return route.fulfill({ status: connectAnswer.status, headers: cors, json: connectAnswer.json });
      if (u.pathname.endsWith("/api/wifi/pairing/status")) return route.fulfill({ headers: cors, json: { request: { id: "r1", status: "connected", completionReady: true } } });
      if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
      return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
    });
    if (cookie) await context.addCookies([{ name: "customer_session", value: cookie, domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + path);
    return { page, errors };
  };
  const onWifi = "/voucher-connect.html?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.30#qr=";

  // The card before the PIN, then Connect and You're online.
  let { page, errors } = await open(onWifi + qr);
  await page.locator("body[data-scan-state=ready]").waitFor();
  assert.equal(await text(page.getByRole("heading", { level: 1 })), "Hi Amina — confirm it's you");
  assert.equal(await text(page.locator(".scan-connect__card")), "ACTIVE · PERSONAL UNLIMITED 2 days 14 h left " + await page.locator("#bundleEnds").innerText());
  assert.match(await page.locator("#bundleEnds").innerText(), /^Ends \d{1,2} [A-Z][a-z]{2} · 1 of 2 device slots used$/);
  assert.equal(await text(page.locator(".scan-connect__foot")), "Scanning alone never connects a device.");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByLabel("Your PIN").fill("2468");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: "You're online" }).waitFor();
  assert.equal(await text(page.locator("#doneText")), "This device now uses Amina's Personal Unlimited bundle. It shows up in Amina's Devices list.");
  assert.equal(await page.getByRole("link", { name: "Done" }).getAttribute("href"), "/dashboard#home");
  assert.deepEqual(errors, []);

  // Not on NDAHI Wi-Fi yet: the steps, no PIN.
  ({ page, errors } = await open("/voucher-connect.html#qr=" + qr));
  await page.locator("body[data-scan-state=wifi]").waitFor();
  assert.equal(await text(page.getByRole("heading", { level: 1 })), "Join NDAHI Wi-Fi first");
  assert.deepEqual(await page.locator(".scan-connect__steps li").allInnerTexts(), ["Open Wi-Fi settings and join NDAHI", "Tap Open Wi-Fi sign-in below", "Come back here and tap Check again"]);
  assert.equal(await page.getByLabel("Your PIN").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "Check again" }).isVisible(), true);

  // Someone else is signed in here: both named; Stay keeps them.
  ({ page, errors } = await open(onWifi + qr, "other"));
  await page.locator("body[data-scan-state=wrong]").waitFor();
  assert.equal(await text(page.locator("#wrongText")), "This device is signed in as Kofi T. The code you scanned belongs to Amina N.");
  assert.equal(await text(page.locator("#wrongNote")), "Signing out keeps Kofi's bundle and devices safe. Kofi can sign back in any time.");
  assert.equal(await page.getByRole("link", { name: "Stay as Kofi" }).getAttribute("href"), "/dashboard#home");
  await page.getByRole("button", { name: "Sign out and continue as Amina" }).click();
  await page.locator("body[data-scan-state=ready]").waitFor();
  assert.deepEqual(errors, []);

  // Every slot full: connecting goes to Replace a device with this device's details.
  connectAnswer = { status: 409, json: { code: "DEVICE_SLOTS_FULL", error: "Both device slots are in use." } };
  ({ page, errors } = await open(onWifi + qr));
  await page.locator("body[data-scan-state=ready]").waitFor();
  await page.getByLabel("Your PIN").fill("2468");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/replace-device.html");
  assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), { mac: guestMac, address: "10.20.0.30" });
});
