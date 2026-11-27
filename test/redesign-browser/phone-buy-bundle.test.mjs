import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Buy a bundle on a phone (#348, canvas PhoneBuyBundle): once the Unlimited
// catalogue is on sale, step 1 is the Personal Unlimited / Home WISP tabs,
// How long?, How many devices? ("Not offered" disabled), the bundle card, the
// rule and Continue; step 2 Review and pay (Pay with, the number, price, fee
// and total, the wallet notice, Pay Now); step 3 Approve on your phone; then
// Payment received and You're online. Signed out exactly as drawn (no login
// link). Fee rules are synthetic (2%, rounded); every number comes from the
// server's quote. The device's Wi-Fi request is answered by the test (no
// router); without Wi-Fi details the voucher page takes over, as before.
// Local servers only; every other request is aborted.

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
// fr-FR groups thousands with narrow no-break spaces: compare words, not spacing.
const words = (value) => String(value).replace(/[\s  ]+/g, " ").trim();
const text = async (locator) => words(await locator.evaluate((el) => el.innerText));
const secret = "redesign-phone-buy";
const FEES = { PAYMENT_FEE_MTN: "percent=2,on=price,round=nearest", PAYMENT_FEE_ORANGE: "percent=2,on=price,round=nearest" };
const HINT = "mac=AA:BB:CC:DD:EE:01&address=10.5.50.20";

async function servers({ fees = true, home = false } = {}) {
  const store = createStore({ persistent: false });
  const now = Date.now(), at = new Date(now).toISOString();
  await store.transaction((s) => {
    seedCatalogue(s, new Date(now));
    s.catalogue.mode = "unlimited";
    for (const [id, phone, token] of [["c-amina", "670001245", "amina"], ["c-home", "670003245", "home"], ["c-voucher", "670004245", "voucher"], ["c-ready", "670005245", "ready"], ["c-fr", "670006245", "fr"], ["c-busy", "670002245", "busy"]]) {
      s.customers.push({ id, name: "Customer " + id, phone, email: `${id}@example.test`, createdAt: at });
      s.dashboardSessions.push({ id: "sess-" + id, customerId: id, role: "customer", tokenHash: hashSecret(token, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    // Paul's bundle is running: he can buy once it has ended.
    const plan = s.bundles.find((b) => b.id === "unlimited-7d-2");
    s.vouchers.push({ id: "v-busy", code: "NC-BUSY-0001", customerId: "c-busy", planId: plan.id, planName: plan.name, planSnapshot: { ...plan },
      status: "active", quotaBytes: null, usedBytes: 0, deviceLimit: plan.deviceLimit, deviceSlots: plan.deviceSlots, validityHours: plan.validityHours,
      createdAt: at, activatedAt: at, expiresAt: new Date(now + 3 * 86400_000).toISOString() });
  });
  const apiPort = await reservePort(), portalPort = await reservePort();
  const api = `http://127.0.0.1:${apiPort}`, portal = `http://127.0.0.1:${portalPort}`;
  const apiServer = await listen(createServer({ store, validateConfig: false, env: {
    NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
    PAYMENT_MODE: "mock", ...(fees ? FEES : {}), ...(home ? { NDAHI_HOME_ENABLED: "true" } : {}), EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } }), apiPort);
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }), portalPort);
  return { store, api, portal, close: async () => { await close(apiServer); await close(portalServer); } };
}

test("phone customers choose a bundle, pay and get online in Buy a bundle", { timeout: 300000 }, async (t) => {
  const main = await servers(), noFee = await servers({ fees: false }), homeOn = await servers({ home: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await main.close(); await noFee.close(); await homeOn.close(); });

  const open = async (env, { lang = "en", session = "amina", path = "/onboarding.html" } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [env.api, env.portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] });
      set();
    });
    await context.addCookies([{ name: "ndahi_ui", value: "v2", url: env.portal, sameSite: "Lax" },
      ...(session ? [{ name: "customer_session", value: session, url: `${env.api}/api/account`, httpOnly: true, sameSite: "Lax" }] : [])]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${env.portal}${path}`);
    await page.locator("#phoneContinue:not([disabled])").or(page.locator("#phoneContinue")).first().waitFor();
    return { context, page, errors };
  };
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
  };
  const step = (page) => text(page.locator(".buy-bar__step"));
  const pressed = (page, selector) => page.locator(`${selector}[aria-pressed="true"]`).evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
  const pay = async (page) => {
    await page.locator("#phoneContinue:not([disabled])").click();
    await page.getByRole("heading", { name: "Review and pay" }).waitFor();
  };

  // Step 1, as drawn: 7 days for 2 devices first.
  let { context, page, errors } = await open(main);
  await page.locator("#phoneContinue:not([disabled])").waitFor();
  assert.equal(await text(page.locator(".buy-bar__title")), "Buy a bundle");
  assert.equal(await step(page), "Step 1 of 3");
  assert.equal(await page.locator("a.buy-bar__back").getAttribute("href"), "/dashboard#internet");
  assert.equal(await text(page.locator("#packagesTitle")), "Choose your bundle");
  assert.deepEqual(await page.getByRole("tab").allInnerTexts(), ["Personal Unlimited", "Home WISP Unlimited"]);
  assert.deepEqual(await page.locator(".buy-phone__chip").allInnerTexts(), ["5 hours", "24 hours", "7 days", "30 days"]);
  assert.deepEqual(await pressed(page, ".buy-phone__chip"), ["7 days"]);
  assert.deepEqual(await pressed(page, ".buy-phone__device"), ["2 devices 4,000 XAF"]);
  assert.equal(await text(page.locator(".buy-phone__card-head")), "Personal Unlimited · 7 days · 2 devices 4,000 XAF");
  assert.deepEqual((await page.locator(".buy-phone__perks li").allInnerTexts()).map(words), ["Unlimited data", "2 device slots, tied to your devices when they sign in",
    "Restricts sharing: hotspot and router sharing won’t work", "Time starts when you first connect"]);
  assert.equal(await text(page.locator(".buy-phone__rule")), "You can buy once your current bundle has ended. Rules");
  assert.equal(await text(page.locator("#phoneContinue")), "Continue · 4,000 XAF");
  assert.equal(await page.locator(".header-link").isVisible(), false, "no login or dashboard link in the bar");
  await check(page, "plan");

  // Five hours is offered for one device only: the count follows, the rest are "Not offered".
  await page.getByRole("button", { name: "5 hours" }).click();
  assert.deepEqual(await pressed(page, ".buy-phone__device"), ["1 device 250 XAF"]);
  assert.equal(await page.locator(".buy-phone__device[disabled]").count(), 5);
  assert.equal(await page.getByRole("button", { name: "3 devices, Not offered" }).isDisabled(), true);
  await page.getByRole("button", { name: "30 days" }).click();
  await page.getByRole("button", { name: "4 devices, 20,000 XAF" }).click();
  assert.equal(await text(page.locator("#phoneContinue")), "Continue · 20,000 XAF");
  // Home WISP, then back to the Personal choice.
  await page.getByRole("tab", { name: "Home WISP Unlimited" }).click();
  assert.equal(await page.locator(".buy-phone__chip").count(), 0);
  assert.equal(await text(page.locator(".buy-phone__card-head")), "Home WISP Unlimited · 30 days 50,000 XAF");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.getByRole("tab", { name: "Personal Unlimited" }).getAttribute("aria-selected"), "true");
  assert.deepEqual(await pressed(page, ".buy-phone__device"), ["4 devices 20,000 XAF"]);
  await page.getByRole("button", { name: "7 days" }).click();
  await page.getByRole("button", { name: "2 devices, 4,000 XAF" }).click();

  // Step 2: Review and pay, the account's number masked until used.
  await pay(page);
  assert.equal(await step(page), "Step 2 of 3");
  assert.equal(await text(page.locator(".buy-phone__summary")), "Personal Unlimited · 7 days · 2 devices Unlimited data · 7 days · 2 registered devices");
  assert.deepEqual(await pressed(page, ".buy-phone__method"), ["MTN MoMo"]);
  assert.equal(await text(page.locator("#deskPayerMask")), "6•• •• 12 45");
  assert.equal(await text(page.locator(".buy-phone__cost")), "Bundle Price 4,000 XAF Mobile Payment Fee (2%) 80 XAF Total to Pay 4,080 XAF");
  assert.equal(await text(page.locator("#balanceNote")), "Ensure you have at least 4,080 XAF in your MTN MoMo wallet (includes 2% mobile payment fee). Keep your screen unlocked to enter your PIN.");
  assert.equal(await page.locator("#acknowledgement").isVisible(), false);
  assert.equal(await text(page.locator("#requestPayment")), "Pay Now");
  await check(page, "pay");
  await page.getByRole("button", { name: "Orange Money" }).click();
  assert.deepEqual(await pressed(page, ".buy-phone__method"), ["Orange Money"]);
  await page.getByRole("button", { name: "MTN MoMo" }).click();
  // Back returns to step 1 with the same bundle.
  await page.locator("#phoneBack").click();
  assert.equal(await step(page), "Step 1 of 3");
  assert.deepEqual(await pressed(page, ".buy-phone__device"), ["2 devices 4,000 XAF"]);
  await context.close();

  // Paying, approving and getting online on this device (its Wi-Fi request answered here).
  ({ context, page, errors } = await open(main, { path: `/onboarding.html?${HINT}` }));
  let connectRequest;
  await page.route("**/api/account/device-management/connect", async (route) => {
    connectRequest = JSON.parse(route.request().postData());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ request: { id: "wifi-1", status: "connected", firstDevice: true } }) });
  });
  await pay(page);
  await page.locator("#requestPayment").click();
  await page.getByRole("heading", { name: "Approve on your phone" }).waitFor();
  assert.equal(await step(page), "Step 3 of 3");
  assert.equal(await page.locator("#phoneBack, a.buy-bar__back").filter({ visible: true }).count(), 0, "no back once the request is sent");
  assert.equal(await text(page.locator("#paymentRequestSummary")), "A MTN MoMo request for 4,080 XAF was sent to 6•• •• 12 45. Approve it there — this screen updates by itself.");
  assert.deepEqual((await page.locator(".buy-phone__steps li").allInnerTexts()).map(words), ["Open the payment prompt on your phone",
    "Check the amount is 4,080 XAF, then enter your PIN in the prompt", "Come back here — no need to refresh"]);
  await check(page, "wait");
  await page.getByRole("button", { name: "Check status" }).click();
  await page.locator("#phoneStage #message").getByText("Still waiting for your approval.").waitFor();
  await page.getByRole("button", { name: "Simulate payment approval" }).click();
  await page.getByRole("heading", { name: "You're online" }).waitFor();
  assert.equal(await step(page), "Done");
  assert.equal(connectRequest.mac, "AA:BB:CC:DD:EE:01");
  assert.equal(await text(page.locator(".buy-phone__line")), "Personal Unlimited · 7 days · 2 devices is active on this device. Your receipt is in Activity.");
  assert.equal(await text(page.locator(".buy-phone__active")), "ACTIVE BUNDLE Unlimited data · 7 days · 2 registered devices");
  assert.equal(await page.getByRole("link", { name: "Go to my home" }).getAttribute("href"), "/dashboard?main-device=AA%3ABB%3ACC%3ADD%3AEE%3A01#home");
  assert.equal(await page.getByRole("link", { name: "View receipt" }).getAttribute("href"), "/dashboard#activity");
  assert.equal(await page.getByRole("link", { name: "Register my home router" }).count(), 0);
  await check(page, "done");
  let s = await main.store.snapshot();
  const paid = s.payments.find((p) => p.customerId === "c-amina");
  assert.equal(paid.status, "paid");
  assert.equal(paid.planId, "unlimited-7d-2");
  assert.deepEqual([paid.amount, paid.fee, paid.total], [4000, 80, 4080]);
  assert.deepEqual(errors, []);
  await context.close();

  // Payment received while the Wi-Fi is being prepared.
  ({ context, page, errors } = await open(main, { session: "voucher", path: `/onboarding.html?${HINT}` }));
  await page.route("**/api/account/device-management/connect", () => {});
  await pay(page);
  await page.locator("#requestPayment").click();
  await page.getByRole("button", { name: "Simulate payment approval" }).click();
  await page.getByRole("heading", { name: "Payment received" }).waitFor();
  assert.equal(await step(page), "Paid");
  assert.match(await text(page.locator(".buy-phone__progress")), /^✓ Payment confirmed MTN MoMo confirmed 4,080 XAF · \d\d:\d\d Activating your Wi-Fi… This usually takes a few seconds\. Please don’t pay again\.$/);
  assert.match(await text(page.locator(".buy-phone__ref")), /^Reference: \S+$/);
  assert.equal(await page.getByRole("link", { name: "View payment receipt" }).getAttribute("href"), "/dashboard#activity");
  await check(page, "activating");
  await context.close();

  // Without this device's Wi-Fi details the voucher page connects it (owner, 26 Nov).
  ({ context, page, errors } = await open(main, { session: "ready" }));
  await pay(page);
  await page.locator("#requestPayment").click();
  await Promise.all([page.waitForURL(/\/voucher-ready\.html\?payment=/), page.getByRole("button", { name: "Simulate payment approval" }).click()]);
  await context.close();

  // Home WISP while Home is off (production today): the server's reason, on Review and pay.
  ({ context, page, errors } = await open(main, { session: "home" }));
  await page.getByRole("tab", { name: "Home WISP Unlimited" }).click();
  await pay(page);
  assert.equal(await text(page.locator(".buy-phone__summary")), "Home WISP Unlimited · 30 days Unlimited data · household sharing · 30 days");
  await page.locator("#requestPayment").click();
  await page.locator("#purchase #message").getByText("Home WISP Unlimited isn't available yet. Choose another bundle.").waitFor();
  assert.equal(await step(page), "Step 2 of 3");
  assert.equal(await page.locator("#requestPayment").isDisabled(), false);
  await context.close();
  // With Home on: online once paid, then Register my home router.
  ({ context, page, errors } = await open(homeOn, { session: "home", path: `/onboarding.html?${HINT}` }));
  await page.getByRole("tab", { name: "Home WISP Unlimited" }).click();
  await pay(page);
  await page.locator("#requestPayment").click();
  await page.getByRole("button", { name: "Simulate payment approval" }).click();
  await page.getByRole("heading", { name: "You're online" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Register my home router" }).getAttribute("href"), "/home-router.html");
  assert.deepEqual(errors, []);
  await context.close();

  // A running bundle: Continue can't be used, and the page says why.
  ({ context, page, errors } = await open(main, { session: "busy" }));
  await page.locator("#planNotice .plan-notice").waitFor();
  assert.equal(await page.locator("#phoneContinue").isDisabled(), true);
  assert.equal(await text(page.locator("#phoneContinue")), "Currently unavailable");
  await context.close();

  // Signed out, exactly as drawn: no login link, the Mobile Money number, no name.
  ({ context, page, errors } = await open(main, { session: null }));
  await page.locator("#phoneContinue:not([disabled])").waitFor();
  assert.equal(await page.locator("a.buy-bar__back").getAttribute("href"), "/");
  assert.equal(await page.getByRole("link", { name: "Customer login" }).isVisible(), false);
  await pay(page);
  assert.equal(await page.getByLabel("Your name").isVisible(), false);
  await page.getByRole("textbox", { name: "Mobile Money number", exact: true }).fill("670009999");
  assert.deepEqual(await pressed(page, ".buy-phone__method"), ["MTN MoMo"]);
  await page.locator("#requestPayment").click();
  await page.getByRole("heading", { name: "Approve on your phone" }).waitFor();
  assert.match(await text(page.locator("#paymentRequestSummary")), /sent to 6•• •• 99 99\./);
  // "Payment didn't go through?" opens the failure screen (PhonePaymentFailed).
  await page.getByRole("button", { name: "Payment didn't go through?" }).click();
  await page.locator("#paymentFailed:not([hidden])").waitFor();
  s = await main.store.snapshot();
  assert.ok(s.payments.some((p) => p.payerPhone === "670009999" && p.planId === "unlimited-7d-2"));
  assert.deepEqual(errors, []);
  await context.close();

  // No verified fee: the price, and the fee in the operator prompt.
  ({ context, page, errors } = await open(noFee));
  await pay(page);
  assert.equal(await text(page.locator(".buy-phone__cost")), "Bundle Price 4,000 XAF The Mobile Money fee will appear in the operator prompt, before you approve.");
  assert.equal(await text(page.locator("#balanceNote")), "Ensure your MTN MoMo wallet covers 4,000 XAF plus the fee shown in the operator prompt. Keep your screen unlocked to enter your PIN.");
  await check(page, "pay-no-fee");
  await context.close();

  // French.
  ({ context, page, errors } = await open(main, { lang: "fr", session: "fr" }));
  await page.locator("#phoneContinue:not([disabled])").waitFor();
  assert.equal(await text(page.locator(".buy-bar__title")), "Acheter un forfait");
  assert.equal(await step(page), "Étape 1 sur 3");
  assert.equal(await text(page.locator("#packagesTitle")), "Choisissez votre forfait");
  assert.equal(await text(page.locator("#phoneContinue")), "Continuer · 4 000 XAF");
  await page.locator("#phoneContinue").click();
  await page.getByRole("heading", { name: "Vérifier et payer" }).waitFor();
  assert.equal(await text(page.locator(".buy-phone__cost")), "Prix du forfait 4 000 XAF Frais de paiement mobile (2 %) 80 XAF Total à payer 4 080 XAF");
  assert.equal(await text(page.locator("#requestPayment")), "Payer maintenant");
  await check(page, "pay-fr");
  assert.deepEqual(errors, []);
  await context.close();
});
