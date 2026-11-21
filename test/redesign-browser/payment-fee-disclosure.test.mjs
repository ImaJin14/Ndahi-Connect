import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { MockPaymentAdapter } from "../../lib/payments.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The Mobile Money fee and total before paying (#297, canvases PhoneBuyBundle,
// PhonePaymentFailed, PhoneCheckout, PhoneGuestCheckout): buy a bundle's pay step
// and waiting screen, the low-balance and check-balance failures, and both store
// checkouts, at 390 px. The fee rules are synthetic (2% MTN, 3% Orange), not
// MeSomb's rates: every number on screen comes from the server's quote.
// Screenshots: FEE_SCREENSHOTS (default /tmp/ndahi-payment-fees), English and,
// for the buy screens, French. Local servers only; every other request is aborted.

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
// fr-CM groups thousands with narrow no-break spaces: compare words, not spacing.
const words = (value) => String(value).replace(/[\s  ]+/g, " ").trim();
const text = async (locator) => words(await locator.evaluate((el) => el.innerText));
const secret = "redesign-payment-fees";
const refusals = { "670011245": "low_balance", "670012245": "low_balance", "670031245": "check_balance" };

test("customers see the price, the Mobile Money fee and the total before they pay", { timeout: 300000 }, async (t) => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c-shop", name: "Amina Nfor", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "c-shop", role: "customer", tokenHash: hashSecret("shopper", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    storeState(s);
    Object.assign(s.storeSettings, { open: true, contact: "Store desk", pickup: "NDAHI office", hours: "Monday–Saturday, 09:00–17:00",
      warranty: { en: "One year", fr: "Un an" }, returns: { en: "Contact us for returns.", fr: "Contactez-nous." } });
    s.storeProducts.push({ id: "router", version: 1, sku: "TR-1", name: { en: "Travel router", fr: "Routeur de voyage" }, description: { en: "A router.", fr: "Un routeur." },
      price: 18000, cost: 9000, stock: 4, status: "published", categoryId: "", images: [], featured: false, warranty: { en: "One year", fr: "Un an" } });
  });
  class RefusingMock extends MockPaymentAdapter {
    async createPayment(payment) {
      const code = refusals[String(payment.payerPhone).replace(/^237/, "")];
      if (code) throw Object.assign(Error("refused"), { refusal: { failureCode: code } });
      return super.createPayment(payment);
    }
  }
  const apiPort = await reservePort(), storePort = await reservePort(), api = `http://127.0.0.1:${apiPort}`, shop = `http://127.0.0.1:${storePort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const storeServer = await listen(createStaticServer("store", { apiUrl: api }), storePort);
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, payments: { mock: new RefusingMock() }, env: {
    NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal, STORE_APP_URL: shop,
    PAYMENT_MODE: "mock", PAYMENT_FEE_MTN: "percent=2", PAYMENT_FEE_ORANGE: "percent=3",
    EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await listen(apiServer, apiPort);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); await close(storeServer); });
  const screenshots = process.env.FEE_SCREENSHOTS || "/tmp/ndahi-payment-fees";
  await mkdir(screenshots, { recursive: true });

  // lang: the buy page in French (it is English-only today, so the test sets the
  // document language the way the Account preference does on Home).
  const open = async ({ lang = "en", signedIn = false } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, portal, shop].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    // The page's own scripts read the document language (shared/ui/dom.js currentLanguage).
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] });
      set();
    });
    await context.addCookies([{ name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" },
      ...(signedIn ? [{ name: "customer_session", value: "shopper", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }] : [])]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { context, page, errors };
  };
  // The plan list behind the checkout carries deliberately invisible overlay
  // buttons, so it is hidden for the contrast check (as payment-failed.test does).
  const check = async (page, label) => {
    await page.evaluate(() => { const behind = document.getElementById("pageContent"); if (behind && !document.getElementById("checkout")?.hidden) behind.style.display = "none"; });
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    await page.evaluate(() => { const behind = document.getElementById("pageContent"); if (behind) behind.style.display = ""; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png` });
  };
  const startCheckout = async (page, phone) => {
    await page.goto(`${portal}/onboarding.html`);
    await page.locator('#plans button[data-plan="weekly"]:not([disabled])').click();
    await page.locator("#checkout").waitFor({ state: "visible" });
    await page.locator('#purchase [name="name"]').fill("Synthetic buyer");
    await page.locator('#purchase [name="phone"]').fill(phone);
    const acknowledge = page.locator('#purchase [name="acknowledge"]');
    if (await acknowledge.isVisible()) await acknowledge.check();
  };

  const copy = {
    en: { buyer: "670099245", refused: "670011245", cost: "Weekly 5 GB data · 7 days · 1 device 1,000 FCFA MTN MoMo fee 20 FCFA Total to approve 1,020 FCFA", pay: "Pay 1,020 FCFA",
      note: "Make sure your MoMo balance has at least 1,020 FCFA. If it's lower, the payment fails and no money is taken.",
      orange: ["Orange Money fee 30 FCFA", "Total to approve 1,030 FCFA", "Pay 1,030 FCFA"],
      wait: "A MTN MoMo request for 1,020 FCFA (1,000 FCFA bundle + 20 FCFA fee) was sent to 6•• •• 92 45. Approve it there — this screen updates by itself.",
      waitCheck: "Check the amount is 1,020 FCFA, then enter your PIN there.",
      lowTitle: "Not enough Mobile Money",
      low: "Your MoMo balance is below 1,020 FCFA: the bundle (1,000 FCFA) plus the Mobile Money fee (20 FCFA). Add money at any MoMo agent, then try again — or pick a smaller bundle.",
      rows: ["Bundle Weekly · 1,000 FCFA", "MTN MoMo fee 20 FCFA", "Total asked 1,020 FCFA"] },
    fr: { buyer: "670077245", refused: "670012245", cost: "Weekly 5 GB data · 7 days · 1 device 1 000 FCFA Frais MTN MoMo 20 FCFA Total à valider 1 020 FCFA", pay: "Payer 1 020 FCFA",
      note: "Vérifiez que votre solde MoMo est d'au moins 1 020 FCFA. S'il est inférieur, le paiement échoue et rien n'est prélevé.",
      orange: ["Frais Orange Money 30 FCFA", "Total à valider 1 030 FCFA", "Payer 1 030 FCFA"],
      wait: "Une demande MTN MoMo de 1 020 FCFA (forfait 1 000 FCFA + 20 FCFA de frais) a été envoyée au 6•• •• 72 45. Validez-la sur ce téléphone — cet écran se met à jour tout seul.",
      waitCheck: "Vérifiez que le montant est de 1 020 FCFA, puis saisissez votre code PIN.",
      lowTitle: "Mobile Money insuffisant",
      low: "Votre solde MoMo est inférieur à 1 020 FCFA : le forfait (1 000 FCFA) plus les frais Mobile Money (20 FCFA). Rechargez chez un agent MoMo, puis réessayez — ou choisissez un forfait plus petit.",
      rows: ["Forfait Weekly · 1 000 FCFA", "Frais MTN MoMo 20 FCFA", "Total demandé 1 020 FCFA"] },
  };

  for (const lang of ["en", "fr"]) {
    const c = copy[lang];
    // Buy a bundle: the pay step follows the network, then the waiting screen.
    let { context, page, errors } = await open({ lang });
    await startCheckout(page, c.buyer);
    await page.locator("#checkoutCost").filter({ hasText: "20" }).waitFor();
    assert.equal(await text(page.locator("#checkoutCost")), c.cost);
    assert.equal(await text(page.locator("#requestPayment")), c.pay);
    assert.equal(await text(page.locator("#balanceNote")), c.note);
    await page.locator('#purchase [name="network"]').selectOption("orange");
    assert.equal(await text(page.locator(".buy-cost__fee")), c.orange[0]);
    assert.equal(await text(page.locator(".buy-cost__total")), c.orange[1]);
    assert.equal(await text(page.locator("#requestPayment")), c.orange[2]);
    await page.locator('#purchase [name="network"]').selectOption("mtn");
    assert.equal(await text(page.locator("#requestPayment")), c.pay);
    await page.locator("#checkoutCost").scrollIntoViewIfNeeded();
    await check(page, `buy-pay-${lang}`);
    await page.locator("#requestPayment").scrollIntoViewIfNeeded();
    await check(page, `buy-pay-button-${lang}`);
    await page.locator("#requestPayment").click();
    await page.locator("#paymentRequestSummary").waitFor();
    assert.equal(await text(page.locator("#paymentRequestSummary")), c.wait);
    assert.equal(await text(page.locator(".buy-wait__check")), c.waitCheck);
    await page.locator("#paymentRequestSummary").scrollIntoViewIfNeeded();
    await check(page, `buy-wait-${lang}`);
    assert.deepEqual(errors, []);
    await context.close();

    // The operator refuses for the balance: the failure names the total, bundle and fee.
    ({ context, page, errors } = await open({ lang }));
    await startCheckout(page, c.refused);
    await page.locator("#requestPayment").click();
    await page.getByRole("heading", { name: c.lowTitle, exact: true }).waitFor();
    assert.equal(await text(page.locator("#paymentFailedBody")), c.low);
    assert.deepEqual(await page.locator(".pay-failed__row").evaluateAll((rows) => rows.slice(0, 3).map((row) => row.innerText.replace(/[\s  ]+/g, " ").trim())), c.rows);
    await page.evaluate(() => { for (const id of ["pageContent", "checkout"]) document.getElementById(id).style.display = "none"; });
    await check(page, `low-balance-${lang}`);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // check_balance (balance or an account limit) keeps the softer wording.
  let { context, page, errors } = await open();
  await startCheckout(page, "670031245");
  await page.locator("#requestPayment").click();
  await page.getByRole("heading", { name: "Not enough Mobile Money", exact: true }).waitFor();
  assert.equal(await text(page.locator("#paymentFailedBody")), "MTN MoMo didn't approve this payment, which usually means the balance is too low. Check your MoMo balance covers 1,020 FCFA: the bundle (1,000 FCFA) plus the Mobile Money fee (20 FCFA). Then try again — or pick a smaller bundle.");
  assert.deepEqual(errors, []);
  await context.close();

  // Guest checkout in the public store (English only): item, fee, total, Pay button.
  ({ context, page, errors } = await open());
  await page.goto(`${shop}/`);
  await page.getByRole("button", { name: "View device" }).click();
  await page.getByRole("button", { name: "Buy this device" }).click();
  await page.getByLabel("Full name").fill("Guest buyer");
  await page.getByLabel("Contact phone").fill("670000099");
  await page.getByLabel("Mobile Money number").fill("670000099");
  assert.equal(await text(page.locator("#checkoutCost")), "Item 18,000 FCFA MTN MoMo fee 360 FCFA Total to approve 18,360 FCFA Your balance needs at least 18,360 FCFA, or the payment fails and nothing is taken.");
  assert.equal(await text(page.locator("#payButton")), "Pay 18,360 FCFA");
  await page.getByText("Orange Money", { exact: true }).click();
  assert.equal(await text(page.locator("#checkoutCost")), "Item 18,000 FCFA Orange Money fee 540 FCFA Total to approve 18,540 FCFA Your balance needs at least 18,540 FCFA, or the payment fails and nothing is taken.");
  assert.equal(await text(page.locator("#payButton")), "Pay 18,540 FCFA");
  await page.getByText("MTN Mobile Money", { exact: true }).click();
  await page.locator("#checkoutCost").scrollIntoViewIfNeeded();
  await check(page, "guest-checkout-en");
  await page.locator("#payButton").scrollIntoViewIfNeeded();
  await check(page, "guest-checkout-button-en");
  await page.getByRole("button", { name: "Pay 18,360 FCFA" }).click();
  await page.waitForURL(/#order\//);
  assert.equal(await text(page.locator("#paymentRequest")), "A MTN MoMo request for 18,360 FCFA (incl. 360 FCFA fee) was sent. If this page closes, reopen the store in the same browser to pick up where you left off.");
  await check(page, "guest-order-waiting-en");
  const order = (await store.snapshot()).storeOrders[0];
  assert.deepEqual([order.payment.amount, order.payment.fee, order.payment.total], [18000, 360, 18360], "the order keeps the quote; MeSomb is asked for the price");
  assert.deepEqual(errors, []);
  await context.close();

  // Signed-in checkout in the portal's Shop.
  ({ context, page, errors } = await open({ signedIn: true }));
  await page.goto(`${portal}/dashboard#checkout/router/2`);
  await page.locator("#shopCost").waitFor();
  assert.equal(await text(page.locator("#shopCost")), "Item 36,000 FCFA MTN MoMo fee 720 FCFA Total to approve 36,720 FCFA Your balance needs at least 36,720 FCFA, or the payment fails and nothing is taken.");
  assert.equal(await text(page.locator('#shopCheckout [type="submit"]')), "Pay 36,720 FCFA");
  await page.locator('#shopCheckout input[value="orange"]').check({ force: true });
  assert.equal(await text(page.locator('#shopCheckout [type="submit"]')), "Pay 37,080 FCFA");
  await page.locator('#shopCheckout input[value="mtn"]').check({ force: true });
  await page.locator("#shopCost").scrollIntoViewIfNeeded();
  await check(page, "portal-checkout-en");
  assert.deepEqual(errors, []);
  await context.close();
});
