import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Checkout on phones (canvas: PhoneCheckout, #397): the drawn form with the
// account's details masked, price · Mobile Payment Fee (2%) · Total to Pay,
// the wallet notice and Pay Now on a bottom bar; then "Waiting for payment"
// (Check status, Change payment) and "Order placed" (View order, Back to
// shop). Change payment cancels the unpaid order and opens the form again
// (owner, 26 Nov). A provider this test controls; local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const product = (id, name, categoryId, stock) => ({ id, version: 1, stock, sku: id, name: { en: name, fr: name }, description: words, specifications: words, compatibility: words,
  contents: words, warranty: words, setup: words, images: [], price: 25000, cost: 1, status: "published", featured: false, categoryId });

test("phone checkout pays, changes payment and shows the placed order, as drawn", { timeout: 180000 }, async (t) => {
  const secret = "redesign-phone-checkout", store = createStore({ persistent: false });
  let providerStatus = "pending";
  const requests = [];
  const adapter = {
    configured: () => true,
    createPayment: async (p) => { requests.push({ network: p.network, payerPhone: p.payerPhone, total: p.total }); return { status: "pending", providerReference: `ref-${p.id}` }; },
    verifyPayment: async (p) => ({ status: providerStatus, amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }),
    handleWebhook: async (raw) => JSON.parse(raw),
    refundPayment: async () => ({ status: "completed", providerReference: "refund" }),
  };
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Ndahi office, Bamenda", contact: "670000000", warranty: words, returns: words };
    s.storeProducts.push(product("cpe210", "TP-Link CPE210", "", 1));
    s.storeProducts[0].price = 38000;
    s.customers.push({ id: "amina", name: "Amina Ndi", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mesomb", PAYMENT_FEE_MTN: "percent=2,on=price,round=nearest", PAYMENT_FEE_ORANGE: "percent=2,on=price,round=nearest", EMAIL_MODE: "mock",
    MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = process.env.PHONE_CHECKOUT_SCREENSHOTS || "/tmp/ndahi-phone-checkout";
  await mkdir(screenshots, { recursive: true });

  const open = async (hash, lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: lang === "fr" ? "fr-FR" : "en-GB" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/dashboard#${hash}`);
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  };
  const check = async (page, label) => {
    await page.evaluate(() => { document.activeElement?.blur(); });
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no sideways scroll: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };
  const orders = async () => (await store.snapshot()).storeOrders;
  const bottom = (locator) => locator.evaluate((el) => Math.round(el.getBoundingClientRect().bottom));

  const { context, page, errors } = await open("checkout/cpe210/1");
  await page.locator("#shopCheckout").waitFor();
  // The account's details, as drawn, and the number masked until it is used.
  assert.equal(await page.locator(".portal-shop__checkout section p").first().textContent(), "Amina N. · +237 6•• •• 12 45");
  assert.equal(await page.locator("#shopPayerMask").textContent(), "6•• •• 12 45");
  await page.locator('input[name="payerPhone"]').focus();
  assert.equal(await page.locator("#shopPayerMask").textContent(), "");
  assert.equal(await page.locator('input[name="payerPhone"]').inputValue(), "670001245");
  // The fee and total follow the network; Orange Money's wallet is named.
  await page.locator(".portal-shop__method", { hasText: "Orange Money" }).click();
  assert.deepEqual(await page.locator(".portal-shop__cost-row").evaluateAll((rows) => rows.map((row) => row.innerText.replace(/\s+/g, " ").trim())), ["Item 38,000 FCFA", "Mobile Payment Fee (2%) 760 FCFA"]);
  assert.equal(await page.locator(".portal-shop__total strong").textContent(), "38,760 FCFA");
  assert.match(await page.locator(".portal-shop__balance").textContent(), /^Ensure you have at least 38,760 FCFA in your Orange Money wallet/);
  // The bar sits at the bottom and the page doesn't scroll.
  assert.equal(await bottom(page.locator(".portal-shop__foot")), 844);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 844);
  await check(page, "checkout-390");

  // Pay Now: the waiting screen, with no back arrow.
  await page.getByRole("button", { name: "Pay Now" }).click();
  await page.locator(".portal-shop__state--wait").waitFor();
  const first = (await orders())[0];
  assert.deepEqual(requests, [{ network: "orange", payerPhone: "670001245", total: 38760 }]);
  assert.equal(await page.locator(".portal-shop__bar-title").textContent(), "Waiting for payment");
  assert.equal(await page.locator(".portal-shop__back").count(), 0);
  assert.equal(await page.locator(".portal-shop__state p").textContent(), "A Orange Money request for 38,760 FCFA (incl. 760 FCFA fee) was sent. Your device is held for you while you approve.");
  assert.match(await page.evaluate(() => location.hash), new RegExp(`^#checkout/cpe210/1/${first.id}$`));
  await check(page, "checkout-waiting-390");
  // Not approved yet.
  await page.getByRole("button", { name: "Check status" }).click();
  await page.locator("#shopCheckoutMessage", { hasText: "Not approved yet" }).waitFor();

  // Change payment: the order is cancelled, the device freed, the form back.
  await page.getByRole("button", { name: "Change payment" }).click();
  await page.locator("#shopCheckout").waitFor();
  assert.equal(await page.evaluate(() => location.hash), "#checkout/cpe210/1");
  assert.equal((await orders()).find((o) => o.id === first.id).status, "cancelled");
  // A fresh request on MTN MoMo goes through for the same, only, unit.
  await page.getByRole("button", { name: "Pay Now" }).click();
  await page.locator(".portal-shop__state--wait").waitFor();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].network, "mtn");
  const second = (await orders()).find((o) => o.id !== first.id);

  // Approved: Check status shows the placed order.
  providerStatus = "paid";
  await page.getByRole("button", { name: "Check status" }).click();
  await page.locator(".portal-shop__state--done").waitFor();
  assert.equal(await page.locator(".portal-shop__bar-title").textContent(), "Order confirmed");
  assert.equal(await page.locator(".portal-shop__state p").first().textContent(), `Order ${second.reference} is paid. We'll message you when it's ready to collect.`);
  assert.equal(await page.getByRole("link", { name: "View order" }).getAttribute("href"), `/dashboard#order/${second.id}`);
  assert.equal(await page.getByRole("link", { name: "Back to shop" }).getAttribute("href"), "/dashboard#shop");
  assert.equal(await bottom(page.locator(".portal-shop__foot")), 844);
  await check(page, "checkout-placed-390");
  // Refreshing keeps the placed screen.
  await page.reload();
  await page.locator(".portal-shop__state--done").waitFor();
  assert.deepEqual(errors, []);
  await context.close();

  // French: the placed screen.
  const fr = await open(`checkout/cpe210/1/${second.id}`, "fr");
  await fr.page.locator(".portal-shop__state--done").waitFor();
  assert.equal(await fr.page.locator(".portal-shop__state-title").textContent(), "Commande passée");
  assert.equal(await fr.page.getByRole("link", { name: "Voir la commande" }).count(), 1);
  await fr.page.screenshot({ path: `${screenshots}/checkout-placed-390-fr.png`, fullPage: true });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();
});
