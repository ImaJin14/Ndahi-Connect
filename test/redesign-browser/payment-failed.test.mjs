import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Payment didn't go through (#251, canvas: PhonePaymentFailed): a returning
// guest's saved checkout shows the reason the API gives, at 390 and 1280 px, and
// each action leads to the right next step. A live checkout offers "Payment
// didn't go through?", which shows the timeout state. Local servers only,
// synthetic guests, mock provider, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => {
  const server = await listen(http.createServer());
  const port = server.address().port;
  await close(server);
  return port;
};
const secret = "redesign-payment-failed-secret";
const REASONS = {
  declined: { phone: "670001245", title: "Payment not approved", primary: "Try again", secondary: "Pay with Orange Money instead" },
  low_balance: { phone: "670011245", title: "Not enough Mobile Money", primary: "Try again", secondary: "Choose a smaller bundle" },
  timeout: { phone: "670021245", title: "Still waiting for MTN", primary: "Check again", secondary: "Get help with this payment" },
  wrong_network: { phone: "699001245", title: "This number isn't on MTN MoMo", primary: "Pay with Orange Money", secondary: "Use a different number" },
};

test("a guest sees why a payment didn't go through and the next step, on phone and desktop", { timeout: 240000 }, async (t) => {
  const store = createStore({ persistent: false }), saved = {};
  const failedAt = new Date(Date.now() - 120000).toISOString(), lateCheckUntil = new Date(Date.now() + 864e5).toISOString();
  await store.transaction((s) => {
    for (const [reason, { phone }] of Object.entries(REASONS)) {
      const id = randomUUID(), requestKey = randomUUID() + randomUUID();
      s.payments.push({ id, customerId: `guest-${reason}`, requestKey, checkoutAudience: "guest", provider: "mock", amount: 1000, currency: "XAF",
        planId: "weekly", planSnapshot: { id: "weekly", name: "Weekly", price: 1000 }, payerPhone: `237${phone}`, network: "mtn",
        guestCheckoutDetails: { name: "Synthetic guest", phone, network: "mtn" }, createdAt: failedAt, creationState: "accepted",
        checkoutClosedAt: failedAt, lateCheckUntil,
        ...(reason === "timeout" ? { status: "expired" } : { status: "failed", providerFailedAt: failedAt, failureCode: reason }) });
      saved[reason] = JSON.stringify({ value: JSON.stringify({ requestKey, planId: "weekly", paymentId: id }), expiresAt: Date.now() + 864e5 });
    }
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const staticServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${staticServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: {
    NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
    PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent",
  } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const screenshots = "/tmp/ndahi-payment-failed";
  await mkdir(screenshots, { recursive: true });
  t.after(async () => { await browser.close(); await close(apiServer); await close(staticServer); });
  const local = (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient");

  const open = async (reason, width) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/*", local);
    await context.addCookies([{ name: "ndahi-checkout", value: encodeURIComponent(saved[reason]), url: portal, sameSite: "Strict" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/onboarding.html`);
    const view = page.locator("#paymentFailed");
    await view.waitFor({ state: "visible" });
    return { context, page, view, errors };
  };

  for (const width of [390, 1280]) {
    for (const [reason, expected] of Object.entries(REASONS)) {
      const { context, page, view, errors } = await open(reason, width);
      try {
        await page.getByRole("heading", { name: expected.title, exact: true }).waitFor();
        assert.equal(await view.getAttribute("data-reason"), reason);
        assert.equal(await page.locator("#paymentFailedMoney").textContent(), reason === "timeout"
          ? "Please don't pay again yet — you could be charged twice." : "No money was taken.");
        assert.equal(await page.locator("#paymentFailedBundle").textContent(), "Weekly · 1,000 FCFA");
        assert.equal(await page.locator("#paymentFailedMethod").textContent(), "MTN MoMo · 6•• •• 12 45");
        assert.equal(await page.locator("#paymentFailedPrimary").textContent(), expected.primary);
        assert.equal(await view.getByText(expected.secondary, { exact: true }).isVisible(), true);
        assert.equal(await page.locator("#paymentFailedChecks").isVisible(), reason === "timeout");
        assert.equal(await page.locator("#pageContent").evaluate((element) => element.inert), true, "the page behind is inert");
        // Only the view is visible: the page behind it (whose plan rows carry
        // deliberately invisible overlay buttons) is fully covered.
        await page.evaluate(() => { for (const id of ["pageContent", "checkout"]) document.getElementById(id).style.display = "none"; });
        assert.deepEqual(await lowContrastText(page), [], `${reason} ${width} contrast`);
        await page.evaluate(() => { for (const id of ["pageContent", "checkout"]) document.getElementById(id).style.display = ""; });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${reason} ${width} overflow`);
        await page.screenshot({ path: `${screenshots}/${reason}-${width}.png` });
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  }

  // Each action leads to its next step.
  let s = await open("declined", 390);
  await s.page.getByRole("button", { name: "Pay with Orange Money instead", exact: true }).click();
  await s.page.locator("#checkout").waitFor({ state: "visible" });
  assert.equal(await s.page.locator("#paymentFailed").isHidden(), true);
  assert.equal(await s.page.locator('#purchase [name="network"]').inputValue(), "orange");
  await s.context.close();
  s = await open("wrong_network", 390);
  await s.page.getByRole("button", { name: "Use a different number", exact: true }).click();
  await s.page.locator("#checkout").waitFor({ state: "visible" });
  assert.equal(await s.page.locator('#purchase [name="phone"]').inputValue(), "");
  assert.equal(await s.page.evaluate(() => document.activeElement?.name), "phone");
  await s.context.close();
  s = await open("low_balance", 390);
  await s.page.getByRole("button", { name: "Choose a smaller bundle", exact: true }).click();
  await s.page.locator("#paymentFailed").waitFor({ state: "hidden" });
  assert.equal(await s.page.locator("#checkout").isHidden(), true);
  assert.equal(await s.page.locator("#pageContent").evaluate((element) => element.inert), false);
  await s.context.close();
  s = await open("timeout", 390);
  assert.equal(await s.page.locator("#paymentFailedHelpLink").getAttribute("href"), "/help#payment");
  await s.page.getByRole("button", { name: "Check again", exact: true }).click();
  await s.page.getByText("Checked 2 times · we keep checking for 15 minutes even if you close this page.", { exact: true }).waitFor();
  assert.equal(await s.page.locator("#paymentFailed").getAttribute("data-reason"), "timeout");
  assert.deepEqual(s.errors, []);
  await s.context.close();

  // A live checkout: "Payment didn't go through?" shows the timeout state while it is open.
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await context.route("**/*", local);
  const page = await context.newPage();
  await page.goto(`${portal}/onboarding.html`);
  await page.locator('#plans button[data-plan="weekly"]:not([disabled])').click();
  await page.locator("#checkout").waitFor({ state: "visible" });
  await page.locator('#purchase [name="name"]').fill("Synthetic buyer");
  await page.locator('#purchase [name="phone"]').fill("670099245");
  await page.locator('#purchase [name="network"]').selectOption("mtn");
  const acknowledge = page.locator('#purchase [name="acknowledge"]');
  if (await acknowledge.isVisible()) await acknowledge.check();
  await page.locator("#requestPayment").click();
  await page.getByRole("button", { name: "Payment didn't go through?", exact: true }).click();
  await page.getByRole("heading", { name: "Still waiting for MTN", exact: true }).waitFor();
  assert.equal(await page.locator("#paymentFailedMethod").textContent(), "MTN MoMo · 6•• •• 92 45");
  await page.screenshot({ path: `${screenshots}/live-timeout-390.png` });
  await context.close();
});
