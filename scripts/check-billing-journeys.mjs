import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { MockPaymentAdapter } from "../lib/payments.mjs";

// Isolated local fixtures: no .env, live payment, mail, router, or database access.
const apiPort = Number(process.env.BILLING_API_PORT || 8198), portalPort = Number(process.env.BILLING_PORT || 8197),
  adminPort = Number(process.env.BILLING_ADMIN_PORT || 8199), api = `http://127.0.0.1:${apiPort}`,
  portal = `http://127.0.0.1:${portalPort}`, admin = `http://127.0.0.1:${adminPort}`;
const fixtureOrigins = new Set([api, portal, admin].map((url) => new URL(url).origin));
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
// BILL-006: guest checkouts keep only a random key, in a cookie the browser drops within a day.
const portalKey = () => crypto.randomUUID().replaceAll("-", "");
const savedCookie = async (context) => (await context.cookies(portal)).find((cookie) => cookie.name === "ndahi-checkout");
const seedSavedCheckout = (context, saved) => context.addCookies([{ name: "ndahi-checkout",
  value: encodeURIComponent(JSON.stringify(saved)), url: portal, sameSite: "Strict", expires: Math.floor(Date.now() / 1000) + 86400 }]);
const legacyCheckoutKeys = (page) => page.evaluate(() => Object.keys(localStorage)
  .filter((key) => key === "ndahi-interrupted-checkout" || key.startsWith("ndahi-payment-")));
