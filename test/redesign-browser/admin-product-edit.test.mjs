import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { publishInitialStoreCatalogue } from "../../lib/initial-store-catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Edit product (#387, canvas: AdminProductEdit) at 1280 px, with the owner's
// decisions of 25 Nov:
// - name and description in the language chosen with EN/FR, labelled
//   "Name (English)" / "Name (Français)"; warranty follows the same switch;
// - the photo slots (main outlined) and "+ Add"; price and stock; visibility;
// - "Saved · live in the store" beside Save product;
// - More product details, Photo details and More settings stay, collapsed.
// Local servers only, synthetic data, a fixed clock (17:30 in Douala, 25 Nov).

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const now = new Date("2026-11-25T16:30:00Z");

test("Edit product edits both languages, price and visibility as drawn", { timeout: 300000 }, async (t) => {
  const secret = "redesign-admin-product-edit", store = createStore({ persistent: false });
  await publishInitialStoreCatalogue({ store, now: () => new Date("2026-11-08T08:00:00Z") });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] },
      { id: "u-operator", username: "brenda-op", displayName: "Brenda", role: "operator", active: true, passkeys: [] });
    for (const [user, token] of [["u-owner", "owner-token"], ["u-operator", "operator-token"]])
      s.adminSessions.push({ userId: user, role: user === "u-owner" ? "owner" : "operator", tokenHash: hashSecret(token, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const cpe = (await store.snapshot()).storeProducts.find((p) => p.sku === "ND-TPLINK-CPE210");
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
  const screenshots = process.env.ADMIN_PRODUCT_EDIT_SCREENSHOTS || "/tmp/ndahi-admin-product-edit";
  await mkdir(screenshots, { recursive: true });
  const open = async ({ token = "owner-token", lang = "en", width = 1280, hash = `product/${cpe.id}` } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1110 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: token, url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
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
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${admin}/dashboard#${hash}`);
    await page.locator("#storeProductForm").waitFor();
    return { page, context, errors };
  };
  const visible = (page) => page.locator("#storeProductForm .admin-pedit__panel > [data-lang]:not([hidden]) label, #storeProductForm .admin-pedit__panel > [data-lang]:not([hidden]) input, #storeProductForm .admin-pedit__panel > [data-lang]:not([hidden]) textarea")
    .evaluateAll((els) => els.map((el) => (el.matches("label") ? el.innerText : el.value).replace(/\s+/g, " ").trim()));

  const { page, context, errors } = await open();
  assert.equal(await text(page.locator("#adminBack")), "← Products");
  assert.equal(await page.locator("#adminBack").getAttribute("href"), "/dashboard#products");
  assert.equal(await text(page.locator("#adminTitle")), "TP-Link CPE210");
  assert.equal(await page.locator("#adminTitle").evaluate((el) => getComputedStyle(el).fontSize), "34px");
  assert.equal(await text(page.locator("#storeHeadProduct button")), "Save product");
  assert.deepEqual(await page.locator(".admin-pedit__h2").allInnerTexts(), ["Name and description", "Photos", "Price and stock", "Visibility"]);
  assert.deepEqual(await page.getByRole("tab").allInnerTexts(), ["EN", "FR"]);
  assert.equal(await page.getByRole("tab", { name: "EN" }).getAttribute("aria-selected"), "true");
  assert.deepEqual(await visible(page), ["Name (English)", "TP-Link CPE210", "Description (English)", cpe.description.en, "Warranty", cpe.warranty.en]);
  // No photos yet: the three drawn slots, the main one outlined, then "+ Add".
  assert.deepEqual(await page.locator("#storeImages .admin-pedit__slot").allInnerTexts(), ["Main photo", "Photo 2", "Photo 3", "+ Add"]);
  assert.equal(await page.locator("#storeImages .admin-pedit__slot").first().evaluate((el) => getComputedStyle(el).borderTopColor), "rgb(0, 59, 43)");
  assert.equal(await text(page.locator("section[aria-labelledby=productPhotosTitle] > p")), "JPG, PNG or WebP. Large images are resized.");
  assert.equal(await page.locator("#productPrice").inputValue(), "");
  assert.equal(await page.locator("#productPrice").getAttribute("placeholder"), "Price to be confirmed");
  assert.equal(await page.locator("#productSku").inputValue(), "ND-TPLINK-CPE210");
  assert.equal(await page.locator("#productCategory option:checked").innerText(), "Outdoor networking");
  assert.equal(await text(page.locator(".admin-pedit__stock")), "In stock 6 · adjust");
  assert.equal(await page.locator(".admin-pedit__stock a").getAttribute("href"), "/dashboard#products");
  assert.equal(await page.getByLabel("Show in the store").isChecked(), true);
  // Kept by the owner, collapsed.
  assert.deepEqual(await page.locator("#storeProductForm details > summary").allInnerTexts(), ["More product details", "Photo details", "More settings"]);
  assert.deepEqual(await page.locator("#storeProductForm details").evaluateAll((ds) => ds.map((d) => d.open)), [false, false, false]);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/product-edit-en.png`, fullPage: true });

  // FR by keyboard: the same fields in French, warranty included.
  await page.getByRole("tab", { name: "EN" }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: "FR" }).getAttribute("aria-selected"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.productLang), "fr");
  assert.deepEqual(await visible(page), ["Name (Français)", cpe.name.fr, "Description (Français)", cpe.description.fr, "Warranty", cpe.warranty.fr]);
  await page.locator("#product-name-fr").fill("TP-Link CPE210 extérieur");
  await page.locator("#product-warranty-fr").fill("Garantie de 12 mois");
  // A whole number of FCFA: the browser refuses a fraction before sending.
  await page.locator("#productPrice").fill("30000.5");
  assert.equal(await page.locator("#productPrice").evaluate((el) => el.checkValidity()), false);
  await page.locator("#productPrice").fill("30000");
  await page.getByRole("button", { name: "Save product" }).click();
  await page.locator("#storeSaved").filter({ hasText: "Saved · live in the store" }).waitFor();
  assert.equal(await page.locator("#storeAdminMessage").evaluate((el) => el.textContent), "", "no Saved. line above the screen");
  let saved = (await store.snapshot()).storeProducts.find((p) => p.id === cpe.id);
  assert.deepEqual([saved.name.en, saved.name.fr, saved.price, saved.warranty.fr, saved.status], ["TP-Link CPE210", "TP-Link CPE210 extérieur", 30000, "Garantie de 12 mois", "published"]);
  assert.ok((await store.snapshot()).auditLogs.some((entry) => entry.action === "store.products.save"));
  // Hidden from the store.
  await page.getByLabel("Show in the store").uncheck();
  await page.getByRole("button", { name: "Save product" }).click();
  await page.locator("#storeSaved").filter({ hasText: "Saved · hidden from the store" }).waitFor();
  saved = (await store.snapshot()).storeProducts.find((p) => p.id === cpe.id);
  assert.equal(saved.status, "draft");
  // More settings: Featured, internal cost (owner) and Delete product.
  await page.locator("#productMoreSettings > summary").click();
  assert.equal(await page.getByLabel("Featured product").count(), 1);
  assert.equal(await page.getByLabel("Internal cost (FCFA)").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Delete product" }).count(), 1);
  assert.deepEqual(errors, []);
  await context.close();

  // A new product: "New product", stock starts at 0.
  const created = await open({ hash: "product/new" });
  assert.equal(await text(created.page.locator("#adminTitle")), "New product");
  assert.equal(await text(created.page.locator("section[aria-labelledby=productPriceTitle] .admin-pedit__caption")), "Stock starts at 0; add it on Products after saving.");
  assert.deepEqual(created.errors, []);
  await created.context.close();

  // An operator edits products but never sees the internal cost.
  const operator = await open({ token: "operator-token" });
  await operator.page.locator("#productMoreSettings > summary").click();
  assert.equal(await operator.page.getByLabel("Internal cost (FCFA)").count(), 0);
  assert.deepEqual(operator.errors, []);
  await operator.context.close();

  // French.
  const fr = await open({ lang: "fr" });
  assert.equal(await text(fr.page.locator("#adminBack")), "← Produits");
  assert.deepEqual(await fr.page.locator(".admin-pedit__h2").allInnerTexts(), ["Nom et description", "Photos", "Prix et stock", "Visibilité"]);
  assert.deepEqual((await visible(fr.page)).filter((_, i) => i % 2 === 0), ["Nom (anglais)", "Description (anglais)", "Garantie"]);
  assert.deepEqual(await fr.page.locator("#storeImages .admin-pedit__slot").allInnerTexts(), ["Photo principale", "Photo 2", "Photo 3", "+ Ajouter"]);
  assert.equal(await text(fr.page.locator("#storeHeadProduct button")), "Enregistrer le produit");
  await fr.page.mouse.move(0, 0);
  await fr.page.screenshot({ path: `${screenshots}/product-edit-fr.png`, fullPage: true });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();

  // Phones: no sideways scrolling.
  const phone = await open({ width: 390 });
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await lowContrastText(phone.page), []);
  await phone.context.close();
});
