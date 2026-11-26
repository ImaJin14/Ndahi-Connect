import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The product page on desktop (canvas: ProductDesktop, #415; owner 26 Nov):
// the 4:3 photo beside the details, the 40px title, the price row, quantity
// with Buy now, the pickup note and the spec table filled by the product's key
// specs from Admin, then the store's warranty and returns. Without key specs
// the product's texts show as rows. Local servers only, synthetic catalogue,
// every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const product = (id, name, categoryId, stock) => ({ id, version: 1, stock, sku: id, name: { en: name, fr: name }, description: words, specifications: words, compatibility: words,
  contents: words, warranty: words, setup: words, images: [], price: 25000, cost: 1, status: "published", featured: false, categoryId });

test("the desktop product page shows key specs as the drawn rows, and the texts when there are none", { timeout: 150000 }, async (t) => {
  const secret = "redesign-desktop-guest-product", store = createStore({ persistent: false });
  const row = (label, value) => ({ label: { en: label, fr: "" }, value: { en: value, fr: "" } });
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "670000000", warranty: { en: "WhatsApp the store with your order reference.", fr: "" }, returns: { en: "", fr: "" } };
    s.storeCategories.push({ id: "outdoor", version: 1, name: { en: "Outdoor networking", fr: "Réseaux extérieurs" }, position: 0, hidden: false });
    s.storeProducts.push({ ...product("cpe210", "TP-Link CPE210", "outdoor", 6), keySpecs: [row("Band", "2.4 GHz"), row("Antenna", "9 dBi directional"), row("Power", "Passive PoE")] },
      { ...product("mini", "Wavlink Mini", "outdoor", 4), specifications: { en: "Band: 2.4 GHz", fr: "" } });
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
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route("**/*", (route) => [api, shop].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const rows = () => page.locator(".detail-info .wide .spec-table > div").evaluateAll((nodes) => nodes.map((n) => [n.querySelector("dt").innerText, n.querySelector("dd").innerText]));

  await page.goto(shop + "/#product/cpe210");
  await page.locator("#productTitle").waitFor();
  // The photo (4:3) beside the details; the page lines up 40px in.
  const photo = await box(page.locator(".detail-media .product-visual")), info = await box(page.locator(".detail-info"));
  assert.equal(photo.x, 40);
  assert.equal(Math.round(photo.w * 3 / 4), photo.h);
  assert.equal(info.x, photo.right + 36);
  assert.equal(await page.locator("#productTitle").evaluate((el) => getComputedStyle(el).fontSize), "40px");
  assert.equal(await page.locator("#buy").innerText(), "Buy now");
  assert.match(await page.locator(".buy-note").innerText(), /Collect at Bandja Street with your order code/);
  // Key specs, then the store's warranty; no SKU or text sections.
  assert.deepEqual(await rows(), [["Band", "2.4 GHz"], ["Antenna", "9 dBi directional"], ["Power", "Passive PoE"], ["Warranty policy", "WhatsApp the store with your order reference."]]);
  assert.equal(await page.locator(".facts").isVisible(), false, "the tiles are for phones");
  assert.deepEqual(await lowContrastText(page), []);
  // No key specs yet: the product's texts as rows.
  await page.goto(shop + "/#product/mini");
  await page.locator("#productTitle", { hasText: "Wavlink Mini" }).waitFor();
  const fallback = await rows();
  assert.deepEqual(fallback[0], ["Band", "2.4 GHz"]);
  assert.ok(fallback.some(([k]) => k === "SKU"));
  assert.ok(fallback.some(([k]) => k === "Compatibility"));
  assert.deepEqual(errors, []);
  await context.close();
});
