import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture, guestMac } from "../helpers/wifi-pairing-fixture.mjs";
import { routerRevision } from "../../lib/device-identities.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Replace a device (#350, canvas: PhoneReplaceDevice): on the device refused
// because both slots are full, pick the device it replaces and confirm with the
// PIN; the old device's slot frees only once the router confirms; if it can't,
// nothing changes and Try again asks again; then this phone connects and the
// bundle's end date is unchanged. The router's answers are set by the test.

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

test("a device replaces another's slot, through a router failure and a retry", { timeout: 180000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  const ends = new Date(Date.now() + 3 * 864e5).toISOString();
  await f.store.transaction((s) => {
    const v = s.vouchers.find((x) => x.id === "v1");
    Object.assign(v, { accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaBytes: null, expiresAt: ends });
    v.wifiDevices = v.wifiDevices.slice(0, 1);
    s.wifiDeviceGrants ??= [];
    s.wifiDeviceGrants.push({ id: "g1", customerId: "c1", voucherId: "v1", mac: "AA:BB:CC:DD:EE:01", name: "Samsung tablet", status: "approved", routerRevision: routerRevision(s), approvedAt: new Date(Date.now() - 864e5).toISOString() },
      { id: "g2", customerId: "c1", voucherId: "v1", mac: "AA:BB:CC:DD:EE:02", name: "HP laptop", status: "approved", routerRevision: routerRevision(s), approvedAt: new Date(Date.now() - 3600e3).toISOString(), lastSeenAt: new Date(Date.now() - 2 * 3600e3).toISOString() });
    s.customers.find((c) => c.id === "c1").name = "Amina Ndi";
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.replace.test/login", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36" });
  let connects = 0;
  await context.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    // This phone's connection: the router's answer, after the old device is confirmed gone.
    if (u.pathname.endsWith("/api/account/device-management/connect")) { connects++; return route.fulfill({ headers: { "access-control-allow-origin": portal, "access-control-allow-credentials": "true" }, json: { request: { id: "r1", status: "connected", completionReady: true } } }); }
    if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
    return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
  });
  await context.addCookies([{ name: "customer_session", value: "secondary", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(portal + "/replace-device.html?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.30");

  // Pick: both slots full, this device, the two devices, the PIN.
  await page.getByRole("heading", { name: "Both device slots are in use", level: 1 }).waitFor();
  assert.equal(await text(page.locator(".replace__bar")), "NC Replace a device Signed in as Amina N. on NDAHI Wi-Fi");
  assert.equal(await text(page.locator(".replace__this")), `This device · Android phone Wi-Fi address ••:••:••:${guestMac.split(":").slice(-3).join(":")} · seen by NDAHI Wi-Fi`);
  const options = page.getByRole("radio");
  assert.deepEqual(await options.evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim())),
    ["Samsung tablet Slot 1 · ••:••:••:DD:EE:01 · online now", "HP laptop Slot 2 · ••:••:••:DD:EE:02 · offline 2 h"]);
  const start = page.locator("#replaceStart");
  assert.equal(await start.isDisabled(), true, "nothing chosen yet");
  await page.getByRole("radio", { name: /HP laptop/ }).click();
  await page.getByLabel("Confirm with your PIN").fill("2468");
  assert.equal(await text(start), "Replace HP laptop");
  assert.deepEqual(await lowContrastText(page), []);
  await start.click();

  // Moving: the old device is removed; its slot stays taken until the router confirms.
  await page.locator("h1").filter({ hasText: "Moving the slot to this phone…" }).waitFor();
  await page.locator('[data-step-state="current"]').filter({ hasText: "Router confirms it’s off" }).waitFor();
  let grant = (await f.store.snapshot()).wifiDeviceGrants.find((g) => g.id === "g2");
  assert.equal(grant.status, "revoked"); assert.equal(connects, 0, "no connection before the router confirms");
  // The router can't confirm: paused, nothing changed, safe to try again.
  await f.store.transaction((s) => { s.routerCommands.find((c) => c.id === s.wifiDeviceGrants.find((g) => g.id === "g2").revocationCommandId).status = "dead_letter"; });
  await page.locator("h1").filter({ hasText: "Replacement paused" }).waitFor();
  assert.equal(await text(page.locator(".replace__alert")), "We couldn't confirm HP laptop is disconnected. Nothing changed: it still holds the slot and this phone isn't connected. It's safe to try again.");
  assert.equal(connects, 0);
  // The retry's reply can already leave the old device out of the slots (the
  // router confirmed meanwhile); the page still names it.
  await page.route("**/api/account/device-management/replace", async (route) => {
    const response = await route.fetch(), body = await response.json();
    if (body.slots?.rows) body.slots.rows = body.slots.rows.filter((row) => row.id !== "g2");
    await route.fulfill({ response, json: body });
  }, { times: 1 });
  await page.getByRole("button", { name: "Try again" }).click();
  await page.locator("h1").filter({ hasText: "Moving the slot to this phone…" }).waitFor();
  grant = (await f.store.snapshot()).wifiDeviceGrants.find((g) => g.id === "g2");
  assert.notEqual(grant.revocationCommandId, undefined);
  // Confirmed: this phone connects.
  await f.store.transaction((s) => { const g = s.wifiDeviceGrants.find((x) => x.id === "g2"); g.revocationConfirmedAt = new Date().toISOString(); s.routerCommands.find((c) => c.id === g.revocationCommandId).status = "processed"; });
  await page.getByRole("heading", { name: "This phone is connected" }).waitFor();
  assert.equal(connects, 1);
  assert.equal(await text(page.locator(".replace__text")), "It took HP laptop's slot. HP laptop is disconnected and its saved sign-in was cleared.");
  assert.match(await text(page.locator(".replace__ends")), /^Your bundle still ends [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} at \d{2}:\d{2}\. Replacing a device never restarts or extends it\.$/);
  assert.equal((await f.store.snapshot()).vouchers.find((v) => v.id === "v1").expiresAt, ends, "the end date never moves");
  assert.equal(await page.getByRole("link", { name: "Done" }).getAttribute("href"), "/dashboard#home");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
