import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Admin Promotions (#302, canvas: AdminPromotions): the owner sets up the
// Black Friday offer (both AX1500 models, 100,000 FCFA, 45 days of Unlimited
// Home from payment, one per number), sees the preview, schedules it, then
// sees its figures and orders, and ends it early. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const words = { en: "Router", fr: "Routeur" };
const product = (id, en, stock) => ({ id, version: 1, stock, sku: id.toUpperCase(), name: { en, fr: en }, description: words, specifications: words, compatibility: words,
  contents: words, warranty: words, setup: words, images: [], price: 120000, cost: 80000, status: "published", featured: true, categoryId: "" });

test("the owner sets up, follows and ends the Black Friday promotion", { timeout: 300000 }, async (t) => {
  const secret = "redesign-promotions", store = createStore({ persistent: false });
  let now = new Date("2026-11-21T10:00:00Z");
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "WhatsApp +237671493902", warranty: words, returns: words };
    s.storeProducts.push(product("ax1500", "TP-Link AX1500 Travel Router", 6), product("ax1500-outdoor", "TP-Link AX1500 Outdoor", 4));
    s.adminUsers.push({ id: "owner", username: "owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const adapter = { configured: () => true, createPayment: async (p) => ({ status: "pending", providerReference: "ref-" + p.id }),
    verifyPayment: async (p) => ({ status: "paid", amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }) };
  const apiServer = createServer({ store, now: () => now, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret,
    SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mesomb", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock",
    OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.PROMOTIONS_SCREENSHOTS || "/tmp/ndahi-promotions";
  await mkdir(screenshots, { recursive: true });
  const open = async (width) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    return { context, page, errors };
  };
  const check = async (page, label, width) => {
    // Captures from the top, as the page is first seen (the header is sticky).
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label} at ${width}`);
    await page.screenshot({ path: `${screenshots}/${label}-${width}.png`, fullPage: true });
  };

  // Set up on a phone-sized admin.
  let { context, page, errors } = await open(390);
  await page.goto(`${admin}/dashboard#promotions`);
  await page.getByRole("heading", { name: "Promotions.", exact: true }).waitFor();
  assert.equal(await page.locator('[data-admin-nav="promotions"]').count(), 1, "in the menu under Sales");
  const form = page.locator("#promoForm");
  await form.getByLabel("Name customers see (English)").fill("Black Friday");
  await form.getByLabel("Name customers see (French)").fill("Black Friday");
  await form.getByLabel(/TP-Link AX1500 Travel Router/).check();
  await form.getByLabel(/TP-Link AX1500 Outdoor/).check();
  await form.getByLabel("Sale price (FCFA)").fill("100000");
  assert.equal(await form.getByLabel("Bundle", { exact: true }).inputValue(), "unlimited");
  assert.equal(await form.getByLabel("Lasts (days)").inputValue(), "45");
  await form.getByLabel("Starts").fill("2026-11-27T00:00");
  await form.getByLabel("Ends").fill("2026-11-30T23:59");
  await form.getByLabel("Terms (English)").fill("One per phone number. 45 days of Unlimited Home from payment.");
  await form.getByLabel("Terms (French)").fill("Un par numéro de téléphone. 45 jours d’Unlimited Home dès le paiement.");
  const card = page.locator(".admin-promo__card");
  assert.equal(await text(card.locator(".admin-promo__card-price")), "100,000 FCFA");
  assert.equal(await text(card.locator(".admin-promo__card-bonus")), "+ 45 days Unlimited Home free");
  assert.match(await text(card.locator(".admin-promo__card-ends")), /^Ends Mon 30 Nov · 10 at this price$/);
  assert.match(await text(form.locator(".admin-promo__hint").filter({ hasText: "Stock is the limit" })), /10 in stock now/);
  await check(page, "promotions-setup", 390);
  await form.getByRole("button", { name: "Schedule" }).click();
  await page.getByText("Saved — logged in the audit trail.").waitFor();
  let saved = (await store.snapshot()).storeSettings.promotions[0];
  assert.deepEqual([saved.enabled, saved.salePrice, saved.productIds, saved.perNumberLimit, saved.startsAt, saved.endsAt, saved.bonus],
    [true, 100000, ["ax1500", "ax1500-outdoor"], 1, "2026-11-26T23:00:00.000Z", "2026-11-30T22:59:00.000Z", { planId: "unlimited", validityHours: 1080, startsAt: "payment_confirmation" }]);
  assert.match(await text(page.locator(".admin-promo__live")), /Scheduled · starts Fri 27 Nov at 00:00/);
  assert.deepEqual(errors, []);
  await context.close();

  // Black Friday: one paid order, then the view while it runs.
  now = new Date("2026-11-28T09:00:00Z");
  const placed = await (await fetch(`${api}/api/store/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: "ax1500", quantity: 1,
    expectedPrice: 100000, name: "Guest", phone: "699112233", payerPhone: "699112233", network: "mtn", checkoutKey: randomUUID().replaceAll("-", "") }) })).json();
  await fetch(`${api}/api/store/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: placed.order.id, token: placed.token }) });
  ({ context, page, errors } = await open(1280));
  await page.goto(`${admin}/dashboard#promotions`);
  const live = page.locator(".admin-promo__live");
  await live.waitFor();
  assert.match(await text(live), /^BLACK FRIDAY 2 products for 100,000 FCFA \+ 45 days Unlimited Home free Live · ends in 2 d 13 h End early$/, "server time, not the browser's");
  assert.deepEqual(await page.locator(".admin-promo__metric b").allInnerTexts(), ["1", "100,000 FCFA", "0", "1", "0"]);
  assert.equal(await text(page.locator("#promoOrdersTitle").locator("xpath=..").locator("tbody tr")), `${placed.order.reference} 6•• •• 22 33 · guest Preparing Waiting for claim`);
  await check(page, "promotions-live", 1280);
  // End early.
  await live.getByRole("button", { name: "End early" }).click();
  await page.getByText("Promotion ended — logged in the audit trail.").waitFor();
  saved = (await store.snapshot()).storeSettings.promotions[0];
  assert.equal(saved.endedEarlyAt, now.toISOString());
  assert.equal(await page.locator(".admin-promo__live").count(), 0);
  assert.match(await text(page.locator("#promoAllTitle").locator("xpath=..").locator("tbody tr")), /Black Friday .* Ended Edit$/);
  const catalogue = await (await fetch(`${api}/api/store/catalogue`)).json();
  assert.equal(catalogue.products.find((p) => p.id === "ax1500").price, 120000, "the regular price is back");
  assert.deepEqual(errors, []);
  await context.close();
});
