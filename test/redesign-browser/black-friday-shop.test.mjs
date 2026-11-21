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

// The Black Friday offer for shoppers (#302, canvas: StorePromo,
// PhonePromoBuy). Before it starts, the portal Home and the store count down
// to it on the server's clock (owner, 21 Nov). While it runs: the badge, the
// sale price, the free 45 days, what is left, terms, one per number, the
// checkout line and how the free days arrive, and a guest's order with the
// code to claim them. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const words = { en: "Router", fr: "Routeur" };
const product = (id, en, stock) => ({ id, version: 1, stock, sku: id.toUpperCase(), name: { en, fr: en }, description: { en: "Dual-band Wi-Fi 6 router.", fr: "Routeur Wi-Fi 6." }, specifications: words,
  compatibility: words, contents: words, warranty: words, setup: words, images: [], price: 120000, cost: 80000, status: "published", featured: true, categoryId: "" });

test("shoppers see the Black Friday countdown, the offer and their free 45 days", { timeout: 300000 }, async (t) => {
  const secret = "redesign-black-friday", store = createStore({ persistent: false });
  let now = new Date("2026-11-21T10:00:00Z");
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "WhatsApp +237671493902", hours: "Mon–Sat 9:00–18:00", warranty: words, returns: words,
      promotions: [{ id: "black-friday", enabled: true, version: 1, name: { en: "Black Friday", fr: "Black Friday" }, terms: { en: "One per phone number. While stocks last.", fr: "Un par numéro." },
        productIds: ["ax1500", "ax1500-outdoor"], salePrice: 100000, perNumberLimit: 1, startsAt: "2026-11-26T23:00:00.000Z", endsAt: "2026-11-30T23:00:00.000Z",
        bonus: { planId: "unlimited", validityHours: 1080, startsAt: "payment_confirmation" } }] };
    s.storeProducts.push(product("ax1500", "TP-Link AX1500 Travel Router", 6), product("ax1500-outdoor", "TP-Link AX1500 Outdoor", 4), product("cable", "Network cable", 9));
    s.storeProducts[2].price = 2000;
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.vouchers.push({ id: "weekly", customerId: "amina", planId: "weekly", code: "NC-AMNA-0001", status: "active", activatedAt: "2026-11-20T10:00:00.000Z",
      expiresAt: "2026-12-30T10:00:00.000Z", quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1, routerSyncStatus: "synchronized" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const storeServer = await listen(createStaticServer("store", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`, shop = `http://127.0.0.1:${storeServer.address().port}`;
  const adapter = { configured: () => true, createPayment: async (p) => ({ status: "pending", providerReference: "ref-" + p.id }),
    verifyPayment: async (p) => ({ status: "paid", amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }) };
  const apiServer = createServer({ store, now: () => now, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal, STORE_APP_URL: shop, PAYMENT_MODE: "mesomb", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); await close(storeServer); });
  const screenshots = process.env.BLACK_FRIDAY_SCREENSHOTS || "/tmp/ndahi-black-friday";
  await mkdir(screenshots, { recursive: true });
  const open = async (width, signedIn, session = "amina") => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, portal, shop].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([...(signedIn ? [{ name: "customer_session", value: session, url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }] : []),
      { name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { context, page, errors };
  };
  const check = async (page, label) => {
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };
  const cells = (locator) => locator.locator("[data-unit]").allInnerTexts();

  // Five and a half days before: the portal Home counts down to the start.
  let { context, page, errors } = await open(390, true);
  await page.goto(`${portal}/dashboard`);
  const home = page.locator("#homePromo .portal-promo");
  await home.waitFor();
  assert.match(await text(home), /^BLACK FRIDAY STARTS IN 100,000 FCFA \+ 45 days of Unlimited Home free\. TP-Link AX1500 Travel Router or TP-Link AX1500 Outdoor/);
  const [days, hours] = await cells(home);
  assert.equal(days, "05", "5 days 13 hours to go on the server's clock, whatever the phone's");
  assert.ok(["13", "12"].includes(hours), hours);
  assert.match(await text(home.locator(".portal-promo__fine")), /^Starts Fri 27 Nov · 1 per phone number$/);
  assert.equal(await home.getByRole("link", { name: "Look in the Shop" }).getAttribute("href"), "/dashboard#shop");
  await check(page, "portal-home-countdown-390");
  assert.deepEqual(errors, []);
  await context.close();
  // The store counts down too, at the regular price for now.
  ({ context, page, errors } = await open(1280, false));
  await page.goto(`${shop}/`);
  const hero = page.locator(".promo-hero");
  await hero.waitFor();
  assert.match(await text(hero), /Starts Fri 27 Nov · 00:00/);
  assert.equal(await text(hero.locator(".promo-hero__when")), "STARTS IN");
  assert.equal((await cells(hero))[0], "05");
  assert.match(await text(page.locator(".product").filter({ hasText: "TP-Link AX1500 Travel Router" })), /120,000 FCFA/);
  await check(page, "store-countdown-1280");
  assert.deepEqual(errors, []);
  await context.close();

  // Black Friday, Saturday 10:00 in Douala. A week on, Amina signs in again.
  now = new Date("2026-11-28T09:00:00Z");
  await store.transaction((s) => { s.dashboardSessions.push({ id: "sess-2", customerId: "amina", tokenHash: hashSecret("amina-2", secret), csrfToken: "csrf-2", expiresAt: "2099-01-01T00:00:00.000Z" }); });
  ({ context, page, errors } = await open(390, true, "amina-2"));
  await page.goto(`${portal}/dashboard#shop`);
  const row = page.locator(".portal-shop__item--promo").filter({ hasText: "TP-Link AX1500 Travel Router" });
  await row.waitFor();
  assert.match(await text(row), /BLACK FRIDAY TP-Link AX1500 Travel Router 100,000 FCFA \+ 45 days Unlimited Home free 6 left at this price/);
  assert.equal(await text(page.locator("#shopPanel .portal-promo__when")), "ENDS IN");
  await row.click();
  await page.locator(".portal-promo__gift").waitFor();
  assert.match(await text(page.locator(".portal-promo__strip")), /^BLACK FRIDAY Ends Mon 30 Nov · 2 d 1[34] h left$/);
  assert.equal(await text(page.locator(".portal-promo__gift")), "+ 45 days of Unlimited Home, free Unlimited data, fair use · up to 6 devices · starts on your account when your payment is confirmed");
  assert.equal(await text(page.locator("#shopBuy")), "Get the deal · 100,000 FCFA");
  assert.equal(await text(page.locator(".portal-promo__limit")), "1 per phone number");
  assert.equal(await page.locator('[data-shop-qty="1"]').getAttribute("data-max"), "1", "one per number");
  assert.equal(await page.locator('[data-shop-qty="1"]').isDisabled(), true);
  await check(page, "portal-product-390");
  await page.locator("#shopBuy").click();
  await page.locator("#shopCheckout").waitFor();
  assert.match(await text(page.locator("#shopCost")), /^Item 100,000 FCFA \+ 45 days Unlimited Home Free /);
  assert.equal(await text(page.locator(".portal-promo__note")), "The 45 days start on your account when your payment is confirmed. A bundle already running pauses and carries on after them.");
  await check(page, "portal-checkout-390");
  assert.deepEqual(errors, []);
  await context.close();

  // The public store: the offer card, then a guest buys one.
  ({ context, page, errors } = await open(1280, false));
  await page.goto(`${shop}/`);
  await page.locator(".promo-hero").waitFor();
  assert.equal(await text(page.locator(".promo-hero__when")), "ENDS IN");
  const card = page.locator(".product--promo").filter({ hasText: "TP-Link AX1500 Travel Router" });
  assert.match(await text(card), /BLACK FRIDAY .*TP-Link AX1500 Travel Router \+ 45 days Unlimited Home free 100,000 FCFA 6 left at this price Get the deal/);
  assert.match(await text(page.locator(".product").filter({ hasText: "Network cable" })), /2,000 FCFA/);
  await check(page, "store-live-1280");
  await context.close();
  ({ context, page, errors } = await open(390, false));
  await page.goto(`${shop}/#product/ax1500`);
  await page.locator(".promo-gift").waitFor();
  assert.equal(await text(page.locator("#buy")), "Get the deal · 100,000 FCFA");
  assert.equal(await page.locator('[data-step="1"]').isDisabled(), true, "one per number");
  assert.equal(await page.getByText("Internet service is purchased separately", { exact: false }).count(), 0, "the 45 days are included");
  await check(page, "store-product-390");
  await page.locator("#buy").click();
  await page.locator("#checkoutForm").waitFor();
  assert.match(await text(page.locator("#checkoutCost")), /\+ 45 days Unlimited Home Free/);
  assert.match(await text(page.locator(".promo-note")), /^The 45 days are reserved for the Mobile Money number that pays/);
  await context.close();
  // A guest order, paid: its free days wait for the number, with the code.
  const placed = await (await fetch(`${api}/api/store/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: "ax1500", quantity: 1,
    expectedPrice: 100000, name: "Guest", phone: "699112233", payerPhone: "699112233", network: "mtn", checkoutKey: randomUUID().replaceAll("-", "") }) })).json();
  await fetch(`${api}/api/store/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: placed.order.id, token: placed.token }) });
  ({ context, page, errors } = await open(390, false));
  await page.goto(`${shop}/#order/${encodeURIComponent(placed.order.id)}/${encodeURIComponent(placed.token)}`);
  const bonus = page.locator(".promo-order");
  await bonus.waitFor();
  const code = (await store.snapshot()).storeOrders.find((o) => o.id === placed.order.id).bonus.code;
  assert.match(await text(bonus), new RegExp(`^45 days of Unlimited Home: reserved for 6•• •• 22 33 until \\w{3} 12 Jan\\. Code ${code} Claim them`));
  assert.equal(await bonus.getByRole("link", { name: "Claim my free days" }).getAttribute("href"), `${portal}/login?claim=${encodeURIComponent(code)}`);
  await check(page, "store-order-guest-390");
  assert.deepEqual(errors, []);
  await context.close();
});
