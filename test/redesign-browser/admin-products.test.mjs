import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { publishInitialStoreCatalogue } from "../../lib/initial-store-catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Products and stock (#388, canvas: AdminProducts) at 1280 px, with the
// owner's decisions of 25 Nov:
// - the drawn checkout switch, which asks before changing and is audited;
// - the catalogue: product, SKU, price, − count +, Shown/Hidden, Edit;
// - stock adjustments and history, categories and store settings stay,
//   collapsed below; no search, row Delete, Refresh or View storefront.
// Local servers only, synthetic data, a fixed clock (17:30 in Douala, 25 Nov).

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const now = new Date("2026-11-25T16:30:00Z");

test("Products shows the drawn switch and catalogue, and changes stock and visibility", { timeout: 300000 }, async (t) => {
  const secret = "redesign-admin-products", store = createStore({ persistent: false });
  await publishInitialStoreCatalogue({ store, now: () => new Date("2026-11-08T08:00:00Z") });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.storeSettings = { ...s.storeSettings, open: true, contact: "NDAHI shop", pickup: "NDAHI shop, Market Road", warranty: { en: "12 months", fr: "12 mois" }, returns: { en: "14 days", fr: "14 jours" } };
    const prices = { "ND-TPLINK-AX1500": 35000, "ND-TPLINK-CPE210": 30000, "ND-WAVLINK-AC1200": 25000 };
    for (const p of s.storeProducts) p.price = prices[p.sku] ?? null;
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await listen(apiServer, apiPort);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.ADMIN_PRODUCTS_SCREENSHOTS || "/tmp/ndahi-admin-products";
  await mkdir(screenshots, { recursive: true });
  const open = async ({ lang = "en", width = 1280 } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1110 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
    await context.clock.setFixedTime(now);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] });
      set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Fonts from outside are blocked here on purpose; any other console error counts.
    page.on("console", (message) => { if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) errors.push(message.text()); });
    await page.goto(`${admin}/dashboard#products`);
    await page.locator(".admin-products__table tbody tr").first().waitFor();
    return { page, context, errors };
  };
  const rows = (page) => page.locator(".admin-products__table tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.replace(/\s+/g, " ").trim())));
  const checkout = (page) => page.getByRole("switch", { name: "Store checkout open", exact: true });

  const { page, context, errors } = await open();
  assert.equal(await text(page.locator("#adminEyebrow")), "STORE");
  assert.equal(await text(page.locator("#adminTitle")), "Products and stock.");
  assert.deepEqual(await page.locator("#storeHeadProducts a, #storeHeadProducts button").allInnerTexts(), ["Add product"], "only Add product in the head");
  assert.equal(await text(page.locator(".admin-products__banner")), "Store checkout is open Customers and guests can pay. Turn off to pause new orders.");
  assert.equal(await checkout(page).getAttribute("aria-checked"), "true");
  assert.equal(await text(page.locator("#storeCatalogueTitle")), "Catalogue");
  assert.deepEqual(await page.locator(".admin-products__table th").allInnerTexts(), ["Product", "SKU", "Price", "In stock", "Shown in store", "Edit"]);
  assert.deepEqual(await rows(page), [
    ["TP-Link AX1500 Travel Router Travel routers", "ND-TPLINK-AX1500", "35,000 FCFA", "− 10 +", "Shown", "Edit"],
    ["TP-Link CPE210 Outdoor networking", "ND-TPLINK-CPE210", "30,000 FCFA", "− 6 +", "Shown", "Edit"],
    ["Wavlink AC1200 Wi-Fi devices", "ND-WAVLINK-AC1200", "25,000 FCFA", "− 2 +", "Shown", "Edit"],
    ["Wavlink Mini Wi-Fi devices", "ND-WAVLINK-MINI", "Price to be confirmed", "− 4 +", "Shown", "Edit"],
  ]);
  // Two or fewer left reads orange, as drawn.
  assert.deepEqual(await page.locator(".admin-stepper strong").evaluateAll((els) => els.map((el) => getComputedStyle(el).color)),
    ["rgb(16, 36, 28)", "rgb(16, 36, 28)", "rgb(138, 74, 0)", "rgb(16, 36, 28)"]);
  assert.equal(await text(page.locator(".admin-products__note")), "Every stock change is recorded in the inventory ledger with who made it.");
  // Not drawn, so not built: search, row Delete, Refresh, View storefront.
  assert.equal(await page.locator("#storeSearch, [data-delete-product], #refreshStore").count(), 0);
  assert.equal(await page.getByText("View storefront").count(), 0);
  // Kept by the owner, collapsed.
  assert.deepEqual(await page.locator("details.admin-store__more > summary").allInnerTexts(), ["Stock adjustments and history", "Categories", "Store settings"]);
  assert.deepEqual(await page.locator("details.admin-store__more").evaluateAll((ds) => ds.map((d) => d.open)), [false, false, false]);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/products-en.png`, fullPage: true });

  // The switch asks first: dismissing changes nothing.
  page.once("dialog", (dialog) => dialog.dismiss());
  await checkout(page).click();
  assert.equal((await store.snapshot()).storeSettings.open, true);
  assert.equal(await checkout(page).getAttribute("aria-checked"), "true");
  // Accepted, by keyboard: closed, audited, focus kept on the switch, no extra line.
  let asked = "";
  page.once("dialog", (dialog) => { asked = dialog.message(); dialog.accept(); });
  await checkout(page).focus();
  await page.keyboard.press("Space");
  await page.locator(".admin-products__switch[aria-checked=false]").waitFor();
  assert.match(asked, /^Close checkout\?/);
  assert.equal(await text(page.locator(".admin-products__banner")), "Store checkout is closed Products stay visible but nobody can pay until you reopen.");
  assert.equal(await page.locator(".admin-products__banner").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(255, 244, 224)");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "toggleStoreCheckout");
  assert.equal(await page.locator("#storeAdminMessage").evaluate((el) => el.textContent), "");
  const snapshot = await store.snapshot();
  assert.equal(snapshot.storeSettings.open, false);
  assert.ok(snapshot.auditLogs.some((entry) => entry.action === "store.settings.save"));
  page.once("dialog", (dialog) => { asked = dialog.message(); dialog.accept(); });
  await checkout(page).click();
  await page.locator(".admin-products__switch[aria-checked=true]").waitFor();
  assert.match(asked, /^Open checkout for new purchases\?/);

  // − and +: one unit each, in the stock ledger.
  await page.getByRole("button", { name: "Add one Wavlink AC1200", exact: true }).click();
  await page.locator(".admin-stepper strong").nth(2).filter({ hasText: "3" }).waitFor();
  await page.getByRole("button", { name: "Remove one Wavlink Mini", exact: true }).click();
  await page.locator(".admin-stepper strong").nth(3).filter({ hasText: "3" }).waitFor();
  assert.deepEqual((await store.snapshot()).storeMovements.slice(0, 2).map((m) => [m.delta, m.reason]), [[-1, "Quick change on Products"], [1, "Quick change on Products"]]);
  // Shown → Hidden takes the product out of the store.
  await page.getByRole("button", { name: "Shown in store: TP-Link CPE210", exact: true }).click();
  await page.locator(".admin-shown:not(.is-on)").waitFor();
  assert.equal(await text(page.locator(".admin-shown").nth(1)), "Hidden");
  assert.equal((await store.snapshot()).storeProducts.find((p) => p.sku === "ND-TPLINK-CPE210").status, "draft");
  assert.equal(await page.locator("#storeAdminMessage").evaluate((el) => el.textContent), "");
  // Edit opens the product's page.
  await page.getByRole("link", { name: "Edit TP-Link CPE210", exact: true }).click();
  await page.locator("#storeProductForm").waitFor();
  assert.match(page.url(), /#product\//);
  assert.deepEqual(errors, []);
  await context.close();

  // Opening with a store setting missing says what to fill in and opens Store settings.
  await store.transaction((s) => { s.storeSettings.open = false; s.storeSettings.contact = ""; });
  const missing = await open();
  await checkout(missing.page).click();
  await missing.page.getByText("Fill in Store settings before opening checkout: Contact details.", { exact: true }).waitFor();
  assert.equal(await missing.page.locator("#storeSettings").evaluate((d) => d.open), true);
  assert.equal((await store.snapshot()).storeSettings.open, false);
  assert.deepEqual(missing.errors, []);
  await missing.context.close();
  await store.transaction((s) => { s.storeSettings.open = true; s.storeSettings.contact = "NDAHI shop"; });

  // French: the same screen, amounts with the space.
  const fr = await open({ lang: "fr" });
  assert.equal(await text(fr.page.locator("#adminTitle")), "Produits et stock.");
  assert.equal(await text(fr.page.locator(".admin-products__banner")), "Le paiement de la boutique est ouvert Clients et invités peuvent payer. Désactivez pour suspendre les nouvelles commandes.");
  assert.deepEqual(await fr.page.locator(".admin-products__table th").allInnerTexts(), ["Produit", "Référence", "Prix", "En stock", "Visible en boutique", "Modifier"]);
  assert.deepEqual((await rows(fr.page))[0], ["Routeur de voyage TP-Link AX1500 Routeurs de voyage", "ND-TPLINK-AX1500", "35 000 FCFA", "− 10 +", "Visible", "Modifier"]);
  await fr.page.mouse.move(0, 0);
  await fr.page.screenshot({ path: `${screenshots}/products-fr.png`, fullPage: true });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();

  // Phones: the table scrolls inside its card, never the page.
  const phone = await open({ width: 390 });
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await lowContrastText(phone.page), []);
  await phone.context.close();
});
