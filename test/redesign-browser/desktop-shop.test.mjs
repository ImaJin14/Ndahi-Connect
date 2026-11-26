import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The Shop tab on desktop (canvas: Shop, #417): the head with its lede and the
// outlined "My orders" beside it, the trust strip with its icons, "All devices"
// and the full category names, cards with the price and stock beside View at
// their foot, and the friends banner. Home keeps its own head action. Local
// servers only, synthetic catalogue, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const product = (id, name, categoryId, stock) => ({ id, version: 1, stock, sku: id, name: { en: name, fr: name }, description: words, specifications: words, compatibility: words,
  contents: words, warranty: words, setup: words, images: [], price: 25000, cost: 1, status: "published", featured: false, categoryId });

test("the desktop Shop is drawn with its head, strip, cards and banner", { timeout: 120000 }, async (t) => {
  const secret = "redesign-desktop-shop", store = createStore({ persistent: false });
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "670000000", warranty: words, returns: words };
    s.storeCategories.push(
      { id: "travel", version: 1, name: { en: "Travel routers", fr: "Routeurs de voyage" }, shortName: { en: "Travel", fr: "Voyage" }, position: 0, hidden: false },
      { id: "outdoor", version: 1, name: { en: "Outdoor networking", fr: "Réseaux extérieurs" }, shortName: { en: "Outdoor", fr: "Extérieur" }, position: 1, hidden: false },
      // No short name yet: the chip shows the full name.
      { id: "wifi", version: 1, name: { en: "Wi-Fi devices", fr: "Appareils Wi-Fi" }, position: 2, hidden: false });
    s.storeProducts.push(product("ax1500", "TP-Link AX1500 Travel Router", "travel", 10), product("cpe210", "TP-Link CPE210", "outdoor", 6), product("ac1200", "Wavlink AC1200", "wifi", 2));
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = process.env.DESKTOP_SHOP_SCREENSHOTS || "/tmp/ndahi-desktop-shop";
  await mkdir(screenshots, { recursive: true });

  const open = async (hash, lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: lang === "fr" ? "fr-FR" : "en-GB" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/dashboard#${hash}`);
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  };
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom), h: Math.round(r.height) }; });

  let { context, page, errors } = await open("shop");
  await page.locator(".portal-shop__item").first().waitFor();
  assert.equal(await page.locator("#portalEyebrow").innerText(), "NDAHI STORE");
  assert.equal(await page.locator("#portalLedeWide").innerText(), "Devices we have tested on our network. Internet access is bought separately in Internet.");
  // My orders beside the head, its foot on the lede's, at the right edge.
  const orders = page.locator("#portalHeadAction"), lede = await box(page.locator("#portalLedeWide")), button = await box(orders);
  assert.equal(await orders.innerText(), "My orders");
  assert.equal(await orders.getAttribute("href"), "/dashboard#activity");
  assert.ok(Math.abs(button.bottom - lede.bottom) <= 1, `My orders level with the lede (${button.bottom} vs ${lede.bottom})`);
  assert.equal(button.right, 1240);
  assert.equal(button.h, 46);
  assert.equal(await page.locator(".portal-shop__head").isVisible(), false, "the phone link is hidden");
  // The trust strip, each line with its icon.
  assert.deepEqual(await page.locator(".portal-shop__trust li").evaluateAll((items) => items.map((li) => [li.innerText, Boolean(li.querySelector("svg"))])),
    [["Pay with MTN MoMo or Orange Money", true], ["Collect at Bandja Street", true], ["Signed in — your details are filled in for you", true]]);
  assert.deepEqual(await page.locator(".portal-shop__chips .nd-chip").evaluateAll((nodes) => nodes.map((node) => node.innerText)), ["All devices", "Travel routers", "Outdoor networking", "Wi-Fi devices"]);
  // Each card: price and stock at its foot, View beside them on the right.
  for (const card of await page.locator(".portal-shop__item").all()) {
    const c = await box(card), price = await box(card.locator(".portal-shop__price")), view = await box(card.locator(".portal-shop__view"));
    assert.equal(view.right, c.right - 19, "View 18px inside the card");
    assert.ok(view.y >= price.y - 2 && view.y <= price.y + 2, "View beside the price");
    assert.ok(c.bottom - view.bottom >= 18 && c.bottom - view.bottom <= 20, "at the card's foot");
  }
  assert.equal(await page.locator(".portal-shop__friends .nd-btn").innerText(), "See the public store");
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await page.screenshot({ path: `${screenshots}/shop-1280.png`, fullPage: true });
  // Home keeps its own head action.
  await page.goto(`${portal}/dashboard#home`);
  await page.locator('#portalHeadAction:not([hidden])').waitFor();
  assert.equal(await orders.getAttribute("href"), "/dashboard#internet");
  assert.equal(await page.locator("#portalLedeWide").isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  ({ context, page, errors } = await open("shop", "fr"));
  await page.locator(".portal-shop__item").first().waitFor();
  assert.equal(await page.locator("#portalHeadAction").innerText(), "Mes commandes");
  assert.equal(await page.locator(".portal-shop__chips .nd-chip").first().innerText(), "Tous les appareils");
  await page.screenshot({ path: `${screenshots}/shop-1280-fr.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});
