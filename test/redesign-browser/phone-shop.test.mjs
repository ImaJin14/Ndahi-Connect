import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The Shop tab on phones (canvas: PhoneShop, #414): "My orders" beside the
// title, the category chips in one row with each category's short name (owner,
// 26 Nov; the full name when it has none, and on desktop), 80px photos, and
// the list's stock line ("Only 2 left" from two units down). Local servers
// only, synthetic catalogue, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const product = (id, name, categoryId, stock) => ({ id, version: 1, stock, sku: id, name: { en: name, fr: name }, description: words, specifications: words, compatibility: words,
  contents: words, warranty: words, setup: words, images: [], price: 25000, cost: 1, status: "published", featured: false, categoryId });

test("the phone Shop shows short chip names, My orders beside the title and the list's stock line", { timeout: 120000 }, async (t) => {
  const secret = "redesign-phone-shop", store = createStore({ persistent: false });
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
  const screenshots = process.env.PHONE_SHOP_SCREENSHOTS || "/tmp/ndahi-phone-shop";
  await mkdir(screenshots, { recursive: true });

  const open = async (width, lang = "en") => {
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
    await page.goto(`${portal}/dashboard#shop`);
    await page.locator(".portal-shop__item").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  };
  const chips = (page) => page.locator(".portal-shop__chips .nd-chip").evaluateAll((nodes) => nodes.map((node) => node.innerText.trim()));
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; });

  // Phone, English.
  let { context, page, errors } = await open(390);
  assert.deepEqual(await chips(page), ["All", "Travel", "Outdoor", "Wi-Fi devices"]);
  // Each chip's accessible name is the one label shown.
  assert.equal(await page.getByRole("button", { name: "Travel", exact: true }).count(), 1);
  // My orders sits beside the title, as drawn: 44px tall, 18px from the right edge.
  const orders = await box(page.locator(".portal-shop__orders")), title = await box(page.locator("#portalTitle"));
  assert.equal(orders.y, title.y);
  assert.equal(orders.h, 44);
  assert.equal(orders.right, 372);
  assert.equal(await page.locator(".portal-shop__orders").getAttribute("href"), "/dashboard#activity");
  // The chips stay on one row.
  const rows = await page.locator(".portal-shop__chips .nd-chip").evaluateAll((nodes) => new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().top))).size);
  assert.equal(rows, 1);
  // 80px photo boxes; the stock line, low from two units down.
  assert.deepEqual(await box(page.locator(".portal-shop__thumb").first()).then(({ w, h }) => [w, h]), [80, 80]);
  const stock = await page.locator(".portal-shop__stock").evaluateAll((nodes) => nodes.map((node) => [node.textContent, node.classList.contains("portal-shop__stock--low")]));
  assert.deepEqual(stock, [["10 in stock", false], ["6 in stock", false], ["Only 2 left", true]]);
  assert.notEqual(await page.locator(".portal-shop__stock--low").evaluate((el) => getComputedStyle(el).color), await page.locator(".portal-shop__stock").first().evaluate((el) => getComputedStyle(el).color));
  // A chip filters the list.
  await page.getByRole("button", { name: "Travel", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".portal-shop__item").length === 1);
  assert.match(await page.locator(".portal-shop__item strong").textContent(), /AX1500/);
  assert.equal(await page.getByRole("button", { name: "Travel", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".portal-shop__item").length === 3);
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await page.screenshot({ path: `${screenshots}/shop-390.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  // Phone, French: the short names in French.
  ({ context, page, errors } = await open(390, "fr"));
  assert.deepEqual(await chips(page), ["Tout", "Voyage", "Extérieur", "Appareils Wi-Fi"]);
  assert.deepEqual(await page.locator(".portal-shop__stock").evaluateAll((nodes) => nodes.map((node) => node.textContent)), ["10 en stock", "6 en stock", "Plus que 2"]);
  await page.screenshot({ path: `${screenshots}/shop-390-fr.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  // Desktop (canvas: Shop) keeps the full names.
  ({ context, page, errors } = await open(1280));
  assert.deepEqual(await chips(page), ["All", "Travel routers", "Outdoor networking", "Wi-Fi devices"]);
  await page.screenshot({ path: `${screenshots}/shop-1280.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});
