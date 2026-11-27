import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// A deal bought on a phone, as drawn (PhonePromoBuy, #411; owner 27 Nov): an
// account holder in the portal and a guest in the store, each through the
// drawn checkout (with Pay with and the number) to "Order placed" with the
// timeline of the router and its free month; an Unlimited free bundle (#345)
// given at payment shows its words; the regular price shows crossed out only
// after real sales at it.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();

test("a deal on a phone: checkout and order placed as drawn, for an account and a guest", { timeout: 300000 }, async (t) => {
  const secret = "redesign-promo-buy", store = createStore({ persistent: false }), now = new Date("2026-12-04T09:00:00Z");
  await store.transaction((s) => {
    storeState(s);
    seedCatalogue(s, now);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "670000000", warranty: words, returns: words,
      promotions: [{ id: "cyber", enabled: true, version: 1, name: { en: "Cyber Monday", fr: "Cyber Monday" }, terms: { en: "One per number.", fr: "Un par numéro." },
        productIds: ["ax1500"], salePrice: 100000, perNumberLimit: 1, units: 20, showWas: true, startsAt: "2026-12-03T00:00:00.000Z", endsAt: "2026-12-06T00:00:00.000Z",
        bonus: { bundleId: "unlimited-30d-1", validityHours: 720, startsAt: "customer_start", givenAt: "payment", startWithinDays: 60 } }] };
    s.storeProducts.push({ id: "ax1500", version: 1, stock: 6, sku: "AX1500", name: { en: "TP-Link AX1500 Travel Router", fr: "TP-Link AX1500 Travel Router" }, description: words,
      specifications: words, compatibility: words, contents: words, warranty: words, setup: words, images: [], price: 120000, cost: 1, status: "published", featured: false, categoryId: "" });
    // A sale at the regular price before the deal: the crossed-out price may show.
    s.storeOrders.push({ id: "earlier", productId: "ax1500", unitPrice: 120000, quantity: 1, status: "collected", contact: { phone: "655000000" }, payment: { status: "paid", payerPhone: "655000000", confirmedAt: "2026-11-20T10:00:00Z" } });
    s.customers.push({ id: "amina", name: "Amina Ndi", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const storeServer = await listen(createStaticServer("store", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`, shop = `http://127.0.0.1:${storeServer.address().port}`;
  const adapter = { configured: () => true, createPayment: async (p) => ({ status: "pending", providerReference: "ref-" + p.id }),
    verifyPayment: async (p) => ({ status: "paid", amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }) };
  const apiServer = createServer({ store, now: () => now, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal, STORE_APP_URL: shop, PAYMENT_MODE: "mesomb", PAYMENT_FEE_MTN: "percent=2,on=price,round=nearest", PAYMENT_FEE_ORANGE: "percent=2,on=price,round=nearest",
    EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); await close(storeServer); });
  const screenshots = process.env.PROMO_BUY_SCREENSHOTS || "/tmp/ndahi-promo-buy";
  await mkdir(screenshots, { recursive: true });
  const open = async (signedIn) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, portal, shop].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([...(signedIn ? [{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }] : []), { name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { context, page, errors };
  };
  const check = async (page, label) => {
    await page.evaluate(() => { document.activeElement?.blur(); });
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };

  // The store during the deal (StorePromo, #419): units in the hero and the fine print, the crossed-out price on the card.
  let { context, page, errors } = await open(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${shop}/`);
  await page.locator(".promo-hero").waitFor();
  assert.equal(await text(page.locator(".promo-hero__left")), "6 of 20 left at this price · 1 per customer");
  assert.match(await text(page.locator(".promo-hero__fine")), /^Ends Sun 6 Dec at 00:59 or when the 20 units are gone\. Free month given when your payment is confirmed; start within 60 days\./);
  assert.equal(await page.locator(".promo-hero__when").count(), 0, "no label over the countdown while it runs");
  const card = page.locator(".product--promo");
  assert.match(await text(card), /^CYBER MONDAY TP-Link AX1500 Travel Router \+ 1 month Unlimited free 100,000 FCFA120,000 6 left at this price Get deal$/);
  await check(page, "store-promo-1280");
  assert.deepEqual(errors, []);
  await context.close();

  // The account holder in the portal.
  ({ context, page, errors } = await open(true));
  await page.goto(`${portal}/dashboard#product/ax1500`);
  await page.locator(".portal-buy__price").waitFor();
  assert.equal(await text(page.locator(".portal-buy__price")), "100,000 FCFA 120,000 6 left at this price", "the regular price, crossed out after real sales at it");
  assert.equal(await page.locator(".portal-buy__price s").getAttribute("aria-label"), "Regular price 120,000 FCFA");
  await page.locator("#shopBuy").click();
  await page.locator("#shopCheckout").waitFor();
  assert.equal(await text(page.locator("#shopCost")), "TP-Link AX1500 Travel Router CYBER MONDAY 100,000 FCFA + 1 month Unlimited (Personal Unlimited) Free Mobile Payment Fee (2%) 2,000 FCFA Total to Pay 102,000 FCFA");
  assert.match(await text(page.locator(".portal-buy__how")), /^How you get your free month It's added to your account as soon as your payment is confirmed\./, "given at payment");
  await page.getByText("Orange Money", { exact: true }).click();
  assert.match(await text(page.locator("#shopNote")), /in your Orange Money wallet/);
  await check(page, "portal-checkout");
  await page.getByRole("button", { name: "Pay Now" }).click();
  await page.locator("[data-shop-check]").click();
  await page.locator(".portal-buy__timeline").waitFor();
  assert.match(await text(page.locator(".portal-buy__placed")), /^Order NS-\w+ is paid\. We'll let you know when it's ready to collect\.$/);
  assert.equal(await text(page.locator(".portal-buy__timeline")), "Your router and free month Paid · 102,000 FCFA Collect your router Show your collection code at Bandja Street Get your free month Added to your account when your payment is confirmed Start it when you're ready Within 60 days · 30 days of Unlimited from then");
  assert.match(await page.getByRole("link", { name: "Track my order" }).getAttribute("href"), /^\/dashboard#order\/[\w-]+$/);
  await check(page, "portal-placed");
  const mine = (await store.snapshot()).storeOrders.find((o) => o.customerId === "amina");
  assert.equal(mine.bonus.status, "given", "given as soon as the payment was confirmed");
  assert.deepEqual(errors, []);
  await context.close();

  // A guest in the store.
  ({ context, page, errors } = await open(false));
  await page.goto(`${shop}/#product/ax1500`);
  await page.locator("#buy").click();
  await page.locator("#checkoutForm").waitFor();
  await page.locator("#name").fill("Paul Tchami");
  await page.locator("#payerPhone").fill("690558802");
  assert.equal(await text(page.locator(".buy-collect")), "Collect at Bandja Street Paul T. · 6•• •• 88 02 · guest");
  await check(page, "store-checkout");
  await page.locator("#payButton").click();
  await page.locator("#checkStatus").click();
  await page.locator(".buy-timeline").waitFor();
  assert.equal(await text(page.locator(".buy-timeline")), "Your router and free month Paid · 102,000 FCFA Collect your router Show your collection code at Bandja Street Get your free month Reserved for 6•• •• 88 02 when your payment is confirmed Start it when you're ready Within 60 days · 30 days of Unlimited from then");
  assert.equal(await page.getByRole("link", { name: "Create an account to keep it together" }).getAttribute("href"), `${portal}/login`);
  await check(page, "store-placed");
  await page.getByRole("button", { name: "Track my order" }).click();
  await page.waitForFunction(() => location.hash.startsWith("#order/"));
  assert.deepEqual(errors, []);
  await context.close();
});
