import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The public store on phones (canvas: PhoneGuestShop, #403; owner 26 Nov): the
// forest head with the board's line (no longer Admin's Introduction), the
// short category chips in one row, rows with an 80px photo and the chevron,
// "Looking for internet packages?" at the foot and no footer. The store's
// warranty and returns texts show in each product's details instead. Local
// servers only, synthetic catalogue, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const product = (id, name, categoryId, stock) => ({ id, version: 1, stock, sku: id, name: { en: name, fr: name }, description: words, specifications: words, compatibility: words,
  contents: words, warranty: words, setup: words, images: [], price: 25000, cost: 1, status: "published", featured: false, categoryId });

test("the phone store is drawn with its head, short chips, rows and internet row, and policies move into products", { timeout: 150000 }, async (t) => {
  const secret = "redesign-phone-guest-shop", store = createStore({ persistent: false });
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "670000000", introduction: { en: "Make room for better connections.", fr: "Faites place." },
      warranty: { en: "Contact the store on WhatsApp with your order reference.", fr: "Garantie" }, returns: { en: "Unopened items can be returned within 7 days.", fr: "Retours" } };
    s.storeCategories.push(
      { id: "travel", version: 1, name: { en: "Travel routers", fr: "Routeurs de voyage" }, shortName: { en: "Travel", fr: "Voyage" }, position: 0, hidden: false },
      { id: "outdoor", version: 1, name: { en: "Outdoor networking", fr: "Réseaux extérieurs" }, shortName: { en: "Outdoor", fr: "Extérieur" }, position: 1, hidden: false },
      // No short name yet: the chip shows the full name.
      { id: "wifi", version: 1, name: { en: "Wi-Fi devices", fr: "Appareils Wi-Fi" }, position: 2, hidden: false });
    s.storeProducts.push(product("ax1500", "TP-Link AX1500 Travel Router", "travel", 10), product("cpe210", "TP-Link CPE210", "outdoor", 6), product("ac1200", "Wavlink AC1200", "wifi", 2));
    s.adminUsers.push({ id: "owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const storeServer = await listen(createStaticServer("store", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } }));
  const [shop, admin] = [storeServer, adminServer].map((s) => `http://127.0.0.1:${s.address().port}`);
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", STORE_APP_URL: shop, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock",
    OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(storeServer); await close(adminServer); });
  const screenshots = process.env.PHONE_GUEST_SHOP_SCREENSHOTS || "/tmp/ndahi-phone-guest-shop";
  await mkdir(screenshots, { recursive: true });

  const open = async (width, url) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 } });
    await context.route("**/*", (route) => [api, shop, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    return { page, errors, context };
  };
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; });

  const { page, errors, context } = await open(390, shop + "/");
  await page.locator(".product").first().waitFor();
  // The head: the board's line, not Admin's Introduction.
  assert.equal(await page.locator(".hero h1").innerText(), "Equipment for better connections.");
  assert.equal(await page.locator(".hero p").innerText(), "No account needed. Pay with Mobile Money, collect locally.");
  assert.equal(await page.getByText("Make room for better connections.").count(), 0);
  assert.equal(await page.locator("header nav a[data-nav=orders]").innerText(), "Track order");
  assert.equal(await page.locator(".header-signin").innerText(), "Sign in");
  // Short chips in one row; each keeps the full name for screen readers.
  const chips = page.locator(".filters button");
  assert.deepEqual(await chips.evaluateAll((nodes) => nodes.map((n) => n.innerText)), ["All", "Travel", "Outdoor", "Wi-Fi devices"]);
  assert.equal(await chips.nth(2).getAttribute("aria-label"), "Outdoor networking");
  assert.equal(new Set(await chips.evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)))).size, 1, "one row");
  // Rows: an 80px photo, the chevron centred at the right, the stock line.
  const row = page.locator(".product").first();
  const photo = await box(row.locator(".product-visual"));
  assert.deepEqual([photo.w, photo.h], [80, 80]);
  const card = await box(row), chevron = await box(row.locator(".product-bottom button"));
  assert.ok(Math.abs((chevron.y + chevron.h / 2) - (card.y + card.h / 2)) <= 1, "chevron centred");
  assert.equal(card.right - chevron.right, 11);
  assert.equal(await row.locator(".product-stock").innerText(), "10 in stock");
  assert.equal(await page.locator(".product").nth(2).locator(".product-stock").innerText(), "Only 2 left");
  // The internet row at the foot of the screen, and no footer.
  const internet = await box(page.locator(".internet-row"));
  assert.equal(internet.bottom, 844 - 16);
  assert.equal(await page.locator("footer").count(), 0);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${screenshots}/phone-shop.png` });
  // A chip filters; the whole row opens the product.
  await chips.nth(2).click();
  assert.equal(await page.locator(".product").count(), 1);
  await page.locator(".product").first().click({ position: { x: 150, y: 20 } });
  await page.locator("#productTitle").waitFor();
  assert.equal(await page.locator("#productTitle").innerText(), "TP-Link CPE210");
  // The store's policies are in the product's details now.
  await page.locator("details.specs > summary").click();
  const details = await page.locator("details.specs").innerText();
  assert.match(details, /Warranty policy\s+Contact the store on WhatsApp with your order reference\./);
  assert.match(details, /Returns\s+Unopened items can be returned within 7 days\./);
  assert.deepEqual(errors, []);
  await context.close();

  // Desktop keeps the full category names and has no footer either.
  const desk = await open(1280, shop + "/");
  await desk.page.locator(".product").first().waitFor();
  assert.deepEqual(await desk.page.locator(".filters button").evaluateAll((nodes) => nodes.map((n) => n.innerText)), ["All", "Travel routers", "Outdoor networking", "Wi-Fi devices"]);
  assert.equal(await desk.page.locator(".hero p").innerText(), "Routers and extenders we've tested on our network. Buy without an account — pay with Mobile Money and collect locally.");
  assert.equal(await desk.page.locator("footer").count(), 0);
  await desk.context.close();

  // Admin's store settings no longer offer an Introduction; saving keeps the stored one.
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await owner.route("**/*", (route) => [api, shop, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await owner.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
  const settings = await owner.newPage();
  settings.on("dialog", (dialog) => dialog.accept());
  await settings.goto(admin + "/dashboard#products");
  const form = settings.locator("#storeSettingsForm");
  await form.waitFor({ state: "attached" });
  assert.equal(await form.locator('[name^="introduction"]').count(), 0);
  await owner.close();
});
