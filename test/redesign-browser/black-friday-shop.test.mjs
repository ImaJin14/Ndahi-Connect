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
// sale price, the free month, what is left, terms, one per number, the
// checkout line and how the free month arrives. The free month (owner, 23 Nov,
// #423) is given when the router is collected: a guest's order shows the code
// and the start deadline; an account holder starts it from Home, which pauses
// the bundle running. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const words = { en: "Router", fr: "Routeur" };
const product = (id, en, stock) => ({ id, version: 1, stock, sku: id.toUpperCase(), name: { en, fr: en }, description: { en: "Dual-band Wi-Fi 6 router.", fr: "Routeur Wi-Fi 6." }, specifications: words,
  compatibility: words, contents: words, warranty: words, setup: words, images: [], price: 120000, cost: 80000, status: "published", featured: true, categoryId: "" });

test("shoppers see the Black Friday countdown, the offer and their free month, then start it after collecting", { timeout: 300000 }, async (t) => {
  const secret = "redesign-black-friday", store = createStore({ persistent: false });
  let now = new Date("2026-11-21T10:00:00Z");
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "WhatsApp +237671493902", hours: "Mon–Sat 9:00–18:00", warranty: words, returns: words,
      promotions: [{ id: "black-friday", enabled: true, version: 1, name: { en: "Black Friday", fr: "Black Friday" }, terms: { en: "One per phone number. While stocks last.", fr: "Un par numéro." },
        productIds: ["ax1500", "ax1500-outdoor"], salePrice: 100000, perNumberLimit: 1, startsAt: "2026-11-26T23:00:00.000Z", endsAt: "2026-11-30T23:00:00.000Z",
        bonus: { planId: "unlimited", validityHours: 720, startsAt: "customer_start", givenAt: "collection", startWithinDays: 60 } }] };
    s.storeProducts.push(product("ax1500", "TP-Link AX1500 Travel Router", 6), product("ax1500-outdoor", "TP-Link AX1500 Outdoor", 4), product("cable", "Network cable", 9));
    s.storeProducts[2].price = 2000;
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    // Staff who hand over the router.
    s.adminUsers.push({ id: "operator", role: "operator", username: "operator", active: true });
    s.adminSessions.push({ id: "operator", userId: "operator", role: "operator", tokenHash: hashSecret("operator", secret), csrfToken: "csrf-operator", expiresAt: "2099-01-01T00:00:00Z" });
    s.vouchers.push({ id: "weekly", customerId: "amina", planId: "weekly", code: "NC-AMNA-0001", status: "active", activatedAt: "2026-11-20T10:00:00.000Z",
      expiresAt: "2026-12-30T10:00:00.000Z", quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1, routerSyncStatus: "synchronized" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const storeServer = await listen(createStaticServer("store", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`, shop = `http://127.0.0.1:${storeServer.address().port}`;
  const adapter = { configured: () => true, createPayment: async (p) => ({ status: "pending", providerReference: "ref-" + p.id }),
    verifyPayment: async (p) => ({ status: "paid", amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }) };
  const apiServer = createServer({ store, now: () => now, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret,
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
  const post = async (path, body, headers = {}) => {
    const r = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const json = await r.json();
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(json)}`);
    return json;
  };
  // Staff mark the order ready, then collected with its code.
  const collect = async (orderId) => {
    for (const action of ["ready", "collect"]) {
      const o = (await store.snapshot()).storeOrders.find((x) => x.id === orderId);
      await post("/api/admin/store/orders/update", { id: orderId, version: o.version, action, collectionCode: o.collectionCode }, { cookie: "admin_session=operator", "x-csrf-token": "csrf-operator" });
    }
  };

  // Five and a half days before: the portal Home counts down to the start.
  let { context, page, errors } = await open(390, true);
  await page.goto(`${portal}/dashboard`);
  const home = page.locator("#homePromo .portal-promo");
  await home.waitFor();
  assert.match(await text(home), /^BLACK FRIDAY STARTS IN 100,000 FCFA \+ a month of Unlimited free\. TP-Link AX1500 Travel Router or TP-Link AX1500 Outdoor/);
  assert.equal(await page.locator("#homeFreeMonth").isHidden(), true, "no free month to start yet");
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
  assert.match(await text(row), /BLACK FRIDAY TP-Link AX1500 Travel Router 100,000 FCFA \+ 1 month Unlimited free 6 left at this price/);
  assert.equal(await text(page.locator("#shopPanel .portal-promo__when")), "ENDS IN");
  await row.click();
  await page.locator(".portal-promo__gift").waitFor();
  assert.match(await text(page.locator(".portal-promo__strip")), /^BLACK FRIDAY Ends Mon 30 Nov · 2 d 1[34] h left$/);
  assert.match(await text(page.locator(".portal-promo__gift")), /^\+ 1 month Unlimited internet, free Unlimited Home · worth [\d,]+ FCFA · start it when you like$/);
  assert.equal(await text(page.locator("#shopBuy")), "Get the deal · 100,000 FCFA");
  assert.equal(await text(page.locator(".portal-promo__limit")), "1 per phone number");
  assert.equal(await page.locator('[data-shop-qty="1"]').getAttribute("data-max"), "1", "one per number");
  assert.equal(await page.locator('[data-shop-qty="1"]').isDisabled(), true);
  await check(page, "portal-product-390");
  await page.locator("#shopBuy").click();
  await page.locator("#shopCheckout").waitFor();
  assert.match(await text(page.locator("#shopCost")), /^Item 100,000 FCFA \+ 1 month Unlimited \(Unlimited Home\) Free /);
  assert.equal(await text(page.locator(".portal-promo__note")), "How you get your free month It's added to your account when you collect the router. It waits there until you press Start — even if you still have a bundle running.");
  await check(page, "portal-checkout-390");
  assert.deepEqual(errors, []);
  await context.close();

  // The public store: the offer card, then a guest buys one.
  ({ context, page, errors } = await open(1280, false));
  await page.goto(`${shop}/`);
  await page.locator(".promo-hero").waitFor();
  assert.equal(await text(page.locator(".promo-hero__when")), "ENDS IN");
  const card = page.locator(".product--promo").filter({ hasText: "TP-Link AX1500 Travel Router" });
  assert.match(await text(page.locator(".promo-hero h1")), /^TP-Link AX1500 Travel Router or TP-Link AX1500 Outdoor \+ a month of Unlimited, for 100,000 FCFA\.$/);
  assert.match(await text(page.locator(".promo-hero p").first()), /plus one month of Unlimited internet \(Unlimited Home\) free\. Start the free month whenever you like\.$/);
  assert.match(await text(card), /BLACK FRIDAY .*TP-Link AX1500 Travel Router \+ 1 month Unlimited free 100,000 FCFA 6 left at this price Get the deal/);
  assert.match(await text(page.locator(".product").filter({ hasText: "Network cable" })), /2,000 FCFA/);
  await check(page, "store-live-1280");
  await context.close();
  ({ context, page, errors } = await open(390, false));
  await page.goto(`${shop}/#product/ax1500`);
  await page.locator(".promo-gift").waitFor();
  assert.equal(await text(page.locator("#buy")), "Get the deal · 100,000 FCFA");
  assert.equal(await page.locator('[data-step="1"]').isDisabled(), true, "one per number");
  assert.equal(await page.getByText("Internet service is purchased separately", { exact: false }).count(), 0, "the free month is included");
  assert.match(await text(page.locator(".promo-gift")), /^\+ 1 month Unlimited internet, free Unlimited Home · worth [\d,]+ FCFA · start it when you like$/);
  await check(page, "store-product-390");
  await page.locator("#buy").click();
  await page.locator("#checkoutForm").waitFor();
  assert.match(await text(page.locator("#checkoutCost")), /\+ 1 month Unlimited \(Unlimited Home\) Free/);
  assert.equal(await text(page.locator(".promo-note")), "How you get your free month It's reserved for the Mobile Money number that pays. When you collect the router you get a slip with a code — claim it with that number and the code.");
  await check(page, "store-checkout-guest-390");
  await context.close();
  // A guest order, paid: nothing is given until the router is collected.
  const placed = await post("/api/store/checkout", { productId: "ax1500", quantity: 1, expectedPrice: 100000, name: "Guest", phone: "699112233", payerPhone: "699112233",
    network: "mtn", checkoutKey: randomUUID().replaceAll("-", "") });
  await post("/api/store/verify", { orderId: placed.order.id, token: placed.token });
  ({ context, page, errors } = await open(390, false));
  await page.goto(`${shop}/#order/${encodeURIComponent(placed.order.id)}/${encodeURIComponent(placed.token)}`);
  let bonus = page.locator(".promo-order");
  await bonus.waitFor();
  assert.equal(await text(bonus), "Free month: given when you collect.");
  await check(page, "store-order-guest-paid-390");
  // Collected: reserved for the paying number, with the code and the start deadline (60 days).
  await collect(placed.order.id);
  await page.reload();
  bonus = page.locator(".promo-order");
  await bonus.waitFor();
  const code = (await store.snapshot()).storeOrders.find((o) => o.id === placed.order.id).bonus.code;
  assert.match(await text(bonus), new RegExp(`^Free month: reserved for 6•• •• 22 33\\. Start it by Wed 27 Jan\\. Code ${code} Claim it in the NDAHI portal with this number and the code, then start it whenever you like\\. Claim my free month$`));
  assert.equal(await bonus.getByRole("link", { name: "Claim my free month" }).getAttribute("href"), `${portal}/login?claim=${encodeURIComponent(code)}`);
  await check(page, "store-order-guest-collected-390");
  assert.deepEqual(errors, []);
  await context.close();

  // Amina buys one in the portal; her order says the free month comes at collection.
  const amina = { cookie: "customer_session=amina-2", "x-csrf-token": "csrf-2" };
  const mine = await post("/api/account/store/checkout", { productId: "ax1500-outdoor", quantity: 1, expectedPrice: 100000, name: "Amina Nfor", phone: "670001245", payerPhone: "670001245",
    network: "mtn", checkoutKey: randomUUID().replaceAll("-", "") }, amina);
  await post("/api/account/store/verify", { orderId: mine.order.id }, amina);
  for (const width of [390, 1280]) {
    ({ context, page, errors } = await open(width, true, "amina-2"));
    await page.goto(`${portal}/dashboard#order/${encodeURIComponent(mine.order.id)}`);
    await page.locator(".portal-promo__order").waitFor();
    assert.equal(await text(page.locator(".portal-promo__order")), "Free month: given when you collect.");
    await check(page, `portal-order-paid-${width}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Collected the next day: Home offers to start it before its deadline, and says the Weekly bundle pauses.
  now = new Date("2026-11-29T09:00:00Z");
  await collect(mine.order.id);
  await store.transaction((s) => { s.dashboardSessions.push({ id: "sess-3", customerId: "amina", tokenHash: hashSecret("amina-3", secret), csrfToken: "csrf-3", expiresAt: "2099-01-01T00:00:00.000Z" }); });
  for (const width of [1280, 390]) {
    ({ context, page, errors } = await open(width, true, "amina-3"));
    await page.goto(`${portal}/dashboard`);
    const card = page.locator("#homeFreeMonth .portal-promo");
    await card.waitFor();
    assert.equal(await text(card), "Start your free month 1 month of Unlimited (Unlimited Home), free with your router. Start it by Thu 28 Jan. Your running bundle pauses and carries on after it, with the time it has left. Start now");
    await check(page, `portal-home-free-month-${width}`);
    if (width === 390) {
      await card.getByRole("button", { name: "Start now" }).click();
      await page.locator("#homeFreeMonth").waitFor({ state: "hidden" });
      const s = await store.snapshot(), free = s.vouchers.find((v) => v.promotion?.orderId === mine.order.id);
      assert.deepEqual([free.status, free.expiresAt], ["active", "2026-12-29T09:00:00.000Z"]);
      assert.equal(s.vouchers.find((v) => v.id === "weekly").status, "paused");
      await check(page, "portal-home-free-month-started-390");
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Her order now shows it running.
  ({ context, page, errors } = await open(390, true, "amina-3"));
  await page.goto(`${portal}/dashboard#order/${encodeURIComponent(mine.order.id)}`);
  await page.locator(".portal-promo__order").waitFor();
  assert.equal(await text(page.locator(".portal-promo__order")), "Free month: running on your account until Tue 29 Dec.");
  await check(page, "portal-order-started-390");
  assert.deepEqual(errors, []);
  await context.close();
});
