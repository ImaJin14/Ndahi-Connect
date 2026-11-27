import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Buy for someone else (#255, canvas: PhoneBuyForOther): at /gift.html (Internet
// no longer links to it, as drawn: owner, 27 Nov, #355), the
// number shows the one case that applies; pick a bundle and a note; pay with
// your own number; the done screen says what happened and gives the code and
// QR. Each kind of number: no account, an account, a bundle running.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const later = (hours) => new Date(Date.now() + hours * 36e5).toISOString();

test("a customer buys bundles for three kinds of number", { timeout: 240000 }, async (t) => {
  const secret = "redesign-gift-purchase", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c-buyer", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", emailVerifiedAt: later(-100) },
      { id: "c-mama", name: "Mama Ngum", phone: "670008821" }, { id: "c-papa", name: "Papa Ngum", phone: "670008822" });
    s.dashboardSessions.push({ id: "sess", customerId: "c-buyer", role: "customer", tokenHash: hashSecret("buyer", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.vouchers.push({ id: "v-buyer", customerId: "c-buyer", planId: "weekly", code: "NC-BUYR-0001", status: "active", activatedAt: later(-24), expiresAt: later(100), quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1, routerSyncStatus: "synchronized" },
      { id: "v-papa", customerId: "c-papa", planId: "weekly", code: "NC-PAPA-0001", status: "active", activatedAt: later(-24), expiresAt: later(72), quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1 });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
    // A synthetic 2% MTN fee rule (not MeSomb's rate): the fee and total come from the server (#297).
    PAYMENT_MODE: "mock", PAYMENT_FEE_MTN: "percent=2", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = "/tmp/ndahi-gift-purchase";
  await mkdir(screenshots, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Africa/Douala" });
  await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await context.addCookies([{ name: "customer_session", value: "buyer", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const check = async (label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png` });
  };
  const pay = async (number, name, label) => {
    await page.getByLabel("Their phone number").fill(number);
    await page.getByLabel("Their name (optional)").fill(name);
    const card = page.locator(".gift__card--on");
    await card.waitFor();
    if (label) await check(`${label}-who`);
    const caseText = await text(card);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: `Pick a bundle for ${name}` }).waitFor();
    assert.equal(await page.getByRole("radio", { name: /Weekly/ }).getAttribute("aria-checked"), "true", "the buyer's own plan is chosen to start with");
    await page.getByLabel("Add a note (optional)").fill("For your calls with the family ❤");
    // The 24 Nov board: the price, the 2% fee and the total, the wallet notice and Pay Now (#364).
    assert.equal(await text(page.locator(".gift__cost")), "Bundle Price 1,000 XAF Mobile Payment Fee (2%) 20 XAF Total to Pay 1,020 XAF");
    assert.equal(await text(page.locator(".gift__notice")), "Ensure you have at least 1,020 XAF in your MTN MoMo wallet (includes 2% mobile payment fee). Keep your screen unlocked to enter your PIN.");
    if (label) await check(`${label}-plan`);
    await page.getByRole("button", { name: "Pay Now" }).click();
    await page.getByRole("heading", { name: "Approve on your phone" }).waitFor();
    assert.equal(await text(page.locator(".gift__text")), "An MTN MoMo request for 1,020 XAF (incl. 20 XAF fee) was sent to your number. This screen updates by itself.");
    if (label) await check(`${label}-wait`);
    const payment = (await store.snapshot()).payments.find((p) => p.gift && !["paid", "failed", "expired"].includes(p.status));
    assert.ok(payment, JSON.stringify((await store.snapshot()).payments.map((p) => [p.status, p.failureReason, p.providerStatus, p.provider, p.network, p.payerPhone])));
    assert.equal((await fetch(`${api}/api/payments/${payment.id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
    await page.getByRole("button", { name: "Check status" }).click();
    return caseText;
  };

  // At /gift.html; Internet no longer links to it (owner, #355).
  await page.goto(`${portal}/gift.html`);
  await page.getByRole("heading", { name: "Who is it for?" }).waitFor();
  assert.equal(await text(page.locator("#giftStep")), "Step 1 of 3");

  // Your own number is refused.
  await page.getByLabel("Their phone number").fill("670001245");
  await page.getByRole("alert").filter({ hasText: "That's your own number." }).waitFor();

  // No account: a code to pass on.
  assert.equal(await pay("670008899", "Mama Ngum", "no-account"),
    "No NDAHI account yet We'll give you a code to send them. They claim it with the code and their own number, so nobody else can use it.");
  await page.getByRole("heading", { name: "Paid — now send it" }).waitFor();
  assert.equal(await text(page.locator(".gift__text")), "Send Mama Ngum the code or show them the QR. They claim it with the code and their number 6•• •• 88 99, and the 7 days start when they choose.");
  const voucher = page.getByRole("region", { name: "Gift voucher" });
  assert.match(await text(voucher), /^FOR MAMA NGUM · WEEKLY [A-Z0-9]{4}-[A-Z0-9]{4}$/, "the code as on the slip, without NC-");
  await voucher.getByRole("img", { name: /^QR code for voucher [A-Z0-9]{4}-[A-Z0-9]{4}$/ }).waitFor();
  await page.getByRole("button", { name: "Share code" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "See it in Activity" }).getAttribute("href"), "/dashboard#activity");
  await check("no-account-done");
  const reserved = (await store.snapshot()).vouchers.find((v) => v.reservation?.phone === "670008899");
  assert.deepEqual([reserved.status, reserved.reservation.note], ["available", "For your calls with the family ❤"]);

  // An account: it goes straight in.
  await page.goto(`${portal}/gift.html`);
  assert.equal(await pay("670008821", "Mama Ngum", "account"),
    "Mama Ngum · NDAHI customer It goes straight to their account and they get a notification. No code to pass on.");
  await page.getByRole("heading", { name: "Sent to Mama Ngum" }).waitFor();
  await page.getByRole("button", { name: "Share code anyway" }).waitFor();
  await check("account-done");

  // A bundle running: saved until it ends.
  await page.goto(`${portal}/gift.html`);
  const busy = await pay("670008822", "Papa Ngum", "active");
  assert.match(busy, /^Papa Ngum · bundle active until \d{1,2} [A-Z][a-z]{2} They can only use it once their current bundle ends\. It's saved in their account until then\.$/);
  await page.getByRole("heading", { name: "Saved for Papa Ngum" }).waitFor();
  assert.match(await text(page.locator(".gift__text")), /^It's waiting in their account\. They can start it once their current bundle ends on \d{1,2} [A-Z][a-z]{2}\. They've been notified\.$/);
  await check("active-done");
  const s = await store.snapshot();
  assert.equal(s.vouchers.filter((v) => v.giftedBy === "c-buyer").length, 3);
  assert.equal(s.vouchers.find((v) => v.id === "v-buyer").status, "active", "the buyer's own bundle is untouched");
  assert.deepEqual(errors, []);
  await context.close();
});

// The Unlimited catalogue (#364): every offer is a card ("Unlimited · 7 days ·
// 2 devices"), Home WISP only while Home is on (owner), and without a verified
// fee rule the foot shows the price and says the fee is in the operator prompt.
test("buying for someone else lists the Unlimited offers as cards", { timeout: 180000 }, async (t) => {
  const secret = "redesign-gift-unlimited", store = createStore({ persistent: false });
  await store.transaction((s) => {
    seedCatalogue(s, new Date()); s.catalogue.mode = "unlimited";
    s.customers.push({ id: "c-buyer", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", emailVerifiedAt: later(-100) });
    s.dashboardSessions.push({ id: "sess", customerId: "c-buyer", role: "customer", tokenHash: hashSecret("buyer", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
    PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const open = async ({ home = false, lang } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Africa/Douala", locale: lang === "fr" ? "fr-FR" : "en-US" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    if (home) await context.route("**/api/home/config", (route) => route.fulfill({ json: { enabled: true } }));
    if (lang === "fr") await context.addInitScript(() => { try { localStorage.setItem("ndahi-lang", "fr"); } catch {} });
    await context.addCookies([{ name: "customer_session", value: "buyer", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/gift.html`);
    await page.locator("#giftPhone").fill("670008899");
    await page.locator("#giftName").fill("Mama Ngum");
    await page.locator(".gift__card--on").waitFor();
    await page.locator("#giftWho button[type=submit]").click();
    await page.locator("#giftPlan").waitFor();
    return { context, page, errors };
  };

  // Home is off: the 19 Personal offers, each with its device count.
  const { context, page, errors } = await open();
  const cards = page.getByRole("radio");
  assert.equal(await cards.count(), 19);
  assert.equal(await text(cards.first()), "Personal Unlimited Unlimited · 5 h · 1 device 250 XAF");
  assert.equal(await text(page.locator('[data-plan="unlimited-24h-1"]')), "Personal Unlimited Unlimited · 24 h · 1 device 500 XAF");
  await page.locator('[data-plan="unlimited-7d-2"]').click();
  assert.equal(await page.locator('[data-plan="unlimited-7d-2"]').getAttribute("aria-checked"), "true");
  assert.equal(await text(page.locator('[data-plan="unlimited-7d-2"]')), "Personal Unlimited Unlimited · 7 days · 2 devices 4,000 XAF");
  assert.equal(await page.getByText("Home WISP Unlimited").count(), 0, "Home WISP is hidden while Home is off");
  // No verified fee: the price, the fee in the operator prompt, and the notice without a total.
  assert.equal(await text(page.locator(".gift__cost")), "Bundle Price 4,000 XAF The Mobile Money fee will appear in the operator prompt, before you approve.");
  assert.equal(await text(page.locator(".gift__notice")), "Ensure your MTN MoMo wallet covers 4,000 XAF plus the fee shown in the operator prompt. Keep your screen unlocked to enter your PIN.");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "Pay Now" }).click();
  await page.getByRole("heading", { name: "Approve on your phone" }).waitFor();
  const payment = (await store.snapshot()).payments.find((p) => p.gift);
  assert.equal(payment.planId, "unlimited-7d-2");
  assert.equal((await fetch(`${api}/api/payments/${payment.id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 200);
  await page.getByRole("button", { name: "Check status" }).click();
  await page.getByRole("heading", { name: "Paid — now send it" }).waitFor();
  assert.match(await text(page.getByRole("region", { name: "Gift voucher" })), /^FOR MAMA NGUM · PERSONAL UNLIMITED [A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.deepEqual(errors, []);
  await context.close();

  // Home is on: Home WISP is the last card.
  const home = await open({ home: true });
  assert.equal(await home.page.getByRole("radio").count(), 20);
  assert.equal(await text(home.page.getByRole("radio").last()), "Home WISP Unlimited Unlimited · 30 days · household sharing 50,000 XAF");
  await home.context.close();

  // French.
  const fr = await open({ lang: "fr" });
  assert.equal(await text(fr.page.locator('[data-plan="unlimited-30d-4"]')), "Personal Unlimited Illimité · 30 jours · 4 appareils 20 000 XAF");
  await fr.page.locator('[data-plan="unlimited-30d-4"]').click();
  assert.equal(await fr.page.getByRole("button", { name: "Payer maintenant" }).count(), 1);
  assert.deepEqual(fr.errors, []);
  await fr.context.close();
});