let browser;
try {
  await listen(server, apiPort); await listen(website, portalPort); await listen(adminSite, adminPort);
  const p = await post("/api/purchase", { phone: "670040001", name: "Billing Preview", email: "preview@example.test", planId: "weekly" });
  await store.transaction((s) => { s.customers[0].emailVerifiedAt = now.toISOString(); });
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
    // Keep optional remote assets such as web fonts out of these local fixtures.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return ["http:", "https:"].includes(url.protocol) && !fixtureOrigins.has(url.origin)
        ? route.abort("blockedbyclient") : route.continue();
    });
    if (signedIn) await context.addCookies([{ name: "customer_session", value: cookie.split("=")[1], domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
    try { await work(page, context); assert.deepEqual(errors, []); console.log(`PASS ${name}`); checks++; }
    catch (error) {
      for (const [index, openPage] of context.pages().entries()) {
        await openPage.screenshot({ path: `${screenshots}/failure-${checks}-${index}.png`, fullPage: true }).catch(() => {});
      }
      throw error;
    }
    finally { await context.close(); }
  }
  await scenario("checkout restores focus after close, Escape and backdrop", async (page) => {
    await page.goto(`${portal}/onboarding.html`);
    const opener = page.locator('[data-plan="weekly"]');
    for (const action of ["close", "escape", "backdrop"]) {
      await opener.click();
      assert.equal(await page.evaluate(() => document.activeElement?.id), "closeCheckout");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "checkoutHelp");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "closeCheckout");
      if (action === "escape") await page.keyboard.press("Escape");
      else if (action === "backdrop") await page.locator("#checkout").click({ position: { x: 5, y: 5 } });
      else await page.locator("#closeCheckout").click();
      await page.locator("#checkout").waitFor({ state: "hidden" });
      assert.equal(await opener.evaluate((button) => button === document.activeElement), true, action);
    }
  }, { signedIn: false });
  for (const [action, width] of [["close", 1440], ["escape", 390], ["backdrop", 1440]]) {
    await scenario(`a checkout that failed while away is released on return and restores focus through ${action} at ${width}px`, async (page, context) => {
      const input = { phone: "670040009", name: "Failed Guest", email: "failed@example.test",
        network: "mtn", planId: "weekly", requestKey: portalKey() };
      const purchase = await post("/api/purchase", input);
      await store.transaction((state) => {
        const payment = state.payments.find((payment) => payment.id === purchase.json.payment.id);
        payment.status = "failed";
        payment.providerFailedAt = now.toISOString();
        payment.failureReason = "Synthetic provider failure";
      });
      await seedSavedCheckout(context, { requestKey: input.requestKey, planId: "weekly", paymentId: purchase.json.payment.id });
      await page.goto(`${portal}/onboarding.html`);
      // No click needed: the visit itself checks the saved key and releases the packages.
      await page.getByText("Synthetic provider failure", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Resume saved payment" }).count(), 0);
      assert.equal(await savedCookie(context), undefined);
      const opener = page.locator('[data-plan="weekly"]');
      await opener.click();
      // The API supplied the contact details this device no longer keeps.
      assert.equal(await page.getByLabel("Your name", { exact: true }).inputValue(), input.name);
      assert.equal(await page.getByLabel("Payment phone number", { exact: true }).inputValue(), input.phone);
      if (action === "escape") await page.keyboard.press("Escape");
      else if (action === "backdrop") await page.locator("#checkout").click({ position: { x: 5, y: 5 } });
      else await page.locator("#closeCheckout").click();
      assert.equal(await opener.evaluate((button) => button === document.activeElement), true);
      assert.equal((await store.snapshot()).payments.filter((payment) => payment.customerName === "Failed Guest").length, 1);
    }, { signedIn: false, width });
  }
  await scenario("download and email a paid receipt", async (page) => {
    await page.goto(`${portal}/dashboard#payments`);
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
    assert.equal(await page.url(), `${portal}/dashboard#payments`);
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
    await page.goto(`${portal}/dashboard#payments`);
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
    await page.goto(`${portal}/dashboard#payments`);
    for (const status of ["expired", "failed", "cancelled"]) {
      const row = page.locator("#billing tbody tr").filter({ hasText: `Closed ${status} package` });
      await row.waitFor();
      assert.equal(await row.locator("button:not([data-copy-payment])").count(), 0, `${status} payments have no customer money actions`);
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
    await page.goto(`${portal}/dashboard#payments`);
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
    await page.goto(`${portal}/dashboard#payments`);
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
    await page.goto(`${portal}/dashboard#payments`);
    await page.getByText("Refund: failed", { exact: true }).waitFor();
    assert.equal(await page.getByText("Refund: completed", { exact: true }).count(), 0);
  });
  await scenario("lost response survives closed tab and resumes one guest payment", async (page, context) => {
    await page.goto(`${portal}/onboarding.html`);
    await page.locator('[data-plan="weekly"]').click();
    await page.getByLabel("Your name", { exact: true }).fill("Guest Customer");
    await page.getByLabel("Payment phone number", { exact: true }).fill("670040002");
    await page.locator('[name="email"]').fill("guest@example.test");
    await page.route("**/api/purchase", async (route) => { await route.fetch(); await route.abort("failed"); });
    await page.locator("#requestPayment").click();
    await page.locator("#message .error-card").waitFor();
    // Only the random key and plan remain on the device, and the browser drops them within a day.
    const saved = await savedCookie(context);
    assert.ok(saved.expires > Date.now() / 1000 + 23.9 * 3600 && saved.expires <= Date.now() / 1000 + 24 * 3600 + 60);
    assert.deepEqual(Object.keys(JSON.parse(decodeURIComponent(saved.value))).sort(), ["planId", "requestKey"]);
    assert.doesNotMatch(decodeURIComponent(saved.value), /Guest Customer|670040002|guest@example/);
    assert.deepEqual(await legacyCheckoutKeys(page), []);
    await page.close();
    const resumed = await context.newPage();
    await resumed.goto(`${portal}/onboarding.html`);
    await resumed.getByRole("button", { name: "Resume saved payment" }).click();
    await resumed.getByRole("button", { name: "Simulate payment approval" }).waitFor();
    assert.equal((await store.snapshot()).payments.length, 2);
    await resumed.keyboard.press("Escape");
    const returnButton = resumed.getByRole("button", { name: "Return to payment" });
    await returnButton.waitFor();
    assert.equal(await returnButton.evaluate((button) => button === document.activeElement), true);
    await returnButton.click();
    await resumed.getByRole("button", { name: "Simulate payment approval" }).click();
    await resumed.waitForURL("**/verify.html?setup=pin");
    assert.equal(await savedCookie(context), undefined);
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
  await scenario("a paid guest checkout resumes through its private key and reaches PIN setup", async (page, context) => {
    const input = { phone: "670040005", name: "Paid Guest", email: "paid-guest@example.test",
      network: "mtn", planId: "weekly", requestKey: portalKey() };
    const purchase = await post("/api/purchase", input);
    await post(`/api/payments/${purchase.json.payment.id}/confirm`, {});
    await seedSavedCheckout(context, { requestKey: input.requestKey, planId: "weekly", paymentId: purchase.json.payment.id });
    await page.goto(`${portal}/onboarding.html`);
    await page.getByText(/saved on this device was confirmed/).waitFor();
    const statusRequest = page.waitForRequest((request) => request.url().endsWith(`/payments/${purchase.json.payment.id}/status`));
    await page.getByRole("button", { name: "Resume saved payment" }).click();
    const request = await statusRequest;
    assert.equal(request.headers()["x-checkout-key"], input.requestKey);
    await page.waitForURL("**/verify.html?setup=pin");
    assert.equal(await savedCookie(context), undefined);
    assert.equal((await store.snapshot()).payments.filter((p) => p.customerName === "Paid Guest").length, 1);
  }, { signedIn: false });
  await scenario("an expired guest checkout closes and can be started again", async (page, context) => {
    await page.goto(`${portal}/onboarding.html`);
    await page.locator('[data-plan="weekly"]').click();
    await page.getByLabel("Your name", { exact: true }).fill("Late Guest");
    await page.getByLabel("Payment phone number", { exact: true }).fill("670040003");
    await page.locator('[name="email"]').fill("late@example.test");
    await page.route("**/api/purchase", async (route) => { await route.fetch(); await route.abort("failed"); });
    await page.locator("#requestPayment").click();
    await page.locator("#message .error-card").waitFor();
    await page.close();
    // The customer returns after the approval window and grace have passed.
    now = new Date(Date.now() + 8 * 60000);
    const resumed = await context.newPage();
    await resumed.goto(`${portal}/onboarding.html`);
    // The visit closes the stale checkout without a click and forgets its key.
    await resumed.getByText(/was not confirmed in time, so it was closed/).waitFor();
    assert.equal(await savedCookie(context), undefined);
    assert.equal((await store.snapshot()).payments.find((x) => x.customerName === "Late Guest").status, "expired");
    assert.equal(await resumed.getByRole("button", { name: "Resume saved payment" }).count(), 0, "no stale resume prompt");
    // A fresh checkout opens with the details the API returned already filled in.
    await resumed.locator('[data-plan="weekly"]').click();
    assert.equal(await resumed.locator("#selected").textContent(), "Buy Weekly");
    assert.match(await resumed.locator("#checkoutSummary").textContent(), /500 FCFA\s*\/\s*7 days/);
    assert.match(await resumed.locator("#checkoutSummary").textContent(), /5 GB data\s*·\s*1 device/);
    assert.match(await resumed.locator("#checkoutPolicy").textContent(), /starts on payment confirmation and lasts 7 days/);
    assert.match(await resumed.locator("#checkoutPolicy").textContent(), /Closing this page does not cancel a submitted payment/);
    assert.match(await resumed.locator("#checkoutPolicy").textContent(), /Refund requests require support review/);
    assert.equal(await resumed.getByLabel("Your name", { exact: true }).inputValue(), "Late Guest");
    assert.equal(await resumed.getByLabel("Payment phone number", { exact: true }).inputValue(), "670040003");
    assert.equal(await resumed.locator('[name="email"]').inputValue(), "late@example.test");
    await resumed.keyboard.press("Escape");
    const replacement = resumed.locator('[data-plan="weekly"]');
    assert.equal(await replacement.evaluate((button) => button === document.activeElement), true,
      "closing the fresh checkout returns focus to the current package control");
    await replacement.click();
    await resumed.locator("#requestPayment").click();
    await resumed.getByRole("button", { name: "Simulate payment approval" }).waitFor();
    assert.equal((await store.snapshot()).payments.filter((x) => x.customerName === "Late Guest").length, 2);
    await resumed.screenshot({ path: `${screenshots}/expired-checkout-restarted.png`, fullPage: true });
  }, { signedIn: false });
  await scenario("a resumed checkout for a discontinued package cannot restart it after expiry", async (page, context) => {
    const input = { phone: "670040004", name: "Archived Guest", email: "archived@example.test",
      network: "orange", planId: "archived-guest-package", requestKey: portalKey() };
    await store.transaction((s) => { s.bundles.push({ ...s.payments[0].planSnapshot,
      id: input.planId, name: "Archived Guest Package" }); });
    const purchase = await post("/api/purchase", input);
    await store.transaction((s) => { s.bundles.find((plan) => plan.id === input.planId).discontinued = true; });
    await seedSavedCheckout(context, { requestKey: input.requestKey, planId: input.planId, paymentId: purchase.json.payment.id });
    await page.goto(`${portal}/onboarding.html`);
    await page.getByRole("button", { name: "Resume saved payment" }).click();
    const recheck = page.getByRole("button", { name: "Recheck payment" });
    await recheck.waitFor();
    // The approval window passes while the resumed checkout is open.
    now = new Date(Date.now() + 8 * 60000);
    await recheck.click();
    await page.getByText(/was not confirmed in time, so it was closed/).waitFor();
    assert.equal(await page.locator("#selected").textContent(), "Choose another package");
    assert.match(await page.locator("#checkoutSummary").textContent(), /saved package is unavailable/);
    assert.equal(await page.locator("#requestPayment").isDisabled(), true);
    assert.equal(await page.locator('select[name="network"]').inputValue(), "orange");
    assert.equal(await savedCookie(context), undefined);
    assert.equal((await store.snapshot()).payments.filter((p) => p.customerName === "Archived Guest").length, 1);
    await page.locator("#closeCheckout").click();
    assert.equal(await page.evaluate(() => {
      const focused = document.activeElement;
      return focused?.matches('[data-plan]') && focused.isConnected && !focused.disabled && focused.getClientRects().length > 0;
    }), true, "a discontinued package returns focus to an available package");
    await page.locator('[data-plan="monthly"]').click();
    assert.equal(await page.locator("#selected").textContent(), "Buy Monthly");
    assert.equal(await page.locator("#requestPayment").isDisabled(), false);
    assert.equal(await page.getByLabel("Payment phone number", { exact: true }).inputValue(), input.phone);
    await page.locator("#requestPayment").click();
    await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
    const payments = (await store.snapshot()).payments.filter((p) => p.customerName === "Archived Guest");
    assert.equal(payments.length, 2);
    assert.equal(payments[0].planId, "monthly");
  }, { signedIn: false });
  await scenario("a guest request the API turns down is not kept on the device", async (page, context) => {
    await page.goto(`${portal}/onboarding.html`);
    await page.locator('[data-plan="weekly"]').click();
    await page.getByLabel("Your name", { exact: true }).fill("Rejected Guest");
    await page.getByLabel("Payment phone number", { exact: true }).fill("670040006");
    await page.route("**/api/purchase", (route) => route.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: "Fixture rejection" }) }));
    await page.locator("#requestPayment").click();
    await page.getByText("Fixture rejection").waitFor();
    assert.deepEqual((await context.cookies(portal)).filter((cookie) => cookie.name.startsWith("ndahi-")).map((cookie) => cookie.name), []);
    await page.unroute("**/api/purchase");
    await page.reload();
    await page.locator('[data-plan="weekly"]').waitFor();
    assert.equal(await page.getByRole("button", { name: "Resume saved payment" }).count(), 0);
    assert.equal(await page.locator('[data-plan="weekly"]').isDisabled(), false);
  }, { signedIn: false });
  await scenario("an older saved checkout keeps its key but loses the stored contact details", async (page, context) => {
    const input = { phone: "670040007", name: "Legacy Guest", email: "legacy@example.test",
      network: "mtn", planId: "weekly", requestKey: portalKey() };
    const purchase = await post("/api/purchase", input);
    await page.goto(`${portal}/help`);
    await page.evaluate((saved) => {
      localStorage.setItem("ndahi-interrupted-checkout", JSON.stringify(saved));
      localStorage.setItem("ndahi-payment-purchase-weekly", saved.input.requestKey);
    }, { input, paymentId: purchase.json.payment.id });
    await page.goto(`${portal}/onboarding.html`);
    await page.getByRole("button", { name: "Resume saved payment" }).waitFor();
    assert.deepEqual(await legacyCheckoutKeys(page), []);
    const saved = await savedCookie(context);
    assert.deepEqual(JSON.parse(decodeURIComponent(saved.value)), { requestKey: input.requestKey, planId: "weekly", paymentId: purchase.json.payment.id });
    await page.getByRole("button", { name: "Resume saved payment" }).click();
    await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
    assert.equal(await page.getByLabel("Your name", { exact: true }).inputValue(), input.name);
    assert.equal((await store.snapshot()).payments.filter((p) => p.customerName === "Legacy Guest").length, 1);
  }, { signedIn: false });
  await scenario("guest recovery never prefills an existing account's private profile", async (page, context) => {
    const input = { phone: "670040008", name: "Guest Supplied Name", email: "guest-contact@example.test", planId: "weekly", network: "mtn", requestKey: portalKey() };
    await store.transaction((s) => { s.customers.push({ id: "private-owner", phone: input.phone, name: "Private Owner Name", email: "private-owner@example.test" }); });
    const created = await post("/api/purchase", input);
    await seedSavedCheckout(context, { requestKey: input.requestKey, planId: input.planId, paymentId: created.json.payment.id });
    await page.goto(`${portal}/onboarding.html`);
    await page.getByRole("button", { name: "Resume saved payment", exact: true }).click();
    await page.getByRole("button", { name: "Simulate payment approval", exact: true }).waitFor();
    assert.equal(await page.locator('[name="name"]').inputValue(), input.name);
    assert.equal(await page.locator('[name="email"]').inputValue(), input.email);
    const customer = (await store.snapshot()).customers.find((c) => c.id === "private-owner");
    assert.equal(customer.name, "Private Owner Name"); assert.equal(customer.email, "private-owner@example.test");
    assert.equal((await store.snapshot()).payments.find((p) => p.id === created.json.payment.id).status, "pending");
  }, { signedIn: false });
  for (const outcome of ["paid-expired-key", "unrecognised-key"]) await scenario(`unavailable guest recovery gives honest payment guidance for ${outcome}`, async (page, context) => {
    const requestKey = portalKey();
    let paymentId;
    if (outcome === "paid-expired-key") {
      const created = await post("/api/purchase", { phone: "670040009", name: "Paid Guest", planId: "weekly", requestKey });
      paymentId = created.json.payment.id;
      await post(`/api/payments/${paymentId}/confirm`, {});
      now = new Date(+now + 25 * 3600000);
    }
    // A lost POST response can leave only the key on the device, without an ID.
    await seedSavedCheckout(context, { requestKey, planId: "weekly" });
    await page.goto(`${portal}/onboarding.html`);
    await page.getByText(/This does not confirm whether money was deducted/).waitFor();
    const message = await page.locator("#planNotice").innerText();
    assert.ok(!/nothing was charged|did not reach NDAHI/i.test(message));
    await page.getByRole("link", { name: "Check payments", exact: true }).waitFor();
    await page.getByRole("link", { name: "Payment help", exact: true }).first().waitFor();
    assert.equal(await savedCookie(context), undefined);
    const payments = (await store.snapshot()).payments;
    assert.equal(payments.length, outcome === "paid-expired-key" ? 2 : 1, "recovery never creates another charge");
    if (paymentId) assert.equal(payments.find((p) => p.id === paymentId).status, "paid");
    await page.screenshot({ path: `${screenshots}/guest-${outcome}-help.png`, fullPage: true });
  }, { signedIn: false, width: 390 });
  await scenario("an expired renewal stops blocking the account", async (page) => {
    await post("/api/account/plan/purchase", { action: "renew", planId: "weekly", requestKey: "abandoned-renewal" }, cookie);
    now = new Date(Date.now() + 8 * 60000);
    await page.goto(`${portal}/onboarding.html?action=renew`);
    // Reading the account closes the stale renewal before it can block this checkout.
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
    await page.goto(`${portal}/dashboard#payments`);
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
