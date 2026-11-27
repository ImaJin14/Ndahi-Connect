import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture, mainMac } from "../helpers/wifi-pairing-fixture.mjs";
import { routerRevision } from "../../lib/device-identities.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Device slots (#349, canvas: PhoneDevices): a running Personal Unlimited
// bundle's slots on the Devices page. From a device without a slot each slot
// offers Replace and the foot is Replace a device (#350); on the phone holding
// slot 1 it is "This phone", Replace goes, and the foot shows a pairing code
// (#407). Remove asks inline with the PIN; the slot stays taken until the
// router confirms. Main-device setup and requests fold under the FAQ.

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

test("the Devices page shows a Personal Unlimited bundle's slots as drawn", { timeout: 180000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  const hoursAgo = (n) => new Date(Date.now() - n * 3600e3).toISOString();
  await f.store.transaction((s) => {
    const v = s.vouchers.find((x) => x.id === "v1");
    Object.assign(v, { accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaBytes: null, usedBytes: 0,
      customTerms: { name: "Personal Unlimited", validityHours: 168, accessType: "personal_unlimited", deviceLimit: 2 } });
    v.wifiDevices = v.wifiDevices.slice(0, 1);
    s.wifiDeviceGrants ??= [];
    s.wifiDeviceGrants.push({ id: "g1", customerId: "c1", voucherId: "v1", mac: mainMac, name: "Galaxy A14", status: "approved", routerRevision: routerRevision(s), approvedAt: hoursAgo(24) },
      { id: "g2", customerId: "c1", voucherId: "v1", mac: "AA:BB:CC:DD:EE:02", name: "HP laptop", status: "approved", routerRevision: routerRevision(s), approvedAt: hoursAgo(20), lastSeenAt: hoursAgo(2) });
    // The "main" session is the phone in slot 1; "secondary" is a browser without a slot.
    s.dashboardSessions.find((x) => x.id === "main").currentWifi = { mac: mainMac, routerRevision: routerRevision(s) };
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.slots.test/login", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const open = async (session) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
      return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
    });
    await context.addCookies([{ name: "customer_session", value: session, domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + "/dashboard#devices");
    await page.locator(".portal-slots").waitFor();
    return { page, errors };
  };

  // From a browser without a slot: both slots, Replace on each, Replace a device.
  const away = await open("secondary");
  let page = away.page;
  assert.equal(await text(page.locator("#devicesTitle")), "Device slots");
  assert.equal(await text(page.locator("#devicesCount")), "2 of 2 used");
  assert.equal(await text(page.locator(".portal-slots__lede")), "Personal Unlimited · 7 days · 2 devices. Each slot is tied to one device's Wi-Fi address when it signs in.");
  const slots = page.locator(".portal-slot");
  assert.equal(await slots.count(), 2);
  assert.match(await text(slots.nth(0)), /^SLOT 1 Galaxy A14 Online now Wi-Fi address ••:••:••:DD:EE:01 Replace Remove$/);
  assert.match(await text(slots.nth(1)), /^SLOT 2 HP laptop Offline · last seen 2 h ago Wi-Fi address ••:••:••:DD:EE:02 Replace Remove$/);
  assert.match(await slots.nth(1).getByRole("link", { name: "Replace" }).getAttribute("href"), /^\/replace-device\.html\?slot=g2(&|$)/);
  assert.equal(await text(page.locator(".portal-slots__full")), "All slots are in use. A new device can't connect, even while one of yours is off. Replace a device to move its slot. Your bundle's end date never changes.");
  assert.match(await page.getByRole("link", { name: "Replace a device", exact: true }).getAttribute("href"), /^\/replace-device\.html/);
  // The main device is set, so its controls stay folded; the old list and add bar aren't drawn.
  assert.equal(await page.locator("[data-slots-more]").evaluate((el) => el.open), false);
  assert.equal(await page.locator("#wifiDeviceList").isVisible(), false);
  assert.equal(await page.locator(".portal-devices__add").isVisible(), false);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(away.errors, []);

  // On the phone holding slot 1: "This phone", no Replace, Show a pairing code.
  const here = await open("main");
  page = here.page;
  assert.match(await text(page.locator(".portal-slot").nth(0)), /^SLOT 1 This phone Online now Wi-Fi address ••:••:••:DD:EE:01 Remove$/);
  assert.equal(await page.locator(".portal-slot").getByRole("link", { name: "Replace" }).count(), 0);
  const show = page.getByRole("button", { name: "Show a pairing code" });
  await show.click();
  await page.locator("#devicesAddHelp").waitFor();
  assert.equal(await page.locator(".portal-devices__add").isVisible(), true, "the code panel opens");
  await page.locator("[data-pairing-close]").click();
  assert.equal(await page.locator(".portal-devices__add").isVisible(), false);

  // Remove HP laptop: the inline confirm needs the PIN; Keep it cancels.
  const laptop = page.locator(".portal-slot").nth(1);
  await laptop.getByRole("button", { name: "Remove HP laptop" }).click();
  const ask = page.getByRole("alertdialog", { name: "Remove HP laptop" });
  assert.equal(await text(ask.locator("span").first()), "Remove HP laptop? It's disconnected now and its saved sign-in is cleared. The slot becomes free. Your bundle's time keeps running.");
  await ask.getByRole("button", { name: "Keep it" }).click();
  assert.equal(await ask.isVisible(), false);
  await laptop.getByRole("button", { name: "Remove HP laptop" }).click();
  await ask.getByRole("button", { name: "Remove", exact: true }).click();
  assert.equal(await text(ask.locator(".portal-slot__error")), "Enter your PIN to remove it.");
  await ask.getByLabel("Your PIN").fill("2468");
  assert.deepEqual(await lowContrastText(page), []);
  await ask.getByRole("button", { name: "Remove", exact: true }).click();
  // The slot stays taken until the router confirms the laptop is off.
  await page.locator(".portal-slot").nth(1).filter({ hasText: "Being removed — the slot frees once the router confirms" }).waitFor();
  assert.equal(await text(page.locator("#devicesCount")), "2 of 2 used");
  assert.equal((await f.store.snapshot()).wifiDeviceGrants.find((g) => g.id === "g2").status, "revoked");
  assert.deepEqual(here.errors, []);
});
