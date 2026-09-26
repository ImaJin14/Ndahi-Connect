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
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download receipt" }).click();
    const file = await download;
    assert.match(await readFile(await file.path(), "utf8"), /Weekly/);
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
    await adminPage.getByRole("button", { name: "Recheck refund" }).waitFor();
    await page.reload(); await page.getByText("Refund: pending", { exact: true }).waitFor();
    refundStatus = "completed"; now = new Date(+now + 31000);
    await adminPage.getByRole("button", { name: "Recheck refund" }).click();
    await adminPage.getByText(/Refund: completed/).waitFor();
    await page.reload(); await page.getByText("Refund: completed", { exact: true }).waitFor();
    assert.equal(refundCalls, 1);
    assert.equal(await page.getByRole("link", { name: "Download receipt" }).count(), 1);
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
    await page.getByRole("link", { name: "Download receipt" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("main *")].filter((el) => el.getBoundingClientRect().right > innerWidth).slice(0, 8).map((el) => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })))));
    await page.locator("#billing").screenshot({ path: `${screenshots}/billing-${width}.png` });
  }, { width });
  console.log(`${checks} billing browser scenarios passed. Screenshots saved.`);
} finally {
  await browser?.close(); await close(website); await close(adminSite); await close(server);
}
