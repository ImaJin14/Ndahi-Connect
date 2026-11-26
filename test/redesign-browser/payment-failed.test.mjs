import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";
import { MockPaymentAdapter } from "../../lib/payments.mjs";

// Payment problems (canvas: PhonePaymentFailed, #409; 24 Nov brief): a returning
// guest's saved checkout shows the state the server gives, in the board's six
// views, at 390 and 1280 px; each action leads to the right next step.
// Insufficient funds with a verified fee offers the cheaper bundle; without
// one, the fee is in the operator prompt. "Payment didn't go through?" on a
// live request shows "Waiting for confirmation". Local servers only,
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
// One saved checkout per state; the fee is verified on MTN only (PAYMENT_FEE_MTN).
const STATES = {
  insufficient: { phone: "670011245", network: "mtn", record: { status: "failed", failureState: "insufficient_funds", failureCode: "low_balance", fee: 20, total: 1020 },
    title: "Not enough balance", body: "Insufficient MoMo/OM balance. You need at least 1,020 XAF in your wallet to cover the bundle + 2% payment fee.",
    buttons: ["Switch to Daily (255 XAF)", "Retry", "Choose another bundle"], money: "No money was taken." },
  insufficientNoFee: { phone: "690011245", network: "orange", record: { status: "failed", failureState: "insufficient_funds", failureCode: "low_balance" },
    title: "Not enough balance", body: "Insufficient MoMo/OM balance. Your wallet needs the bundle price (1,000 XAF) plus the fee shown in the operator prompt.",
    buttons: ["Retry", "Choose another bundle"], money: "No money was taken." },
  expired: { phone: "670021245", network: "mtn", record: { status: "expired" },
    title: "Payment request expired", body: "Payment request expired. Dial *126# (MTN) or #150# (Orange) to approve pending prompts, or tap Retry to send a new pop-up.",
    buttons: ["Retry", "Change number or network"], money: "No money was taken." },
  cancelled: { phone: "670001245", network: "mtn", record: { status: "failed", failureState: "cancelled_or_pin", failureCode: "declined" },
    title: "Payment not approved", body: "Transaction cancelled or incorrect PIN entered. Tap Retry when you're ready to approve the prompt.",
    buttons: ["Retry", "Change number or network"], money: "No money was taken." },
  invalid: { phone: "670041245", network: "mtn", record: { status: "failed", failureState: "invalid_subscriber", failureCode: "wrong_network" },
    title: "Number not recognised", body: "This number isn't registered on MTN MoMo. Please check the number or switch networks.",
    buttons: ["Retry", "Pay with Orange Money", "Choose another bundle"], money: "No money was taken." },
  // A result held for review: still being checked, so it reads as unclear.
  unclear: { phone: "670051245", network: "mtn", record: { status: "expired", verificationHold: true },
    title: "We couldn't confirm this payment", body: "MTN didn't give a clear answer. If money left your wallet, your bundle will activate or the amount will be returned.",
    buttons: ["Check again", "Get help with this payment"], money: "Please don't pay again yet — you could be charged twice." },
};

