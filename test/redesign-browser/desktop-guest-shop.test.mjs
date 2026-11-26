import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The public store on desktop (canvas: StoreGuest, #418; owner 26 Nov): a
// 1200px page, the forest bar with the current link in lime, the board's line
// beside the three steps, no category chips, 4:3 photo cards with the price
// and stock beside View, the "Already an NDAHI customer?" banner and no
// footer. Local servers only, synthetic catalogue, every non-local request
// aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const product = (id, name, categoryId, stock) => ({ id, version: 1, stock, sku: id, name: { en: name, fr: name }, description: words, specifications: words, compatibility: words,
  contents: words, warranty: words, setup: words, images: [], price: 25000, cost: 1, status: "published", featured: false, categoryId });

test("the desktop store is drawn with its bar, hero and steps, cards and banner, and no chips or footer", { timeout: 150000 }, async (t) => {
  const secret = "redesign-desktop-guest-shop", store = createStore({ persistent: false });
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "670000000", warranty: words, returns: words };
    s.storeCategories.push(
      { id: "travel", version: 1, name: { en: "Travel routers", fr: "Routeurs de voyage" }, shortName: { en: "Travel", fr: "Voyage" }, position: 0, hidden: false },
      { id: "outdoor", version: 1, name: { en: "Outdoor networking", fr: "Réseaux extérieurs" }, position: 1, hidden: false },
      { id: "wifi", version: 1, name: { en: "Wi-Fi devices", fr: "Appareils Wi-Fi" }, position: 2, hidden: false });
    s.storeProducts.push(product("ax1500", "TP-Link AX1500 Travel Router", "travel", 10), product("cpe210", "TP-Link CPE210", "outdoor", 6),
      product("ac1200", "Wavlink AC1200", "wifi", 2), product("mini", "Wavlink Mini", "wifi", 4));
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const storeServer = await listen(createStaticServer("store", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const shop = `http://127.0.0.1:${storeServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    STORE_APP_URL: shop, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(storeServer); });
  const screenshots = process.env.DESKTOP_GUEST_SHOP_SCREENSHOTS || "/tmp/ndahi-desktop-guest-shop";
  await mkdir(screenshots, { recursive: true });
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; });

  for (const width of [1280, 768]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/*", (route) => [api, shop].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(shop + "/");
    await page.locator(".product").first().waitFor();
    assert.equal(await page.locator(".filters").isVisible(), false, "no category chips on desktop");
    assert.equal(await page.locator("footer").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(await lowContrastText(page), []);
    if (width === 1280) {
      // The 1200px page: the bar's brand and the content line up 40px in.
      assert.equal((await box(page.locator(".brand-mark"))).x, 40);
      assert.equal((await box(page.locator(".products"))).x, 40);
      assert.equal((await box(page.locator(".products"))).w, 1200);
      const current = page.locator("header nav a[data-nav=shop]");
      assert.equal(await current.getAttribute("aria-current"), "page");
      assert.equal(await current.evaluate((el) => getComputedStyle(el).color), "rgb(185, 238, 46)");
      assert.equal(await page.locator(".hero p").innerText(), "Routers and extenders we've tested on our network. Buy without an account — pay with Mobile Money and collect locally.");
      assert.match(await page.locator(".steps").innerText(), /Pick a device\s+2\s*Pay as a guest or signed in\s+3\s*Collect at Bandja Street with your code/);
      // Four cards a row; 4:3 photos; View at the foot, 18px in, level with the stock line.
      const cards = page.locator(".product");
      assert.equal(new Set(await cards.evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)))).size, 1);
      for (const card of await cards.all()) {
        const c = await box(card), photo = await box(card.locator(".product-visual")), view = await box(card.locator(".product-bottom button")), stock = await box(card.locator(".product-stock"));
        assert.equal(Math.round(photo.w * 3 / 4), photo.h);
        assert.equal(c.right - view.right, 19);
        assert.ok(c.bottom - view.bottom >= 18 && c.bottom - view.bottom <= 20, "at the foot");
        assert.ok(Math.abs(view.bottom - stock.bottom) <= 6, "beside the price and stock");
      }
      assert.equal(await page.locator(".customer-bar h2").innerText(), "Already an NDAHI customer?");
      await page.screenshot({ path: `${screenshots}/desktop-shop.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
