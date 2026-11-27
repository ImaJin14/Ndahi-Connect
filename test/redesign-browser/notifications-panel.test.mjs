import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture } from "../helpers/wifi-pairing-fixture.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Notifications as drawn in the portal (#362, canvas PhoneNotifications; owner
// 27 Nov): back, "Notifications", "Mark all read", the newest items as a plain
// list opening where they point, and "Choose which notifications you get".

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

test("the portal's notifications are the drawn list: Bundle ends tomorrow first, Mark all read, open where it points", { timeout: 240000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  await f.store.transaction((s) => {
    const v = s.vouchers.find((x) => x.id === "v1");
    Object.assign(v, { activatedAt: new Date(Date.now() - 6 * 864e5).toISOString(), expiresAt: new Date(Date.now() + 20 * 36e5).toISOString() });
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.home.test/login", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const open = async (lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
      return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
    });
    await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => { try { localStorage.setItem("ndahi-lang", "fr"); } catch {} });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + "/dashboard#home");
    await page.getByRole("button", { name: /^Notifications/ }).first().click();
    const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
    await panel.locator("[data-notification-id]").first().waitFor();
    return { page, panel, errors };
  };

  let { page, panel, errors } = await open();
  assert.equal(await panel.locator("[data-notification-view], [data-notification-category], [data-apply-filters], [data-archive], [data-page-next]").count(), 0, "no filters, dates, Archive or pages");
  const first = panel.locator("[data-notification-id]").first();
  assert.equal(await text(first.locator("h3")), "Bundle ends tomorrow");
  assert.match(await text(first.locator("p")), /^.+ ends tomorrow at \d{2}:\d{2}\. You can buy your next bundle once it ends\.$/);
  assert.match(await text(first.locator("small")), /^(\d+ h ago|\d+ min ago|Just now)$/);
  assert.equal(await first.getAttribute("href"), "/dashboard#internet");
  assert.equal(await first.locator(".notification-dot").count(), 1, "unread dot");
  assert.equal(await panel.getByRole("link", { name: "Choose which notifications you get", exact: true }).getAttribute("href"), "/dashboard#account");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await lowContrastText(page), []);

  // Mark all read clears the dots; the items stay.
  const count = await panel.locator("[data-notification-id]").count();
  await panel.getByRole("button", { name: "Mark all read", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".notification-panel--drawn .notification-unread"));
  assert.equal(await panel.locator("[data-notification-id]").count(), count);
  assert.equal(await panel.locator(".notification-dot").count(), 0);

  // An item opens where it points and closes the panel; back closes it too.
  await first.click();
  await page.waitForURL(/#internet$/);
  await panel.waitFor({ state: "hidden" });
  // The bell is on Home on phones.
  await page.locator('[data-portal-tab="home"]').click();
  await page.getByRole("button", { name: /^Notifications/ }).first().click();
  await panel.getByRole("button", { name: "Back to home", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);

  // French chrome.
  ({ page, panel, errors } = await open("fr"));
  assert.equal(await text(panel.getByRole("button", { name: "Tout marquer comme lu", exact: true })), "Tout marquer comme lu");
  assert.equal(await text(panel.locator(".notification-foot")), "Choisir les notifications que vous recevez");
  assert.deepEqual(errors, []);
});
