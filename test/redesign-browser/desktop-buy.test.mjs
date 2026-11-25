import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Buy a bundle on desktop (#431, canvas DesktopBuyBundle): a signed-in customer
// on a wide screen, once the Unlimited catalogue is on sale, sees every Personal
// Unlimited price in one table (validity by 1–6 devices, "Not offered" disabled),
// the Home WISP card and "Your choice" beside them, then pays with the same
// checkout as the phone. Legacy catalogue, phone widths and signed-out visitors
// keep the current page. Fee rules are synthetic (2%, rounded), as the canvas
// shows; every number comes from the server's quote.
// Screenshots: DESK_SCREENSHOTS (default /tmp/ndahi-desktop-buy). Local servers
// only; every other request is aborted.

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
// fr-FR groups thousands with narrow no-break spaces: compare words, not spacing.
const words = (value) => String(value).replace(/[\s  ]+/g, " ").trim();
const text = async (locator) => words(await locator.evaluate((el) => el.innerText));
const secret = "redesign-desktop-buy";
const FEES = { PAYMENT_FEE_MTN: "percent=2,on=price,round=nearest", PAYMENT_FEE_ORANGE: "percent=2,on=price,round=nearest" };

async function servers({ mode = "unlimited", fees = true } = {}) {
  const store = createStore({ persistent: false });
  const now = Date.now(), at = new Date(now).toISOString();
  await store.transaction((s) => {
    seedCatalogue(s, new Date(now));
    s.catalogue.mode = mode;
    s.customers.push({ id: "c-desk", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", createdAt: at },
      { id: "c-busy", name: "Paul Ewane", phone: "670002245", email: "paul@example.test", createdAt: at });
    s.dashboardSessions.push(
      { id: "sess-desk", customerId: "c-desk", role: "customer", tokenHash: hashSecret("shopper", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" },
      { id: "sess-busy", customerId: "c-busy", role: "customer", tokenHash: hashSecret("busy", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    // Paul's Personal Unlimited bundle is running: he can buy once it has ended.
    const plan = s.bundles.find((b) => b.id === "unlimited-7d-2");
    s.vouchers.push({ id: "v-busy", code: "BUSY-0001", customerId: "c-busy", planId: plan.id, planName: plan.name, planSnapshot: { ...plan },
      status: "active", quotaBytes: null, usedBytes: 0, deviceLimit: plan.deviceLimit, deviceSlots: plan.deviceSlots, validityHours: plan.validityHours,
      createdAt: at, activatedAt: at, expiresAt: new Date(now + 3 * 86400_000).toISOString() });
  });
  const apiPort = await reservePort(), portalPort = await reservePort();
  const api = `http://127.0.0.1:${apiPort}`, portal = `http://127.0.0.1:${portalPort}`;
  const apiServer = await listen(createServer({ store, validateConfig: false, env: {
    NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
    PAYMENT_MODE: "mock", ...(fees ? FEES : {}), EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } }), apiPort);
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }), portalPort);
  return { store, api, portal, close: async () => { await close(apiServer); await close(portalServer); } };
}

test("desktop customers pick any Unlimited bundle from one table and pay beside it", { timeout: 300000 }, async (t) => {
  const main = await servers(), noFee = await servers({ fees: false }), legacy = await servers({ mode: "legacy" });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await main.close(); await noFee.close(); await legacy.close(); });
  const screenshots = process.env.DESK_SCREENSHOTS || "/tmp/ndahi-desktop-buy";
  await mkdir(screenshots, { recursive: true });

  const open = async (env, { width = 1280, lang = "en", session = "shopper", path = "/onboarding.html?plan=unlimited-7d-2" } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1100 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [env.api, env.portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    // The page's own scripts read the document language (shared/ui/dom.js currentLanguage).
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
    return { context, page, errors };
  };
  const ready = (page) => page.locator("body.buy-desk #deskCost").waitFor();
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };
  const phoneLayout = async (page, label) => {
    await page.locator("#plans .plan").first().waitFor();
    assert.equal(await page.evaluate(() => document.body.classList.contains("buy-desk")), false, label);
    assert.equal(await page.locator("#plans table").count(), 0, label);
  };

  // The table, "Your choice" and the cost, as drawn (English).
  let { context, page, errors } = await open(main);
  await ready(page);
  assert.equal(await text(page.locator('.buy-desk__header [aria-current="page"]')), "Internet");
  assert.equal(await page.locator("#deskBack").getAttribute("href"), "/dashboard#internet");
  assert.equal(await text(page.locator("#packagesTitle")), "Buy a bundle.");
  assert.equal(await text(page.locator("#packagesDescription")), "Every bundle on sale, all with unlimited data. Pick one, then pay with MTN MoMo or Orange Money.");
  const table = page.getByRole("table", { name: "Personal Unlimited prices by validity and number of devices" });
  assert.deepEqual((await table.locator("thead th").allTextContents()).map(words), ["Validity", "1 device", "2 devices", "3 devices", "4 devices", "5 devices", "6 devices"]);
  assert.deepEqual(await table.locator('tbody th[scope="row"]').allTextContents(), ["5 hours", "24 hours", "7 days", "30 days"]);
  const none = Array(5).fill("Not offered");
  assert.deepEqual(await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("td button")].map((button) => button.textContent.trim()))), [
    ["250 XAF", ...none],
    ["500 XAF", "900 XAF", "1,300 XAF", "1,700 XAF", "2,100 XAF", "2,500 XAF"],
    ["2,500 XAF", "4,000 XAF", "5,500 XAF", "7,000 XAF", "8,500 XAF", "10,000 XAF"],
    ["6,000 XAF", "10,000 XAF", "15,000 XAF", "20,000 XAF", "25,000 XAF", "30,000 XAF"]]);
  assert.equal(await page.getByRole("button", { name: "5 hours, 2 devices: Not offered" }).isDisabled(), true);
  assert.equal(await table.locator("button:disabled").count(), 5);
  assert.deepEqual(await page.locator('#plans [aria-pressed="true"]').evaluateAll((cells) => cells.map((cell) => cell.getAttribute("aria-label"))), ["7 days, 2 devices: 4,000 XAF"]);
  assert.equal(await text(page.getByRole("heading", { name: "Home WISP Unlimited" })), "Home WISP Unlimited");
  assert.equal(await text(page.locator(".buy-desk__wisp")), "30 days Unlimited data · household sharing 50,000 XAF");
  assert.equal(await text(page.locator("#selected")), "Your choice");
  assert.equal(await text(page.locator(".buy-desk__choice")), "Personal Unlimited · 7 days · 2 devices Unlimited data · restricts sharing");
  assert.equal(await page.getByRole("radio", { name: "MTN MoMo" }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByRole("radio", { name: "Orange Money" }).getAttribute("aria-checked"), "false");
  // The account's number shows masked until the field is used.
  const number = page.getByLabel("Mobile Money number");
  assert.equal(await number.inputValue(), "670001245");
  assert.equal(await text(page.locator("#deskPayerMask")), "6•• •• 12 45");
  await number.focus();
  assert.equal(await page.locator("#deskPayerMask").textContent(), "");
  await number.blur();
  assert.equal(await text(page.locator("#deskPayerMask")), "6•• •• 12 45");
  assert.equal(await text(page.locator("#deskCost")), "Bundle Price 4,000 XAF Mobile Payment Fee (2%) 80 XAF Total to Pay 4,080 XAF");
  assert.equal(await text(page.locator("#balanceNote")), "Ensure you have at least 4,080 XAF in your MTN MoMo wallet (includes 2% mobile payment fee). Keep your screen unlocked to enter your PIN.");
  assert.equal(await text(page.locator("#balanceNote strong")), "4,080 XAF");
  assert.equal(await text(page.locator("#requestPayment")), "Pay Now");
  assert.equal(await text(page.locator(".buy-desk__rule")), "You can buy once your current bundle has ended.");
  assert.equal(await page.locator('#purchase [name="acknowledge"]').isVisible(), false, "no acknowledgement checkbox (owner, #431)");
  assert.equal(await page.getByRole("dialog").count(), 0, "Your choice is part of the page, not a dialog");
  await check(page, "desk-en");

  // Another cell, the other network, then Home WISP: the choice, fee, total and notice follow.
  await page.getByRole("button", { name: "24 hours, 6 devices: 2,500 XAF" }).click();
  assert.equal(await text(page.locator(".buy-desk__choice")), "Personal Unlimited · 24 hours · 6 devices Unlimited data · restricts sharing");
  assert.equal(await text(page.locator("#deskCost")), "Bundle Price 2,500 XAF Mobile Payment Fee (2%) 50 XAF Total to Pay 2,550 XAF");
  assert.deepEqual(await page.locator('#plans [aria-pressed="true"]').evaluateAll((cells) => cells.map((cell) => cell.getAttribute("aria-label"))), ["24 hours, 6 devices: 2,500 XAF"]);
  await page.getByRole("radio", { name: "Orange Money" }).click();
  assert.equal(await page.getByRole("radio", { name: "Orange Money" }).getAttribute("aria-checked"), "true");
  assert.equal(await page.locator('#purchase [name="network"]').inputValue(), "orange");
  assert.equal(await text(page.locator("#balanceNote")), "Ensure you have at least 2,550 XAF in your Orange Money wallet (includes 2% mobile payment fee). Keep your screen unlocked to enter your PIN.");
  await page.locator(".buy-desk__wisp").click();
  assert.equal(await page.locator(".buy-desk__wisp").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator('#plans .buy-desk__cell[aria-pressed="true"]').count(), 0);
  assert.equal(await text(page.locator(".buy-desk__choice")), "Home WISP Unlimited · 30 days Unlimited data · household sharing");
  assert.equal(await text(page.locator("#deskCost")), "Bundle Price 50,000 XAF Mobile Payment Fee (2%) 1,000 XAF Total to Pay 51,000 XAF");
  await check(page, "desk-wisp-orange-en");

  // Pay Now continues into the phone's payment flow: the request, then approval.
  await page.getByRole("button", { name: "7 days, 2 devices: 4,000 XAF" }).click();
  await page.getByRole("radio", { name: "MTN MoMo" }).click();
  await page.getByRole("button", { name: "Pay Now" }).click();
  await page.locator("#paymentRequestSummary").waitFor();
  assert.match(await text(page.locator("#paymentRequestSummary")), /4,080 FCFA/);
  const payment = (await main.store.snapshot()).payments.at(-1);
  assert.deepEqual([payment.customerId, payment.planId, payment.amount, payment.network], ["c-desk", "unlimited-7d-2", 4000, "mtn"]);
  assert.equal(String(payment.payerPhone).replace(/^237/, ""), "670001245");
  assert.equal(await page.locator("body.buy-desk #checkout #paymentRequestSummary").count(), 1, "the request shows in Your choice");
  await check(page, "desk-waiting-en");
  await page.getByRole("button", { name: "Simulate payment approval" }).click();
  for (let i = 0; i < 50 && (await main.store.snapshot()).payments.at(-1).status !== "paid"; i++) await page.waitForTimeout(100);
  assert.equal((await main.store.snapshot()).payments.at(-1).status, "paid");
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  ({ context, page, errors } = await open(main, { lang: "fr" }));
  await ready(page);
  assert.equal(await text(page.locator("#packagesTitle")), "Acheter un forfait.");
  assert.equal(await text(page.locator("#packagesDescription")), "Tous les forfaits en vente, tous avec données illimitées. Choisissez-en un, puis payez avec MTN MoMo ou Orange Money.");
  assert.equal(await page.getByRole("button", { name: "5 heures, 2 appareils: Non proposé" }).isDisabled(), true);
  assert.equal(await text(page.locator('#plans [aria-pressed="true"]')), "4 000 XAF");
  assert.equal(await text(page.locator("#selected")), "Votre choix");
  assert.equal(await text(page.locator(".buy-desk__choice")), "Personal Unlimited · 7 jours · 2 appareils Données illimitées · partage limité");
  assert.equal(await text(page.locator("#deskCost")), "Prix du forfait 4 000 XAF Frais de paiement mobile (2 %) 80 XAF Total à payer 4 080 XAF");
  assert.equal(await text(page.locator("#balanceNote")), "Assurez-vous d'avoir au moins 4 080 XAF sur votre compte MTN MoMo (frais de paiement mobile de 2 % inclus). Gardez votre écran déverrouillé pour saisir votre code PIN.");
  assert.equal(await text(page.locator("#requestPayment")), "Payer maintenant");
  assert.equal(await text(page.locator(".buy-desk__rule")), "Vous pourrez acheter quand votre forfait actuel sera terminé.");
  await check(page, "desk-fr");
  assert.deepEqual(errors, []);
  await context.close();

  // Without a verified fee the cost says where the fee shows; no total is invented.
  ({ context, page, errors } = await open(noFee));
  await ready(page);
  assert.equal(await text(page.locator("#deskCost")), "Bundle Price 4,000 XAF Mobile Payment Fee Shown in the operator prompt");
  assert.equal(await text(page.locator("#balanceNote")), "Ensure you have at least 4,000 XAF in your MTN MoMo wallet, plus the Mobile Money fee shown in the operator prompt. Keep your screen unlocked to enter your PIN.");
  await check(page, "desk-no-fee-en");
  assert.deepEqual(errors, []);
  await context.close();

  // A running bundle: nothing can be chosen or paid until it ends.
  ({ context, page, errors } = await open(main, { session: "busy" }));
  await ready(page);
  assert.equal(await page.locator("#plans .buy-desk__cell:not(.buy-desk__cell--none):not(:disabled)").count(), 0);
  assert.equal(await page.locator(".buy-desk__wisp").isDisabled(), true);
  assert.equal(await page.locator("#requestPayment").isDisabled(), true);
  assert.match(await text(page.locator("#planNotice")), /Your current bundle is still active/);
  await check(page, "desk-active-bundle-en");
  assert.deepEqual(errors, []);
  await context.close();

  // The current page stays for the legacy catalogue, phones and signed-out visitors.
  ({ context, page, errors } = await open(legacy, { path: "/onboarding.html" }));
  await phoneLayout(page, "legacy catalogue");
  assert.deepEqual(errors, []);
  await context.close();
  ({ context, page, errors } = await open(main, { width: 390, path: "/onboarding.html" }));
  await phoneLayout(page, "phone width");
  assert.deepEqual(errors, []);
  await context.close();
  ({ context, page, errors } = await open(main, { session: null, path: "/onboarding.html" }));
  await phoneLayout(page, "signed out");
  assert.deepEqual(errors, []);
  await context.close();

  // Narrowing the window reloads into the phone layout.
  ({ context, page, errors } = await open(main));
  await ready(page);
  await Promise.all([page.waitForEvent("load"), page.setViewportSize({ width: 800, height: 1000 })]);
  await phoneLayout(page, "narrowed window");
  assert.deepEqual(errors, []);
  await context.close();
});
