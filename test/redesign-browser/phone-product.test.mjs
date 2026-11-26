import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The product page on phones (canvas: PhoneProduct, #410): a bar across the
// top, the photo edge to edge, the price beside a green stock pill, the
// "Needs" tile when the owner has written one (owner, 26 Nov) beside "Internet:
// Sold separately", the details as a plain disclosure, and quantity with Buy
// now on a bar at the bottom. Desktop (ProductDesktop) has no tiles. Local
// servers only, synthetic catalogue, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const product = (id, name, categoryId, stock) => ({ id, version: 1, stock, sku: id, name: { en: name, fr: name }, description: words, specifications: words, compatibility: words,
  contents: words, warranty: words, setup: words, images: [], price: 25000, cost: 1, status: "published", featured: false, categoryId });

test("the phone product page shows the drawn tiles, an edge-to-edge photo and the buy bar", { timeout: 120000 }, async (t) => {
  const secret = "redesign-phone-product", store = createStore({ persistent: false });
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "670000000", warranty: words, returns: words };
    s.storeCategories.push({ id: "outdoor", version: 1, name: { en: "Outdoor networking", fr: "Réseaux extérieurs" }, position: 0, hidden: false });
    s.storeProducts.push({ ...product("cpe210", "TP-Link CPE210", "outdoor", 6), needs: { en: "Installation + alignment", fr: "Installation + orientation" } },
      product("mini", "Wavlink Mini", "outdoor", 4));
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
  const screenshots = process.env.PHONE_PRODUCT_SCREENSHOTS || "/tmp/ndahi-phone-product";
  await mkdir(screenshots, { recursive: true });

  const open = async (width, id, lang = "en") => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, locale: lang === "fr" ? "fr-FR" : "en-GB" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    // French as an account's language preference would set it on the page.
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/dashboard#product/${id}`);
    await page.locator(".portal-shop__name").waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  };
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; });
  const tiles = (page) => page.locator(".portal-shop__facts > div").evaluateAll((nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => [node.querySelector("dt").textContent, node.querySelector("dd").textContent]));

  let { context, page, errors } = await open(390, "cpe210");
  // The bar across the top and the photo edge to edge, 250px tall.
  assert.deepEqual(await box(page.locator(".portal-shop__bar")).then(({ x, y, w }) => [x, y, w]), [0, 0, 390]);
  assert.deepEqual(await box(page.locator(".portal-shop__photo")).then(({ x, w, h }) => [x, w, h]), [0, 390, 250]);
  assert.deepEqual(await tiles(page), [["Needs", "Installation + alignment"], ["Internet", "Sold separately"]]);
  // Price and stock at either end of one row.
  const price = await box(page.locator(".portal-shop__price-row strong")), pill = await box(page.locator(".portal-shop__price-row .nd-pill"));
  assert.equal(price.x, 18);
  assert.equal(pill.x + pill.w, 372);
  // The details open from a plain line, with no chevron.
  assert.equal(await page.locator(".portal-shop__product .portal-rule__chevron").isVisible(), false);
  await page.locator(".portal-shop__product summary").click();
  assert.equal(await page.locator(".portal-shop__product details").getAttribute("open"), "");
  // Quantity and Buy now on the bottom bar.
  assert.equal((await box(page.locator(".portal-shop__buy"))).bottom, 844);
  await page.getByRole("button", { name: /more|increase/i }).click();
  assert.equal(await page.locator("#shopQty").textContent(), "2");
  assert.match(await page.locator("#shopBuy").getAttribute("href"), /#checkout\/cpe210\/2$/);
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await page.screenshot({ path: `${screenshots}/product-390.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  // No Needs line: only the Internet tile.
  ({ context, page, errors } = await open(390, "mini"));
  assert.deepEqual(await tiles(page), [["Internet", "Sold separately"]]);
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  ({ context, page, errors } = await open(390, "cpe210", "fr"));
  assert.deepEqual(await tiles(page), [["Nécessite", "Installation + orientation"], ["Internet", "Vendu séparément"]]);
  await page.screenshot({ path: `${screenshots}/product-390-fr.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  // Desktop (ProductDesktop) draws no tiles.
  ({ context, page, errors } = await open(1280, "cpe210"));
  assert.deepEqual(await tiles(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});
