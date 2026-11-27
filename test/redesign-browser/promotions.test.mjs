import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
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
    seedCatalogue(s, now);
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
  // As drawn (#345; owner, 27 Nov): one name, one product, an Unlimited bundle.
  await form.getByLabel("Name customers see").fill("Black Friday");
  await form.getByLabel("Product", { exact: true }).selectOption("ax1500");
  await form.getByLabel("Sale price (FCFA)").fill("100000");
  assert.equal(await form.getByLabel("Bundle", { exact: true }).inputValue(), "unlimited-30d-1");
  assert.match(await form.getByLabel("Bundle", { exact: true }).locator("option:checked").innerText(), /^Personal Unlimited · Unlimited · 30 days · 1 device$/);
  assert.equal(await form.getByLabel("When the router is collected (recommended)").isChecked(), true);
  await form.getByLabel("Units at this price").fill("20");
  // A free month (owner, 23 Nov, #423): the bundle's 30 days, given at collection, started within 60 days.
  assert.equal(await form.getByLabel("Must be started within").inputValue(), "60");
  assert.deepEqual(await form.getByLabel("Must be started within").locator("option").allInnerTexts(), ["30 days", "60 days", "90 days"]);
  assert.match(await text(form.locator(".admin-promo__hint").filter({ hasText: "Counted from" })), /^Counted from when it's given\. The 30 days of Unlimited start when they press Start\.$/);
  assert.equal(await text(form.locator(".admin-promo__note")), "Signed-in buyers get it in their account. Guests get it reserved for the Mobile Money number that paid, and claim it with that number and the code. Recorded as a gift, not revenue. If the order is refunded, an unstarted free bundle is cancelled.");
  await form.getByLabel("Starts").fill("2026-11-27T00:00");
  await form.getByLabel("Ends").fill("2026-11-30T23:59");
  await form.getByLabel("Terms (English)").fill("1 per customer. While stocks last. Free month: Unlimited Home, start within 60 days of collecting the router. Not exchangeable for cash.");
  await form.getByLabel("Terms (French)").fill("1 par client. Dans la limite des stocks. Mois offert : Unlimited Home, à démarrer dans les 60 jours après le retrait du routeur. Non échangeable contre de l’argent.");
  const card = page.locator(".admin-promo__card");
  assert.equal(await text(card.locator(".admin-promo__card-price")), "100,000 FCFA");
  assert.equal(await text(card.locator(".admin-promo__card-bonus")), "+ 1 month Unlimited internet free");
  assert.match(await text(card.locator(".admin-promo__card-ends")), /^Ends Mon 30 Nov · 6 at this price$/, "the units or the stock, whichever is fewer");
  assert.match(await text(form.locator(".admin-promo__hint").filter({ hasText: "either runs out" })), /^6 in stock now\. Sale stops when either runs out\.$/);
  await check(page, "promotions-setup", 390);
  await form.getByRole("button", { name: "Schedule promotion" }).click();
  await page.getByText("Scheduled — goes live Fri 27 Nov at 00:00. Logged in the audit trail.").waitFor();
  let saved = (await store.snapshot()).storeSettings.promotions[0];
  assert.deepEqual([saved.enabled, saved.name, saved.salePrice, saved.productIds, saved.perNumberLimit, saved.units, saved.showWas, saved.startsAt, saved.endsAt, saved.bonus],
    [true, { en: "Black Friday", fr: "Black Friday" }, 100000, ["ax1500"], 1, 20, false, "2026-11-26T23:00:00.000Z", "2026-11-30T22:59:00.000Z",
      { bundleId: "unlimited-30d-1", validityHours: 720, startsAt: "customer_start", givenAt: "collection", startWithinDays: 60 }]);
  assert.match(await text(page.locator("#promoAllTitle").locator("xpath=..").locator("tbody tr")), /^Black Friday AX1500 · 100,000 FCFA \+ Personal Unlimited free 27 Nov – 30 Nov 0 \/ 20 Scheduled · 27 Nov$/);
  await page.locator('[data-promo-tab="live"]').click();
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
  await page.locator('[data-promo-tab="live"]').click();
  const live = page.locator(".admin-promo__live");
  await live.waitFor();
  assert.match(await text(live), /^BLACK FRIDAY AX1500 for 100,000 FCFA \+ 1 month Unlimited free Live · ends in 2 days 13 h End early$/, "server time, not the browser's");
  // Paid, not yet collected: nothing given yet; the guest's number is new to NDAHI.
  assert.deepEqual(await page.locator(".admin-promo__metric b").allInnerTexts(), ["1 / 20", "100,000 FCFA", "0", "0", "1"]);
  assert.deepEqual(await page.locator(".admin-promo__metric span").allInnerTexts(), ["units sold at this price", "promotion revenue", "free months given", "free months started", "new customers from it"]);
  assert.equal(await text(page.locator("#promoOrdersTitle").locator("xpath=..").locator("tbody tr")), `${placed.order.reference} 6•• •• 22 33 · guest Preparing Given at collection`);
  assert.equal(await page.locator("#promoOrdersTitle").locator("xpath=..").locator("tbody a").getAttribute("href"), `/dashboard#store/${placed.order.id}`);
  await check(page, "promotions-live", 1280);
  // End early.
  await live.getByRole("button", { name: "End early" }).click();
  await page.getByText("Promotion ended — logged in the audit trail.").waitFor();
  saved = (await store.snapshot()).storeSettings.promotions[0];
  assert.equal(saved.endedEarlyAt, now.toISOString());
  assert.equal(await page.locator("[data-promo-end]").count(), 0);
  assert.match(await text(page.locator("#promoAllTitle").locator("xpath=..").locator("tbody tr")), /^Black Friday .* 1 \/ 20 Ended$/);
  const catalogue = await (await fetch(`${api}/api/store/catalogue`)).json();
  assert.equal(catalogue.products.find((p) => p.id === "ax1500").price, 120000, "the regular price is back");
  assert.deepEqual(errors, []);
  await context.close();

  // Collected: staff see the guest's free-month code on the order in Admin → Store (#423).
  for (const action of ["ready", "collect"]) {
    const o = (await store.snapshot()).storeOrders.find((x) => x.id === placed.order.id);
    const r = await fetch(`${api}/api/admin/store/orders/update`, { method: "POST", headers: { "content-type": "application/json", cookie: "admin_session=owner-token", "x-csrf-token": "csrf" },
      body: JSON.stringify({ id: o.id, version: o.version, action, collectionCode: o.collectionCode }) });
    assert.equal(r.status, 200, await r.text());
  }
  const code = (await store.snapshot()).storeOrders.find((x) => x.id === placed.order.id).bonus.code;
  ({ context, page, errors } = await open(1280));
  // The order's link from Promotions opens it in Store orders (#345).
  await page.goto(`${admin}/dashboard#store/${placed.order.id}`);
  const fact = page.locator(".admin-store__bonus");
  await fact.waitFor();
  assert.equal(await text(fact), `Code ${code} · reserved for 6•• •• 22 33 · start by 27 Jan`);
  assert.equal(await text(fact.locator("xpath=preceding-sibling::dt")), "Free month");
  await check(page, "store-order-free-month", 1280);
  assert.deepEqual(errors, []);
  await context.close();
});
