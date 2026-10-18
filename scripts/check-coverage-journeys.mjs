import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";

// Local mock services only. The synthetic edge header is injected by the test
// harness to exercise both coverage states without a live router or payment.
const inside = "203.0.113.10", outside = "198.51.100.7";
const store = createStore({ persistent: false });
const server = createServer({ store, env: {
  NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  TRUST_PROXY: "render", COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: inside,
  BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", SESSION_COOKIE_SECURE: "false",
} });
const listen = async (app) => {
  await new Promise((resolve, reject) => { app.once("error", reject); app.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${app.address().port}`;
};
const close = (app) => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
const api = await listen(server), website = createStaticServer("customer", { apiUrl: api });
const portal = await listen(website);
// Trusted origins are fixed when services are constructed. Let browser requests
// use the fixture's configured origin; respond with the actual local origin.
const post = async (path, input, headers = {}) => {
  const response = await fetch(api + path, { method: "POST", headers: {
    "content-type": "application/json", "cf-connecting-ip": inside, ...headers,
  }, body: JSON.stringify(input) });
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return { response, body };
};
let browser, checks = 0;
try {
  const purchase = await post("/api/purchase", { phone: "670041001", planId: "weekly" });
  const paid = await post(`/api/payments/${purchase.body.payment.id}/confirm`, {});
  const setup = await post("/api/account/setup/pin", { phone: "670041001", code: paid.body.access.code, pin: "2468", confirmPin: "2468" });
  const cookie = setup.response.headers.get("set-cookie").split(";")[0];
  const baseline = await store.snapshot();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const screenshots = "/tmp/ndahi-coverage-checks";
  await mkdir(screenshots, { recursive: true });
  async function scenario(name, work, { signedIn = false, address = outside, width = 390 } = {}) {
    await store.transaction((s) => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    let currentAddress = address;
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === portal) return route.continue();
      if (url.origin !== api) return route.abort("blockedbyclient");
      const response = await route.fetch({ headers: {
        ...request.headers(), origin: "http://localhost:8080", "cf-connecting-ip": currentAddress,
      } });
      await route.fulfill({ response, headers: {
        ...response.headers(), "access-control-allow-origin": portal,
        "access-control-allow-credentials": "true",
      } });
    });
    if (signedIn) await context.addCookies([{ name: "customer_session", value: cookie.split("=")[1], domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await work(page, (address) => { currentAddress = address; });
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}`); checks++;
    } catch (error) {
      await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true });
      throw error;
    } finally { await context.close(); }
  }
  await scenario("guests can browse packages off-network and recheck after joining Wi-Fi", async (page, changeAddress) => {
    await page.goto(portal + "/onboarding.html");
    await page.locator("#purchaseAccessNotice").waitFor({ state: "visible" });
    assert.match(await page.locator("#purchaseAccessNotice").innerText(), /Connect to NDAHI Wi-Fi to purchase a bundle/);
    assert.ok(await page.locator("[data-plan]").count() > 0);
    assert.equal(await page.locator("[data-plan]:enabled").count(), 0);
    await page.screenshot({ path: `${screenshots}/packages-mobile.png`, fullPage: true });
    changeAddress(inside);
    await page.locator("#recheckPurchaseAccess").click();
    await page.locator('[data-plan="weekly"]:enabled').waitFor();
    assert.equal(await page.locator("#purchaseAccessNotice").isHidden(), true);
  });
  await scenario("customers can read balances and receipts while renewals and switches require Wi-Fi", async (page) => {
    await page.goto(portal + "/dashboard");
    await page.getByText("Remaining", { exact: true }).waitFor();
    await page.getByText("Your balance and payment history are available here.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "View receipt", exact: true }).click();
    await page.getByRole("dialog", { name: "Payment receipt" }).waitFor();
    await page.locator("#receiptClose").click();
    await page.screenshot({ path: `${screenshots}/dashboard-mobile.png`, fullPage: true });
    for (const action of ["renew", "switch"]) {
      await page.goto(`${portal}/onboarding.html?action=${action}`);
      await page.locator("#purchaseAccessNotice").waitFor({ state: "visible" });
      await page.locator("[data-plan]").first().waitFor();
      assert.equal(await page.locator("[data-plan]:enabled").count(), 0, action);
    }
  }, { signedIn: true });
  await scenario("leaving Wi-Fi during checkout rejects the charge and explains how to reconnect", async (page, changeAddress) => {
    await page.goto(portal + "/onboarding.html");
    await page.locator('[data-plan="weekly"]').click();
    await page.locator('[name="name"]').fill("Coverage Guest");
    await page.locator('[name="phone"]').fill("670041002");
    await page.locator('[name="email"]').fill("guest@example.test");
    changeAddress(outside);
    await page.locator("#requestPayment").click();
    await page.locator("#message").getByText("Connect to NDAHI Wi-Fi to purchase a bundle.", { exact: true }).waitFor();
    assert.equal(await page.locator("#requestPayment").isDisabled(), true);
    assert.equal((await store.snapshot()).payments.length, baseline.payments.length);
    await page.locator("#closeCheckout").click();
    await page.locator("#purchaseAccessNotice").waitFor({ state: "visible" });
  }, { address: inside, width: 1440 });
  await scenario("a pending renewal remains trackable off-network and can complete", async (page) => {
    const pending = await post("/api/account/plan/purchase", { action: "renew", planId: "weekly", acknowledge: true, requestKey: "coverage-pending-renewal" }, { cookie });
    await page.goto(portal + "/onboarding.html?action=renew");
    await page.locator("#checkExisting").waitFor();
    assert.equal(await page.locator("#checkExisting").isEnabled(), true);
    assert.equal(await page.locator("[data-plan]:enabled").count(), 0);
    await post(`/api/payments/${pending.body.payment.id}/confirm`, {}, { "cf-connecting-ip": outside });
    await page.locator("#checkExisting").click();
    await page.waitForURL(portal + "/dashboard");
    await page.getByText("Payment confirmed. Your new package is active.", { exact: true }).waitFor();
    assert.equal((await store.snapshot()).payments.length, baseline.payments.length + 1);
  }, { signedIn: true });
  console.log(`${checks} coverage browser journeys passed.`);
} finally {
  await browser?.close();
  await close(website); await close(server);
}