test("a guest sees the payment's state as drawn and the next step, on phone and desktop", { timeout: 300000 }, async (t) => {
  const store = createStore({ persistent: false }), saved = {};
  const failedAt = new Date(Date.now() - 120000).toISOString(), lateCheckUntil = new Date(Date.now() + 864e5).toISOString();
  await store.transaction((s) => {
    for (const [name, { phone, network, record }] of Object.entries(STATES)) {
      const id = `pay-${name}`, requestKey = randomUUID() + randomUUID();
      s.payments.push({ id, customerId: `guest-${name}`, requestKey, checkoutAudience: "guest", provider: "mock", amount: 1000, currency: "XAF",
        planId: "weekly", planSnapshot: { id: "weekly", name: "Weekly", price: 1000 }, payerPhone: `237${phone}`, network,
        guestCheckoutDetails: { name: "Synthetic guest", phone, network }, createdAt: failedAt, creationState: "accepted",
        checkoutClosedAt: failedAt, lateCheckUntil, providerReference: `MP-${name}`, ...record, ...(record.status === "failed" ? { providerFailedAt: failedAt } : {}) });
      saved[name] = JSON.stringify({ value: JSON.stringify({ requestKey, planId: "weekly", paymentId: id }), expiresAt: Date.now() + 864e5 });
    }
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const staticServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${staticServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, payments: { mock: new MockPaymentAdapter() }, env: {
    NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
    PAYMENT_MODE: "mock", PAYMENT_FEE_MTN: "percent=2,on=price,round=nearest", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent",
  } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const screenshots = "/tmp/ndahi-payment-failed";
  await mkdir(screenshots, { recursive: true });
  t.after(async () => { await browser.close(); await close(apiServer); await close(staticServer); });
  const local = (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient");

  const open = async (name, width) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/*", local);
    await context.addCookies([{ name: "ndahi-checkout", value: encodeURIComponent(saved[name]), url: portal, sameSite: "Strict" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/onboarding.html`);
    const view = page.locator("#paymentFailed");
    await view.waitFor({ state: "visible" });
    return { context, page, view, errors };
  };
  const buttons = (page) => page.locator(".pay-failed__foot > :not([hidden])").evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));

  for (const width of [390, 1280]) {
    for (const [name, expected] of Object.entries(STATES)) {
      const { context, page, view, errors } = await open(name, width);
      try {
        await page.getByRole("heading", { name: expected.title, exact: true }).waitFor();
        assert.equal(await page.locator("#paymentFailedBody").textContent(), expected.body);
        assert.equal(await page.locator("#paymentFailedMoney").textContent(), expected.money);
        assert.deepEqual(await buttons(page), expected.buttons, `${name} ${width}: actions`);
        assert.equal(await page.locator("#paymentFailedBundle").textContent(), "Weekly");
        assert.equal(await page.locator("#paymentFailedPrice").textContent(), "1,000 XAF");
        // Fee and total only when the server quoted them.
        const fee = Boolean(expected.record.fee);
        assert.equal(await page.locator("#paymentFailedFeeRow").isVisible(), fee);
        if (fee) assert.equal(await page.locator("#paymentFailedTotal").textContent(), "1,020 XAF");
        assert.equal(await page.locator("#paymentFailedMethod").textContent(), `${expected.network === "orange" ? "Orange Money" : "MTN MoMo"} · ${expected.phone[0]}•• •• ${expected.phone.slice(5, 7)} ${expected.phone.slice(7)}`);
        assert.equal(await page.locator("#paymentFailedReference").textContent(), `MP-${name}`);
        assert.equal(await page.locator("#paymentFailedNumberField").isVisible(), name === "invalid");
        assert.equal(await page.locator("#paymentFailedChecks").isVisible(), name === "unclear");
        assert.equal(await page.locator("#pageContent").evaluate((element) => element.inert), true, "the page behind is inert");
        await page.evaluate(() => { for (const id of ["pageContent", "checkout"]) document.getElementById(id).style.display = "none"; });
        assert.deepEqual(await lowContrastText(page), [], `${name} ${width} contrast`);
        await page.evaluate(() => { for (const id of ["pageContent", "checkout"]) document.getElementById(id).style.display = ""; });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} ${width} overflow`);
        await page.screenshot({ path: `${screenshots}/${name}-${width}.png` });
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  }

  // Each action leads to its next step.
  let s = await open("insufficient", 390);
  await s.page.getByRole("button", { name: "Switch to Daily (255 XAF)", exact: true }).click();
  await s.page.locator("#checkout").waitFor({ state: "visible" });
  assert.equal(await s.page.locator('#plans [data-plan="daily"][aria-pressed="true"]').count() + await s.page.locator('.plan.selected[data-card="daily"]').count() > 0, true, "the cheaper bundle is chosen");
  assert.equal(await s.page.locator("#paymentFailed").isHidden(), true);
  await s.context.close();
  s = await open("invalid", 390);
  // The number shows masked until the field is used; a corrected number goes to checkout.
  assert.equal(await s.page.locator("#paymentFailedNumberMask").textContent(), "6•• •• 12 45");
  await s.page.locator("#paymentFailedNumber").fill("690041245");
  await s.page.getByRole("button", { name: "Retry", exact: true }).click();
  await s.page.locator("#checkout").waitFor({ state: "visible" });
  assert.equal(await s.page.locator('#purchase [name="phone"]').inputValue(), "690041245");
  await s.context.close();
  s = await open("invalid", 390);
  await s.page.getByRole("button", { name: "Pay with Orange Money", exact: true }).click();
  await s.page.locator("#checkout").waitFor({ state: "visible" });
  assert.equal(await s.page.locator('#purchase [name="network"]').inputValue(), "orange");
  await s.context.close();
  s = await open("cancelled", 390);
  await s.page.getByRole("button", { name: "Change number or network", exact: true }).click();
  await s.page.locator("#checkout").waitFor({ state: "visible" });
  assert.equal(await s.page.locator('#purchase [name="phone"]').inputValue(), "");
  assert.equal(await s.page.evaluate(() => document.activeElement?.name), "phone");
  await s.context.close();
  s = await open("insufficientNoFee", 390);
  await s.page.getByRole("button", { name: "Choose another bundle", exact: true }).click();
  await s.page.locator("#paymentFailed").waitFor({ state: "hidden" });
  assert.equal(await s.page.locator("#pageContent").evaluate((element) => element.inert), false);
  await s.context.close();
  s = await open("unclear", 390);
  assert.equal(await s.page.locator("#paymentFailedHelpLink").getAttribute("href"), "/help#payment");
  await s.page.getByRole("button", { name: "Check again", exact: true }).click();
  await s.page.getByText("Checked 2 times · we keep checking even if you close this page.", { exact: true }).waitFor();
  // The reference copies.
  await s.context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await s.page.getByRole("button", { name: "Copy", exact: true }).click();
  await s.page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await s.page.evaluate(() => navigator.clipboard.readText()), "MP-unclear");
  assert.deepEqual(s.errors, []);
  await s.context.close();

  // A live checkout: "Payment didn't go through?" shows "Waiting for confirmation" while it is open.
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
  await page.getByRole("heading", { name: "Waiting for confirmation", exact: true }).waitFor();
  assert.equal(await page.locator("#paymentFailedMoney").textContent(), "Please don't pay again yet — you could be charged twice.");
  assert.deepEqual(await buttons(page), ["Check again", "Get help with this payment"]);
  assert.equal(await page.locator("#paymentFailedMethod").textContent(), "MTN MoMo · 6•• •• 92 45");
  await page.screenshot({ path: `${screenshots}/live-pending-390.png` });
  await context.close();
});
