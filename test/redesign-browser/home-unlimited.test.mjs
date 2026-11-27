import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture } from "../helpers/wifi-pairing-fixture.mjs";
import { routerRevision } from "../../lib/device-identities.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Home with a running Unlimited bundle (#352, canvas PhoneHome; PhoneHomeFR
// #353; owner 27 Nov): "Personal Unlimited · 7 days", Connected only while the
// network confirms this device (else Active), "2 days 14 h left · unlimited
// data", the time bar, "Ends … · 2 of 2 device slots", "Welcome back." and,
// fully online, just "Network online". A fixed-data bundle keeps its card.

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const online = (hotspot) => ({ version: 1, expiresAt: new Date(Date.now() + 45000).toISOString(), account: { state: "authenticated" }, network: { state: "confirmed" },
  subscription: { state: "active" }, router: { state: "reachable" }, hotspot: { state: hotspot } });

test("Home shows a running Unlimited bundle as drawn, Connected only while the network confirms this device", { timeout: 240000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  await f.store.transaction((s) => {
    const v = s.vouchers.find((x) => x.id === "v1");
    Object.assign(v, { accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaBytes: null, usedBytes: 3.2e9, activatedAt: new Date(Date.now() - 106 * 36e5).toISOString(),
      expiresAt: new Date(Date.now() + 62 * 36e5 + 180e3).toISOString(), customTerms: { name: "Personal Unlimited", validityHours: 168, accessType: "personal_unlimited", deviceLimit: 2 } });
    s.wifiDeviceGrants ??= [];
    for (const n of [1, 2]) s.wifiDeviceGrants.push({ id: "g" + n, customerId: "c1", voucherId: "v1", mac: `AA:BB:CC:DD:EE:0${n}`, status: "approved", routerRevision: routerRevision(s), approvedAt: new Date().toISOString() });
    s.customers.find((c) => c.id === "c1").name = "Amina Ndi";
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.home.test/login", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const cors = { "access-control-allow-origin": portal, "access-control-allow-credentials": "true" };
  const open = async ({ connectivity, lang = "en", ready = "[data-time-left]", width = 390 }) => {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/api/account/connectivity")) return connectivity ? route.fulfill({ headers: cors, json: connectivity }) : route.fulfill({ status: 503, headers: cors, json: { error: "unavailable" } });
      if (u.hostname === "www.cloudflare.com") return route.fulfill({ headers: { "content-type": "text/plain", "access-control-allow-origin": "*" }, body: "h=www.cloudflare.com\ncolo=LOS\n" });
      if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
      return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
    });
    await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => { try { localStorage.setItem("ndahi-lang", "fr"); } catch {} });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + "/dashboard#home");
    await page.locator(ready).waitFor();
    return { page, errors };
  };

  // Fully online on NDAHI Wi-Fi: Connected, and the header says just "Network online".
  let { page, errors } = await open({ connectivity: online("authenticated") });
  await page.locator(".home-unl__pill", { hasText: "Connected" }).waitFor();
  assert.equal(await text(page.locator("#portalTitle")), "Welcome back.");
  await page.locator(".network-state-banner", { hasText: "Network online" }).waitFor();
  assert.equal(await text(page.locator(".network-state-banner")), "Network online");
  assert.equal(await text(page.locator(".home-unl__kicker")), "PERSONAL UNLIMITED · 7 DAYS");
  assert.equal(await text(page.locator(".home-unl__figure")), "2 days 14 h left · unlimited data");
  assert.match(await text(page.locator(".home-unl__legend")), /^Ends [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} · \d{2}:\d{2} 2 of 2 device slots$/);
  const gone = Number(await page.locator(".home-unl__meter").getAttribute("value"));
  assert.ok(gone > 60 && gone < 65, "the bar shows the time gone: " + gone);
  assert.equal(await page.locator("[data-remaining-data]").count(), 0, "no data-left figure");
  assert.deepEqual(await lowContrastText(page), []);
  assert.deepEqual(errors, []);

  // Not confirmed on NDAHI Wi-Fi (e.g. mobile data): Active, never Connected.
  ({ page, errors } = await open({ connectivity: online("unauthenticated") }));
  await page.waitForTimeout(800);
  assert.equal(await text(page.locator(".home-unl__pill")), "Active");

  // French, as PhoneHomeFR draws it.
  ({ page, errors } = await open({ connectivity: online("authenticated"), lang: "fr" }));
  await page.locator(".home-unl__pill", { hasText: "Connecté" }).waitFor();
  assert.equal(await text(page.locator(".home-unl__figure")), "2 j 14 h restants · données illimitées");
  assert.match(await text(page.locator(".home-unl__legend")), /^Se termine [a-z]{3,4}\. \d{1,2} [a-zéû]{3,5}\.? 2 appareils sur 2$/);
  assert.equal(await text(page.locator(".network-state-banner")), "Réseau en ligne");
  assert.deepEqual(errors, []);

  // Desktop (Main, #354): "Active bundle" over the plan's name, the end beside
  // the time left, and the tiles, with the week's recorded usage.
  await f.store.transaction((s) => { const day = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString("en-CA", { timeZone: "Africa/Douala" });
    s.vouchers.find((x) => x.id === "v1").usageDays = { [day(0)]: 1e9, [day(3)]: 8e8, [day(12)]: 5e9 }; });
  ({ page, errors } = await open({ connectivity: online("authenticated"), width: 1280 }));
  await page.locator(".home-unl__pill", { hasText: "Connected" }).waitFor();
  assert.match(await text(page.locator("#portalEyebrow")), /^[A-Z]+DAY, \d{1,2} [A-Z]+$/, "the date as drawn (Tuesday, 10 November)");
  assert.equal(await text(page.locator("#portalTitle")), "Welcome back.");
  assert.equal(await text(page.locator(".home-unl__eyebrow")), "ACTIVE BUNDLE");
  assert.equal(await text(page.locator(".home-unl__plan")), "Personal Unlimited");
  assert.match(await text(page.locator(".home-unl__ends")), /^Ends [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} · \d{2}:\d{2}$/);
  const tiles = await page.locator(".home-unl__tile").evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
  assert.deepEqual(tiles.slice(0, 2), ["2 of 2 Device slots used", "1.8 GB Used this week"]);
  assert.match(tiles[2], /^\d{1,2} [A-Z][a-z]{2} Validity ends$/);
  assert.equal(await page.locator(".home-unl__legend").isVisible(), false, "the phone legend gives way to the tiles");
  assert.equal(await page.locator(".network-state-banner").isVisible(), false, "the top bar says Network online");
  assert.deepEqual(await lowContrastText(page), []);
  assert.deepEqual(errors, []);

  // A fixed-data bundle keeps its own card (data left), unchanged.
  await f.store.transaction((s) => { const v = s.vouchers.find((x) => x.id === "v1"); Object.assign(v, { accessType: null, quotaBytes: 5e9, usedBytes: 1.8e9 }); delete v.customTerms; });
  ({ page, errors } = await open({ connectivity: online("authenticated"), ready: "[data-remaining-data]" }));
  assert.equal(await page.locator(".home-unl").count(), 0);
});
