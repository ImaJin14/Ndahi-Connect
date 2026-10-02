import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { MockPaymentAdapter } from "../lib/payments.mjs";

// Isolated local fixtures: no .env, live payment, mail, router, or database access.
const apiPort = Number(process.env.BILLING_API_PORT || 8198), portalPort = Number(process.env.BILLING_PORT || 8197),
  adminPort = Number(process.env.BILLING_ADMIN_PORT || 8199), api = `http://127.0.0.1:${apiPort}`,
  portal = `http://127.0.0.1:${portalPort}`, admin = `http://127.0.0.1:${adminPort}`;
const store = createStore({ persistent: false });
const paymentAdapter = new MockPaymentAdapter();
let refundStatus = "pending", refundCalls = 0, now = new Date();
paymentAdapter.refundPayment = async () => { refundCalls++; return { status: "pending", providerReference: "test-refund-1" }; };
paymentAdapter.verifyRefund = async () => ({ status: refundStatus, providerReference: "test-refund-1" });
const server = createServer({ store, payments: { mock: paymentAdapter }, now: () => now, env: {
  NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  BILLING_WORKER_ENABLED: "false", SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
  ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, ADMIN_PIN: "9999",
} });
const website = createStaticServer("customer", { apiUrl: api }), adminSite = createStaticServer("admin", { apiUrl: api });
const listen = (app, port) => new Promise((resolve, reject) => { app.once("error", reject); app.listen(port, "127.0.0.1", resolve); });
const close = (app) => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
const post = async (path, input, cookie = "") => {
  const response = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(input) });
  const json = await response.json(); assert.ok(response.ok, JSON.stringify(json));
  return { response, json };
};
let browser;
try {
  await listen(server, apiPort); await listen(website, portalPort); await listen(adminSite, adminPort);
  const p = await post("/api/purchase", { phone: "670040001", name: "Billing Preview", email: "preview@example.test", planId: "weekly" });
  const id = p.json.payment.id;
  const paid = await post(`/api/payments/${id}/confirm`, {});
  const login = await post("/api/account/setup/pin", { phone: "670040001", code: paid.json.access.code, pin: "2468", confirmPin: "2468" });
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  const adminLogin = await post("/api/admin/login", { pin: "9999" });
  const adminCookie = adminLogin.response.headers.get("set-cookie").split(";")[0];
  const baseline = await store.snapshot();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const screenshots = process.env.BILLING_SCREENSHOTS || "/tmp/ndahi-billing-checks";
  await mkdir(screenshots, { recursive: true });
  let checks = 0;
  async function scenario(name, work, { signedIn = true, width = 1440 } = {}) {
    await store.transaction((s) => Object.assign(s, structuredClone(baseline)));
    refundStatus = "pending"; refundCalls = 0; now = new Date();
    const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true });
    if (signedIn) await context.addCookies([{ name: "customer_session", value: cookie.split("=")[1], domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try { await work(page, context); assert.deepEqual(errors, []); console.log(`PASS ${name}`); checks++; }
    finally { await context.close(); }
  }
  await scenario("download and email a paid receipt", async (page) => {
    await page.goto(`${portal}/dashboard`);
    const receiptButton = page.getByRole("button", { name: "View receipt", exact: true });
    await receiptButton.click();
    const dialog = page.getByRole("dialog", { name: "Payment receipt" });
    await dialog.waitFor();
    await dialog.getByText("Weekly", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "receiptClose");
    assert.equal(page.context().pages().length, 1, "receipts stay in the dashboard instead of opening a tab");
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download PDF" }).click();
    const file = await download;
    assert.match(file.suggestedFilename(), /^ndahi-receipt-[\w-]+\.pdf$/);
    assert.equal((await readFile(await file.path())).subarray(0, 5).toString(), "%PDF-");
    assert.equal(await page.url(), `${portal}/dashboard`);
    await dialog.screenshot({ path: `${screenshots}/receipt-popup-desktop.png` });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await receiptButton.evaluate((button) => button === document.activeElement), true,
      "closing the receipt returns keyboard focus to its opener");
    await page.getByRole("button", { name: "Email receipt" }).click();
    await page.getByText("Receipt sent to your account email.").waitFor();
    await page.locator("#billing").screenshot({ path: `${screenshots}/billing-desktop.png` });
  });
  await scenario("refund request and provider pending/completed states match customer and admin", async (page, context) => {
    await page.goto(`${portal}/dashboard`);
    await page.getByText("Request a refund", { exact: true }).click();
    await page.getByLabel("Reason", { exact: true }).fill("Connection unavailable");
    await page.getByRole("button", { name: "Send refund request" }).click();
    await page.getByText("Refund: requested", { exact: true }).waitFor();
    await context.addCookies([{ name: "admin_session", value: adminCookie.split("=")[1], domain: "127.0.0.1", path: "/api/admin", httpOnly: true, sameSite: "Strict" }]);
    const adminPage = await context.newPage();
    await adminPage.goto(`${admin}/dashboard`);
    await adminPage.locator('[data-tab="payments"]').click();
    adminPage.on("dialog", (dialog) => dialog.accept());
    await adminPage.getByRole("button", { name: "Approve full refund" }).click();
    await adminPage.getByRole("button", { name: "Check refund status" }).waitFor();
    await page.reload(); await page.getByText("Refund: pending", { exact: true }).waitFor();
    refundStatus = "completed"; now = new Date(+now + 31000);
    await adminPage.getByRole("button", { name: "Check refund status" }).click();
    await adminPage.getByText(/Refund: completed/).waitFor();
    await page.reload(); await page.getByText("Refund: completed", { exact: true }).waitFor();
    assert.equal(refundCalls, 1);
    assert.equal(await page.getByRole("button", { name: "View receipt" }).count(), 1);
  });
  await scenario("unconfirmed terminal payments have no receipt, refund or recheck actions", async (page) => {
    await store.transaction((s) => {
      const original = s.payments[0];
      for (const status of ["expired", "failed", "cancelled"]) s.payments.push({
        ...structuredClone(original), id: `terminal-${status}`, status, confirmedAt: null,
        planSnapshot: { ...original.planSnapshot, name: `Closed ${status} package` },
        // Historical receipt/refund fields do not make an unconfirmed payment refundable.
        receipt: structuredClone(original.receipt), refund: { status: "pending" },
      });
      s.payments.push({ ...structuredClone(original), id: "expired-confirmed", status: "expired",
        planSnapshot: { ...original.planSnapshot, name: "Historical expired package" }, refund: { status: "pending" },
      });
    });
    await page.goto(`${portal}/dashboard`);
    for (const status of ["expired", "failed", "cancelled"]) {
      const row = page.locator("#billing tbody tr").filter({ hasText: `Closed ${status} package` });
      await row.waitFor();
      assert.equal(await row.getByRole("button").count(), 0, `${status} payments have no customer money actions`);
      assert.equal(await row.getByText("Request a refund", { exact: true }).count(), 0);
    }
    assert.equal(await page.getByRole("button", { name: "View receipt" }).count(), 2, "confirmed receipts stay available");
    const historical = page.locator("#billing tbody tr").filter({ hasText: "Historical expired package" });
    assert.equal(await historical.getByRole("button", { name: /Check .* status/ }).count(), 0);
    assert.equal(await historical.getByText("Request a refund", { exact: true }).count(), 0);
  });
  await scenario("receipt preview escapes provider data and rejects an HTML download", async (page) => {
    await page.route("**/api/account/payments/*/receipt?format=json", async (route) => {
      const response = await route.fetch(), result = await response.json();
      result.receipt.customerName = '<img src="x" onerror="window.receiptInjected=true">';
      await route.fulfill({ response, json: result });
    });
    await page.route("**/api/account/payments/*/receipt", (route) => route.fulfill({
      contentType: "text/html", body: "<html><body>old receipt</body></html>",
    }));
    await page.goto(`${portal}/dashboard`);
    await page.getByRole("button", { name: "View receipt", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Payment receipt" });
    await dialog.getByRole("button", { name: "Download PDF" }).waitFor();
    assert.equal(await dialog.locator("img").count(), 0);
    assert.match(await dialog.textContent(), /<img src="x"/);
    await dialog.getByRole("button", { name: "Download PDF" }).click();
    await dialog.getByText("The PDF receipt is unavailable. Please try again.").waitFor();
    assert.equal(await page.evaluate(() => window.receiptInjected), undefined);
    assert.equal(page.context().pages().length, 1);
  });
  await scenario("payment history and receipts show the selected mobile money network", async (page) => {
    await store.transaction((s) => {
      const original = s.payments[0];
      original.provider = "mesomb"; original.network = "mtn";
      original.receipt.provider = "mesomb";
      delete original.receipt.network;
      s.payments.push({ ...structuredClone(original), id: "orange-payment", network: "orange",
        planSnapshot: { ...original.planSnapshot, name: "Orange package" },
        receipt: { ...original.receipt, number: "NC-orange-payment", paymentId: "orange-payment" },
      });
    });
    await page.goto(`${portal}/dashboard`);
    const mtnRow = page.locator("#billing tbody tr").filter({ hasText: "Weekly" }),
      orangeRow = page.locator("#billing tbody tr").filter({ hasText: "Orange package" });
    await mtnRow.waitFor(); await orangeRow.waitFor();
    assert.match(await mtnRow.textContent(), /MTN Mobile Money/);
    assert.match(await orangeRow.textContent(), /Orange Money/);
    assert.doesNotMatch(await page.locator("#billing").textContent(), /mesomb/i);
    await mtnRow.getByRole("button", { name: "View receipt" }).click();
    const dialog = page.getByRole("dialog", { name: "Payment receipt" });
    await dialog.getByText("MTN Mobile Money", { exact: true }).waitFor();
    assert.doesNotMatch(await dialog.textContent(), /mesomb/i);
    await dialog.getByRole("button", { name: "Close" }).click();
    await orangeRow.getByRole("button", { name: "View receipt" }).click();
    await dialog.getByText("Orange Money", { exact: true }).waitFor();
  });
  await scenario("refund failure is visible without claiming completed payout", async (page) => {
    await store.transaction((s) => { s.payments[0].refund = { id: "rf", status: "failed", message: "Your provider reports that the refund failed. Contact support for review." }; });
    await page.goto(`${portal}/dashboard`);
    await page.getByText("Refund: failed", { exact: true }).waitFor();
    assert.equal(await page.getByText("Refund: completed", { exact: true }).count(), 0);
  });
  await scenario("lost response survives closed tab and resumes one guest payment", async (page, context) => {
    await page.goto(`${portal}/onboarding.html`);
    await page.locator('[data-plan="weekly"]').click();
    await page.getByLabel("Your name", { exact: true }).fill("Guest Customer");
    await page.getByLabel("Payment phone number", { exact: true }).fill("670040002");
    await page.getByLabel("Email address", { exact: true }).fill("guest@example.test");
    await page.route("**/api/purchase", async (route) => { await route.fetch(); await route.abort("failed"); });
    await page.locator("#requestPayment").click();
    await page.locator("#message .error-card").waitFor();
    await page.close();
    const resumed = await context.newPage();
    await resumed.goto(`${portal}/onboarding.html`);
    await resumed.getByRole("button", { name: "Resume saved payment" }).click();
    await resumed.getByRole("button", { name: "Simulate payment approval" }).waitFor();
    assert.equal((await store.snapshot()).payments.length, 2);
    await resumed.getByRole("button", { name: "Simulate payment approval" }).click();
    await resumed.waitForURL("**/verify.html?setup=pin");
    assert.equal(await resumed.evaluate(() => localStorage.getItem("ndahi-interrupted-checkout")), null);
  }, { signedIn: false });
  await scenario("pending renewal is recovered after browser state is lost", async (page) => {
    await post("/api/account/plan/purchase", { action: "renew", planId: "weekly", requestKey: "interrupted-account" }, cookie);
    await page.goto(`${portal}/onboarding.html?action=renew`);
    await page.getByRole("button", { name: "Check payment status" }).waitFor();
    assert.equal(await page.locator('[data-plan="weekly"]').isDisabled(), true);
    await page.getByRole("button", { name: "Check payment status" }).click();
    await page.getByText(/still awaiting approval/).waitFor();
    assert.equal((await store.snapshot()).payments.length, 2);
  });
  await scenario("an expired guest checkout closes and can be started again", async (page, context) => {
    await page.goto(`${portal}/onboarding.html`);
    await page.locator('[data-plan="weekly"]').click();
    await page.getByLabel("Your name", { exact: true }).fill("Late Guest");
    await page.getByLabel("Payment phone number", { exact: true }).fill("670040003");
    await page.getByLabel("Email address", { exact: true }).fill("late@example.test");
    await page.route("**/api/purchase", async (route) => { await route.fetch(); await route.abort("failed"); });
    await page.locator("#requestPayment").click();
    await page.locator("#message .error-card").waitFor();
    await page.close();
    // The customer returns after the approval window and grace have passed.
    now = new Date(Date.now() + 8 * 60000);
    const resumed = await context.newPage();
    await resumed.goto(`${portal}/onboarding.html`);
    await resumed.getByRole("button", { name: "Resume saved payment" }).click();
    await resumed.getByText(/was not confirmed in time, so it was closed/).waitFor();
    assert.equal(await resumed.evaluate(() => localStorage.getItem("ndahi-interrupted-checkout")), null);
    assert.equal((await store.snapshot()).payments.find((x) => x.customerName === "Late Guest").status, "expired");
    // The same dialog offers a fresh checkout with the saved details already filled in.
    assert.equal(await resumed.locator("#selected").textContent(), "Buy Weekly");
    assert.equal(await resumed.getByRole("button", { name: "Resume saved payment" }).count(), 0, "the stale resume notice is replaced");
    assert.equal(await resumed.getByLabel("Payment phone number", { exact: true }).inputValue(), "670040003");
    await resumed.locator("#requestPayment").click();
    await resumed.getByRole("button", { name: "Simulate payment approval" }).waitFor();
    assert.equal((await store.snapshot()).payments.filter((x) => x.customerName === "Late Guest").length, 2);
    await resumed.screenshot({ path: `${screenshots}/expired-checkout-restarted.png`, fullPage: true });
  }, { signedIn: false });
  await scenario("an expired renewal stops blocking the account", async (page) => {
    await post("/api/account/plan/purchase", { action: "renew", planId: "weekly", requestKey: "abandoned-renewal" }, cookie);
    now = new Date(Date.now() + 8 * 60000);
    await page.goto(`${portal}/onboarding.html?action=renew`);
    await page.getByRole("button", { name: "Check payment status" }).click();
    // The check closes the stale renewal and the page reloads without the blocking notice.
    await page.getByRole("button", { name: "Check payment status" }).waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector('[data-plan="weekly"]')?.disabled === false);
    const renewal = (await store.snapshot()).payments.find((x) => x.requestKey === "abandoned-renewal");
    assert.deepEqual([renewal.status, Boolean(renewal.checkoutClosedAt)], ["expired", true]);
  });
  await scenario("billing rules are available before payment", async (page) => {
    await page.goto(`${portal}/onboarding.html?action=renew`);
    await page.locator('[data-plan="weekly"]').click();
    assert.match(await page.locator("#checkoutPolicy").textContent(), /Closing this page does not cancel/);
    const link = page.getByRole("link", { name: "Read payment, renewal, switching and cancellation rules" });
    assert.equal(await link.isVisible(), true);
    await page.goto(`${portal}/billing-terms.html`);
    await page.getByRole("heading", { name: "Cancellation and refunds" }).waitFor();
  });
  for (const width of [390, 320]) await scenario(`billing actions at ${width}px`, async (page) => {
    await page.goto(`${portal}/dashboard`);
    await page.getByRole("button", { name: "View receipt" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("main *")].filter((el) => el.getBoundingClientRect().right > innerWidth).slice(0, 8).map((el) => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })))));
    await page.locator("#billing").screenshot({ path: `${screenshots}/billing-${width}.png` });
    await page.getByRole("button", { name: "View receipt" }).click();
    const dialog = page.getByRole("dialog", { name: "Payment receipt" });
    await dialog.getByRole("button", { name: "Download PDF" }).waitFor();
    assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "receipt fits narrow mobile screens");
    await dialog.screenshot({ path: `${screenshots}/receipt-popup-${width}.png` });
  }, { width });
  console.log(`${checks} billing browser scenarios passed. Screenshots saved.`);
} finally {
  await browser?.close(); await close(website); await close(adminSite); await close(server);
}
