import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The product page on phones (canvas: PhoneGuestProduct, #402; owner 26 Nov):
// the bar, the 240px photo, the price with its stock pill at the row's end,
// the "Needs" tile when the owner has written one beside "Internet: Sold
// separately", "Specifications, box contents, warranty" holding the store's
// policies, and the quantity with Buy now on a bar at the bottom. Local servers
// only, synthetic catalogue, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const product = (id, name, categoryId, stock) => ({ id, version: 1, stock, sku: id, name: { en: name, fr: name }, description: words, specifications: words, compatibility: words,
  contents: words, warranty: words, setup: words, images: [], price: 25000, cost: 1, status: "published", featured: false, categoryId });

test("the phone product page shows the bar, tiles, details and the Buy now bar", { timeout: 150000 }, async (t) => {
  const secret = "redesign-phone-guest-product", store = createStore({ persistent: false });
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "670000000", warranty: { en: "WhatsApp the store with your order reference.", fr: "Garantie" }, returns: words };
    s.storeCategories.push({ id: "outdoor", version: 1, name: { en: "Outdoor networking", fr: "Réseaux extérieurs" }, position: 0, hidden: false });
    s.storeProducts.push({ ...product("cpe210", "TP-Link CPE210", "outdoor", 6), needs: { en: "Installation + alignment", fr: "Installation + alignement" } },
      product("mini", "Wavlink Mini", "outdoor", 1));
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
  const screenshots = process.env.PHONE_GUEST_PRODUCT_SCREENSHOTS || "/tmp/ndahi-phone-guest-product";
  await mkdir(screenshots, { recursive: true });
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route("**/*", (route) => [api, shop].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(shop + "/#product/cpe210");
  await page.locator("#productTitle").waitFor();
  // The bar: back, the store's name, Sign in; no store header.
  assert.equal(await page.locator("header").isVisible(), false);
  assert.equal(await page.locator(".bar-title").innerText(), "NDAHI Store");
  assert.equal(await page.locator(".bar-link").innerText(), "Sign in");
  assert.equal((await box(page.locator(".detail-media .product-visual"))).h, 240);
  // The price with its stock pill at the row's end.
  const row = await box(page.locator(".price-row")), pill = await box(page.locator(".price-row .stock"));
  assert.equal(row.right, pill.right);
  assert.equal(await page.locator(".price-row .stock").innerText(), "6 in stock");
  // The tiles: Needs (from Admin), then Internet.
  assert.deepEqual(await page.locator(".facts > div").evaluateAll((nodes) => nodes.map((n) => [n.querySelector("dt").innerText, n.querySelector("dd").innerText])),
    [["Needs", "Installation + alignment"], ["Internet", "Sold separately"]]);
  // The details hold the specifications and the store's policies.
  await page.locator("details.specs > summary").click();
  assert.equal(await page.locator("details.specs > summary").innerText(), "Specifications, box contents, warranty");
  assert.match(await page.locator("details.specs").innerText(), /Warranty policy\s+WhatsApp the store with your order reference\./);
  // Quantity and Buy now on the bar at the bottom.
  const bar = await box(page.locator(".buy-bar"));
  assert.equal(bar.bottom, 844);
  assert.equal(await page.locator("#buy").innerText(), "Buy now");
  await page.locator('[data-step="1"]').click();
  assert.equal(await page.locator("#qty").innerText(), "2");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${screenshots}/phone-product.png` });
  // Without a Needs line, only the Internet tile; Buy now opens checkout.
  await page.goto(shop + "/#product/mini");
  await page.locator("#productTitle", { hasText: "Wavlink Mini" }).waitFor();
  assert.deepEqual(await page.locator(".facts dt").evaluateAll((nodes) => nodes.map((n) => n.innerText)), ["Internet"]);
  assert.equal(await page.locator(".price-row .stock").innerText(), "Only 1 left");
  await page.locator("#buy").click();
  await page.locator("#checkoutDialog[open]").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});
