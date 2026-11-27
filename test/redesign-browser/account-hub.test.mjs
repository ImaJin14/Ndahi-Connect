import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture } from "../helpers/wifi-pairing-fixture.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Account (#357, canvas: PhoneAccount): Security, three notification switches
// (Shop order updates is new, off until switched on), the English | Français
// control, then Home WISP router with its registration from the API, Help and
// Sign out.

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const rows = (locator) => locator.evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));

test("the phone Account is drawn with its switches, language control and router row", { timeout: 180000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  await f.store.transaction((s) => { s.customers.find((c) => c.id === "c1").name = "Amina Ndi"; });
  const assets = createStaticServer("customer", { apiUrl: f.api, env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
    return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
  });
  await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(portal + "/dashboard#account");
  const orders = page.getByRole("switch", { name: "Shop order updates" });
  await orders.and(page.locator(":enabled")).waitFor();

  const groups = page.locator(".portal-account__panel:visible");
  assert.deepEqual(await rows(page.locator("[aria-labelledby=accountSecurityGroup] .portal-account__item")), ["Change PIN ›", "Passkey sign-in Off", "Signed-in devices 2 active"]);
  assert.deepEqual(await rows(page.locator("[aria-labelledby=accountNotificationsGroup] .portal-account__item")), ["Low data alerts", "Bundle ending soon", "Shop order updates"]);
  assert.deepEqual(await page.getByRole("switch").evaluateAll((els) => els.map((el) => el.checked)), [true, false, false], "low data on, the others off until chosen");
  assert.deepEqual(await page.getByRole("group", { name: "Language" }).getByRole("button").evaluateAll((els) => els.map((el) => [el.textContent, el.getAttribute("aria-pressed")])), [["English", "true"], ["Français", "false"]]);
  assert.deepEqual(await rows(page.locator(".portal-account__panel--home .portal-account__item:visible")), ["Home WISP router Not registered", "Help & support ›", "Sign out"]);
  assert.equal(await groups.count(), 4);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  // Shop order updates is saved to the account and read back.
  await orders.check();
  const saved = async () => (await f.store.snapshot()).notificationStates.find((n) => n.id === "preferences:customer:c1")?.categories?.orders;
  for (let i = 0; i < 50 && !(await saved()); i++) await page.waitForTimeout(100);
  assert.equal(await saved(), true);

  // A registered router reads Registered; the page follows the language chosen here.
  await f.store.transaction((s) => {
    s.homeConnections ??= [];
    s.homeConnections.push({ id: "h1", customerId: "c1", status: "linked", mac: "AA:BB:CC:9C:31:E4", name: "Home router", verifiedAt: new Date().toISOString() });
    s.customers.find((c) => c.id === "c1").homeConnectionId = "h1";
  });
  await page.reload();
  await page.getByRole("switch", { name: "Shop order updates" }).and(page.locator(":enabled")).waitFor();
  assert.equal(await page.getByRole("switch", { name: "Shop order updates" }).isChecked(), true);
  assert.equal(await page.locator(".portal-account__panel--home a[href='/home-router.html']").innerText().then((s) => s.replace(/\s+/g, " ").trim()), "Home WISP router Registered");
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "Français" }).click();
  await page.waitForFunction(() => document.documentElement.lang === "fr" && document.querySelector("[data-account-lang=fr][aria-pressed=true]"));
  await page.getByRole("switch", { name: "Suivi des commandes de la boutique" }).waitFor();
  assert.equal(await page.locator(".portal-account__panel--home a[href='/home-router.html']").innerText().then((s) => s.replace(/\s+/g, " ").trim()), "Routeur Home WISP Enregistré");
  assert.deepEqual(await lowContrastText(page), []);
  assert.deepEqual(errors, []);
});

// DesktopAccount (#358): three panels; Home and help reads Home WISP router,
// Payment and package rules, Help & support, then Language as "English ·
// Français" with the other language as a link that keeps focus after the switch.
test("the desktop Account is drawn with Home and help and the Language row", { timeout: 180000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  await f.store.transaction((s) => { s.customers.find((c) => c.id === "c1").name = "Amina Ndi"; });
  const assets = createStaticServer("customer", { apiUrl: f.api, env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
    return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
  });
  await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(portal + "/dashboard#account");
  await page.getByRole("switch", { name: "Shop order updates" }).and(page.locator(":enabled")).waitFor();
  assert.deepEqual(await page.locator(".portal-account__panel:visible h3").allTextContents(), ["Security", "Notifications", "Home and help"]);
  assert.deepEqual(await rows(page.locator(".portal-account__panel--home .portal-account__item:visible")),
    ["Home WISP router Not registered", "Payment and package rules ›", "Help & support ›", "Language English · Français"]);
  assert.equal(await page.getByRole("group", { name: "Language" }).isVisible(), false, "the phone control isn't shown");
  assert.equal(await page.locator(".portal-account__signout--button").isVisible(), true);
  assert.deepEqual(await lowContrastText(page), []);
  const french = page.getByRole("button", { name: "Français" });
  await french.focus(); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.locator(".portal-account__language").filter({ hasText: /^Langue\s*English · Français$/ }).waitFor();
  const english = page.getByRole("button", { name: "English" });
  await page.waitForFunction(() => document.activeElement?.matches(".portal-account__langlink[data-account-lang=en]"));
  assert.equal(await english.evaluate((el) => el === document.activeElement), true, "focus moves to the link that switches back");
  await english.click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  assert.deepEqual(errors, []);
});
