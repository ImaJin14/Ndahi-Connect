import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Guest checkout in four steps (canvas: PhoneGuestCheckout, #400; owner 26 Nov):
// how to check out, the details (one Mobile Money number, which is also the
// contact; the fee and total at the foot; Pay Now), "Approve on your phone" with
// Check status and Change payment, and "Order placed" with the private link and
// Track my order. Back goes from the details to the choice; once a request is
// sent the bar has no back, and Escape opens the order. Local servers only,
// synthetic catalogue and provider, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const text = (locator) => locator.evaluate((el) => el.innerText.replace(/\s+/g, " ").trim());

test("a guest checks out in the drawn steps and can change payment", { timeout: 180000 }, async (t) => {
  const secret = "redesign-phone-guest-checkout", store = createStore({ persistent: false });
  let providerStatus = "pending", clock = new Date("2030-01-01T10:00:00Z");
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "670000000", warranty: words, returns: words };
    s.storeProducts.push({ id: "cpe210", version: 1, stock: 3, sku: "cpe210", name: { en: "TP-Link CPE210", fr: "TP-Link CPE210" }, description: words, specifications: words,
      compatibility: words, contents: words, warranty: words, setup: words, images: [], price: 25000, cost: 1, status: "published", featured: false, categoryId: "" });
  });
  // A provider the test answers for: pending until it says paid.
  const adapter = {
    configured: () => true,
    createPayment: async (p) => ({ status: "pending", providerReference: `ref-${p.id}` }),
    verifyPayment: async (p) => ({ status: providerStatus, amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }),
    handleWebhook: async (raw) => JSON.parse(raw),
    refundPayment: async () => ({ status: "completed", providerReference: "refund" }),
  };
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`, portal = "http://127.0.0.1:9";
  const storeServer = await listen(createStaticServer("store", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const shop = `http://127.0.0.1:${storeServer.address().port}`;
  const apiServer = createServer({ store, now: () => clock, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", STORE_APP_URL: shop, CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mesomb", PAYMENT_FEE_MTN: "percent=2", PAYMENT_FEE_ORANGE: "percent=2",
    EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false",
    SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(storeServer); });
  const screenshots = process.env.PHONE_GUEST_CHECKOUT_SCREENSHOTS || "/tmp/ndahi-phone-guest-checkout";
  await mkdir(screenshots, { recursive: true });
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; });
  const open = async (width = 390, height = 844) => {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route("**/*", (route) => [api, shop].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(shop + "/#product/cpe210");
    await page.locator("#productTitle").waitFor();
    return { context, page, errors };
  };
  const check = async (page, name) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${name}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${name}`);
    await page.screenshot({ path: `${screenshots}/${name}.png` });
  };
  const orders = async () => (await store.snapshot()).storeOrders;
  const { context, page, errors } = await open();
  const dialog = page.locator("#checkoutDialog"), bar = page.locator("#checkoutDialog .sheet-bar__title"), back = page.locator("#checkoutDialog .close");

  // How to check out: as a guest (chosen), or sign in.
  await page.locator("#buy").click();
  await dialog.locator("#checkoutGuest").waitFor();
  assert.equal(await bar.innerText(), "Checkout");
  assert.equal(await back.getAttribute("aria-label"), "Back to product");
  assert.equal(await page.locator("#checkoutTitle").innerText(), "How would you like to check out?");
  assert.equal(await text(page.locator(".checkout-line")), "TP-Link CPE210 × 1 · 25,000 FCFA");
  assert.equal(await text(page.locator("#checkoutGuest")), "Continue as guest Just a name and phone number. You get a private tracking link.");
  const signIn = page.locator("a.choice");
  assert.equal(await text(signIn), "Sign in to NDAHI Details filled in, order saved in Activity.");
  assert.equal(await signIn.getAttribute("href"), `${portal}/login`);
  await check(page, "choose");
  // Back on the choice returns to the product.
  await back.click();
  assert.equal(await dialog.evaluate((el) => el.open), false);

  // The details: name, one Mobile Money number, optional email, where to collect, Pay with.
  await page.locator("#buy").click();
  await page.locator("#checkoutGuest").click();
  await page.locator("#checkoutForm").waitFor();
  assert.equal(await bar.innerText(), "Guest checkout");
  assert.equal(await back.getAttribute("aria-label"), "Back");
  assert.deepEqual(await page.locator("#checkoutForm label:not(.method)").evaluateAll((nodes) => nodes.map((n) => n.innerText.replace(/\s+/g, " ").trim())),
    ["Full name", "Mobile Money number — the one that pays", "Email — optional, for order updates"]);
  assert.equal(await page.getByLabel("Contact phone").count(), 0, "one number: the one that pays");
  assert.equal(await text(page.locator(".collect-box")), "Collect at Bandja Street Delivery comes later");
  assert.equal(await page.locator('input[name="network"][value="mtn"]').isChecked(), true);
  assert.equal(await text(page.locator("#checkoutCost")), "Item 25,000 FCFA Mobile Payment Fee (2%) 500 FCFA Total to Pay 25,500 FCFA Ensure you have at least 25,500 FCFA in your MTN MoMo wallet (includes 2% mobile payment fee). Keep your screen unlocked to enter your PIN.");
  assert.equal(await page.locator("#payButton").innerText(), "Pay Now");
  // The foot stays at the bottom of the screen.
  assert.equal((await box(page.locator(".checkout-foot"))).bottom, 844);
  // The networks are radios drawn as buttons: arrow keys move the choice.
  await page.locator('input[name="network"][value="mtn"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator('input[name="network"][value="orange"]').isChecked(), true);
  assert.match(await text(page.locator(".checkout-cost__balance")), /in your Orange Money wallet/);
  await page.getByText("MTN MoMo", { exact: true }).click();
  await page.locator("#name").fill("Paul T.");
  await page.locator("#payerPhone").fill("670008802");
  await check(page, "details");
  // Back from the details returns to the choice.
  await back.click();
  await page.locator("#checkoutGuest").waitFor();
  assert.equal(await bar.innerText(), "Checkout");
  await page.locator("#checkoutGuest").click();

  // Pay Now: "Approve on your phone", with no back in the bar.
  await page.locator("#name").fill("Paul T.");
  await page.locator("#payerPhone").fill("670008802");
  await page.locator("#payButton").click();
  await page.getByRole("heading", { name: "Approve on your phone", exact: true }).waitFor();
  assert.equal(await bar.innerText(), "Waiting for payment");
  assert.equal(await back.isVisible(), false);
  assert.equal(await text(page.locator(".checkout-state > p").first()), "A MTN MoMo request for 25,500 FCFA (incl. 500 FCFA fee) was sent to 6•• •• 88 02. If this page closes, reopen the store in the same browser to pick up where you left off.");
  const [first] = await orders();
  assert.equal(first.contact.phone, first.payment.payerPhone, "one number: the contact is the number that pays");
  assert.match(first.payment.payerPhone, /670008802$/);
  await check(page, "wait");
  // Not approved yet.
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await page.getByText("Not confirmed yet. Approve the request on your phone, then check again.", { exact: true }).waitFor();
  // Change payment: the unpaid request is cancelled and the details come back.
  await page.getByRole("button", { name: "Change payment", exact: true }).click();
  await page.locator("#checkoutForm").waitFor();
  assert.equal((await orders()).find((o) => o.id === first.id).status, "cancelled");
  assert.equal(await page.locator("#name").inputValue(), "Paul T.");
  assert.equal(await page.locator("#payerPhone").inputValue(), "670008802");

  // A fresh request, approved: "Order placed", then Track my order.
  await page.locator("#payButton").click();
  await page.getByRole("heading", { name: "Approve on your phone", exact: true }).waitFor();
  assert.equal((await orders()).length, 2, "a new request, not the cancelled one");
  providerStatus = "paid";
  clock = new Date(+clock + 31000);
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await page.getByRole("heading", { name: "Order placed", exact: true }).waitFor();
  const second = (await orders()).find((o) => o.payment.status === "paid");
  assert.equal(await bar.innerText(), "Order confirmed");
  assert.equal(await text(page.locator(".checkout-state > p").first()), `Order ${second.reference} is paid. Your tracking link shows when it's ready to collect.`);
  assert.equal(await text(page.locator(".checkout-keep")), "Save your private tracking link Copy or bookmark it — we also email it if you gave an address. Anyone with the link can see this order.");
  assert.equal(await text(page.locator(".checkout-account")), "Want this in an account? Sign in or sign up with the same number and the order moves into Activity. Save to an account");
  assert.equal(await page.locator(".checkout-account a").getAttribute("href"), `${portal}/login`);
  await check(page, "done");
  await page.getByRole("button", { name: "Track my order", exact: true }).click();
  await page.waitForURL(new RegExp(`#order/${second.id}/`));
  await page.locator(".order-page").waitFor();
  assert.equal(await dialog.evaluate((el) => el.open), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("ndahi-store-checkout")), null);

  // Escape once a request is sent opens the order instead of losing it.
  await page.goto(shop + "/#product/cpe210");
  await page.locator("#productTitle").waitFor();
  await page.locator("#buy").click();
  await page.locator("#checkoutGuest").click();
  await page.locator("#name").fill("Paul T.");
  await page.locator("#payerPhone").fill("670008802");
  providerStatus = "pending";
  await page.locator("#payButton").click();
  await page.getByRole("heading", { name: "Approve on your phone", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const third = (await orders()).find((o) => o.status === "awaiting_payment");
  await page.waitForURL(new RegExp(`#order/${third.id}/`));
  assert.deepEqual(errors, []);
  await context.close();

  // Desktop: the same steps in a centred sheet.
  const desk = await open(1280, 900);
  await desk.page.locator("#buy").click();
  await desk.page.locator("#checkoutGuest").click();
  await desk.page.locator("#checkoutForm").waitFor();
  const sheet = await box(desk.page.locator("#checkoutDialog")), foot = await box(desk.page.locator(".checkout-foot"));
  assert.equal(sheet.w, 620);
  assert.ok(Math.abs(foot.bottom - (sheet.y + sheet.h)) <= 1, "the foot ends the sheet");
  assert.ok(sheet.h < 900 - 48, "the sheet fits its step");
  await check(desk.page, "details-desktop");
  assert.deepEqual(desk.errors, []);
  await desk.context.close();
});
