import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture } from "../helpers/wifi-pairing-fixture.mjs";
import { routerRevision } from "../../lib/device-identities.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Outage Home with a running Unlimited bundle (#363, canvas PhoneOutage; owner
// 27 Nov): the plan's name alone, "No internet" in grey, the time left without
// "+ lost time", and "Ends in 2 days + lost time"; after it, "Ends in …" with
// the time added back. Home draws no "This device's Wi-Fi" panel (#352 decision).

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const at = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();

test("an outage on a running Unlimited bundle reads as drawn, and Home draws no Wi-Fi panel", { timeout: 240000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  const seed = (state) => f.store.transaction((s) => {
    const v = s.vouchers.find((x) => x.id === "v1");
    Object.assign(v, { accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaBytes: null, usedBytes: 3.2e9, activatedAt: at(-106 * 60), expiresAt: at(62 * 60 + 3),
      customTerms: { name: "Personal Unlimited", validityHours: 168, accessType: "personal_unlimited", deviceLimit: 2 } });
    s.wifiDeviceGrants ??= [];
    if (!s.wifiDeviceGrants.some((g) => g.id === "g1")) for (const n of [1, 2]) s.wifiDeviceGrants.push({ id: "g" + n, customerId: "c1", voucherId: "v1", mac: `AA:BB:CC:DD:EE:0${n}`, status: "approved", routerRevision: routerRevision(s), approvedAt: at(-60) });
    s.outages = [state === "down"
      ? { id: "o1", notify: true, showToCustomers: true, status: "live", area: "Bamenda", message: { en: "Our satellite link dropped at 14:20. We're working on it. The time you lose will be added back to your bundle." }, updates: [], startedAt: at(-40), createdAt: at(-40), nextUpdateBy: at(30) }
      : { id: "o1", notify: true, showToCustomers: true, status: "fixed", area: "Bamenda", message: { en: "Satellite link dropped." }, updates: [], startedAt: at(-180), createdAt: at(-180), fixedAt: at(-35) }];
    v.outageCredits = state === "down" ? [] : [{ outageId: "o1", hours: 3, at: at(-30) }];
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.home.test/login", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
      return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
    });
    await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + "/dashboard#home");
    await page.locator(".home-unl [data-time-left]").waitFor();
    return { page, errors };
  };

  await seed("down");
  let { page, errors } = await open();
  await page.locator(".home-outage--down").waitFor();
  assert.equal(await text(page.locator(".home-outage-line")), "Network down · Bamenda");
  assert.equal(await page.locator(".home-unl__kicker").textContent(), "Personal Unlimited", "the plan's name alone during an outage");
  assert.equal(await text(page.locator(".home-unl__pill")), "No internet");
  assert.deepEqual(await page.locator(".home-unl__pill").evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]), ["rgb(238, 240, 238)", "rgb(61, 74, 68)"]);
  assert.equal(await text(page.locator(".home-unl__figure")), "2 days 14 h left · unlimited data");
  assert.equal(await text(page.locator(".home-unl__legend span").first()), "Ends in 2 days + lost time");
  assert.match(await text(page.locator(".home-outage")), /The time you lose will be added back to your bundle\. Updated \d{2}:\d{2} by NDAHI · next update by \d{2}:\d{2}$/);
  assert.equal(await page.locator("#currentWifi").count(), 1, "the identity check stays mounted");
  assert.equal(await page.locator("#currentWifi").isVisible(), false, "Home draws no Wi-Fi panel");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);

  await seed("restored");
  ({ page, errors } = await open());
  await page.locator(".home-outage--restored").waitFor();
  assert.match(await text(page.locator(".home-outage")), /^We're back online Sorry for the interruption\. We added 3 hours to your bundle to make up for it\./);
  assert.equal(await page.locator(".home-unl__kicker").textContent(), "Personal Unlimited");
  assert.equal(await text(page.locator(".home-unl__legend span").first()), "Ends in 2 days 14 h");
  assert.deepEqual(errors, []);

  // With no outage notice, Home's card is unchanged.
  await f.store.transaction((s) => { s.outages = []; });
  ({ page } = await open());
  // textContent: innerText follows the CSS uppercase only once styles have applied.
  assert.equal(await page.locator(".home-unl__kicker").textContent(), "Personal Unlimited · 7 days");
  assert.match(await text(page.locator(".home-unl__legend span").first()), /^Ends [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} · \d{2}:\d{2}$/);
});
