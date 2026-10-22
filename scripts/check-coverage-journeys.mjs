import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";

// Local mock services only. The synthetic edge header is injected by the test
// harness to exercise both coverage states without a live router or payment.
const inside = "203.0.113.10", outside = "198.51.100.7";
const listen = async (app) => {
  await new Promise((resolve, reject) => { app.once("error", reject); app.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${app.address().port}`;
};
const close = (app) => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
// Reserve the portal origin before creating services so the API uses its real
// CORS checks. Requests need only the synthetic edge header, not response rewrites.
const website = http.createServer(), portal = await listen(website);
const store = createStore({ persistent: false });
const server = createServer({ store, env: {
  NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  TRUST_PROXY: "render", COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: inside,
  BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", SESSION_COOKIE_SECURE: "false",
  CUSTOMER_APP_URL: portal,
} });
const api = await listen(server), assets = createStaticServer("customer", { apiUrl: api, hotspotLoginUrl: "https://connect.coverage.test/login" });
website.on("request", (req, res) => assets.emit("request", req, res));
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
    await context.route("**/*", (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === portal) return route.continue();
      if (url.origin !== api) return route.abort("blockedbyclient");
      return route.continue({ headers: {
        ...request.headers(), "cf-connecting-ip": currentAddress,
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
    } finally {
      // Let intercepted responses finish before closing their request context.
      await context.unrouteAll({ behavior: "wait" });
      await context.close();
    }
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
  for (const signedIn of [false, true]) await scenario(`portal entry shows bundles first for ${signedIn ? "signed-in returning" : "signed-out returning"} visitors`, async (page) => {
    await page.addInitScript(() => localStorage.setItem("ndahi-device", "returning-device"));
    await page.goto(portal + "/");
    await page.waitForURL(portal + "/onboarding.html");
    await page.locator('[data-plan="weekly"]').waitFor();
    assert.equal(await page.locator("#login").count(), 0);
    assert.ok(await page.locator("[data-plan]").first().evaluate((el) => el.getBoundingClientRect().top < innerHeight), "bundles appear in the first screen");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/bundles-first-${signedIn ? "returning" : "guest"}.png`, fullPage: true });
    await page.locator(".header-link").click();
    await page.waitForURL(portal + (signedIn ? "/dashboard" : "/login"));
    if (!signedIn) {
      // Old installed shortcuts continue to use /dashboard. Expired sessions
      // also get packages before the user chooses Sign in.
      await page.goto(portal + "/dashboard");
      await page.waitForURL(portal + "/onboarding.html");
      await page.locator('[data-plan="weekly"]').waitFor();
    }
  }, { signedIn, address: inside, width: signedIn ? 390 : 320 });
  await scenario("package prices remain visible when a returning account cannot load", async (page) => {
    await page.route("**/api/account/dashboard", (route) => route.fulfill({ status: 503, contentType: "application/json",
      headers: { "access-control-allow-origin": portal, "access-control-allow-credentials": "true" }, body: JSON.stringify({ error: "Account unavailable" }) }));
    await page.goto(portal + "/");
    await page.getByText(/Packages are available, but your account could not load/).waitFor();
    assert.ok(await page.locator("[data-plan]").count() > 0);
    assert.equal(await page.locator("[data-plan]:enabled").count(), 0, "unknown pending account state cannot start a competing purchase");
  });
  await scenario("new unpaid Wi-Fi guests can request payment even when the browser reports no internet", async (page) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => false }));
    await page.goto(portal + "/");
    await page.locator('[data-plan="weekly"]:enabled').click();
    await page.locator('[name="name"]').fill("Unpaid Wi-Fi Guest");
    await page.locator('[name="phone"]').fill("670041071");
    await page.locator("#requestPayment").click();
    await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
    const state = await store.snapshot(), payment = state.payments.find((p) => p.payerPhone === "670041071");
    assert.equal(payment.status, "pending");
    assert.equal(state.vouchers.some((v) => v.customerId === payment.customerId), false, "no active voucher was needed to buy");
    assert.equal(state.sessions.some((s) => s.customerId === payment.customerId), false, "no Wi-Fi login session was needed to buy");
  }, { address: inside });
  for (const status of ["expired", "exhausted"]) await scenario(`${status} Wi-Fi customers can renew with no passing data`, async (page) => {
    await store.transaction((s) => { s.vouchers[0].status = status; if (status === "exhausted") s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes; });
    await page.goto(portal + "/onboarding.html?action=renew");
    await page.locator('[data-plan="weekly"]:enabled').click();
    await page.locator('[name="acknowledge"]').check();
    await page.locator("#requestPayment").click();
    await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
    assert.equal((await store.snapshot()).payments.length, baseline.payments.length + 1);
  }, { signedIn: true, address: inside });
  await scenario("customers can read balances and receipts while renewals and switches require Wi-Fi", async (page) => {
    await page.goto(portal + "/dashboard");
    await page.getByText("Remaining", { exact: true }).waitFor();
    await page.getByText("Your balance and payment history are available here.", { exact: false }).waitFor();
    await page.getByRole("link", { name: "Payments", exact: true }).click();
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
    const navigation = await page.evaluate(() => performance.timeOrigin);
    changeAddress(inside);
    await page.locator("#recheckPurchaseAccess").click();
    await page.locator('[data-plan="weekly"]:enabled').waitFor();
    assert.equal(await page.evaluate(() => performance.timeOrigin), navigation, "rechecking Wi-Fi must not reload away the form");
    await page.locator('[data-plan="weekly"]').click();
    assert.equal(await page.locator('[name="name"]').inputValue(), "Coverage Guest");
    assert.equal(await page.locator('[name="phone"]').inputValue(), "670041002");
    await page.locator("#requestPayment").click();
    await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
    assert.equal((await store.snapshot()).payments.length, baseline.payments.length + 1);
  }, { address: inside, width: 1440 });
  await scenario("returning from Wi-Fi settings rechecks access without a page reload or a charge", async (page, changeAddress) => {
    await page.goto(portal + "/onboarding.html");
    await page.locator("#purchaseAccessNotice").waitFor({ state: "visible" });
    const navigation = await page.evaluate(() => performance.timeOrigin);
    changeAddress(inside);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.locator('[data-plan="weekly"]:enabled').waitFor();
    assert.equal(await page.locator("#purchaseAccessNotice").isHidden(), true);
    assert.equal(await page.evaluate(() => performance.timeOrigin), navigation);
    assert.equal((await store.snapshot()).payments.length, baseline.payments.length);
  });
  await scenario("a failed connection recheck cannot leave a stale purchase permission enabled", async (page) => {
    await page.goto(portal + "/onboarding.html");
    await page.locator('[data-plan="weekly"]:enabled').waitFor();
    await page.route("**/api/purchase/access", (route) => route.abort("failed"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.getByText(/Could not check Wi-Fi access/).waitFor();
    assert.equal(await page.locator("[data-plan]:enabled").count(), 0);
    assert.equal((await store.snapshot()).payments.length, baseline.payments.length);
  }, { address: inside });
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
  await scenario("the dashboard removes a departed device after the next confirmed router reading", async (page) => {
    await store.transaction((s) => {
      s.vouchers[0].wifiDevices = [{ mac: "AA:BB:CC:DD:EE:01", address: "10.20.0.30", uptime: "5m", usedBytes: 20,
        sessionId: "*presence", startedAt: new Date(Date.now() - 300000).toISOString() }];
      s.vouchers[0].wifiDevicesAt = new Date().toISOString();
    });
    await page.goto(portal + "/dashboard#devices");
    await page.getByText("Unnamed device · ending EE:01", { exact: true }).waitFor();
    const before = (await store.snapshot()).vouchers[0];
    await store.transaction((s) => { s.vouchers[0].wifiDevices = []; s.vouchers[0].wifiDevicesAt = new Date().toISOString(); });
    await page.getByText("No devices were reported at the last Wi-Fi check.", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-wifi-device]").count(), 0);
    const after = (await store.snapshot()).vouchers[0];
    assert.equal(after.usedBytes, before.usedBytes);
    assert.equal(after.expiresAt, before.expiresAt);
  }, { signedIn: true });
  await scenario("a failed device refresh keeps the last devices and explains the stale reading", async (page) => {
    await store.transaction((s) => {
      s.vouchers[0].wifiDevices = [{ mac: "AA:BB:CC:DD:EE:01", address: "10.20.0.30", uptime: "5m", usedBytes: 20,
        sessionId: "*presence", startedAt: new Date(Date.now() - 300000).toISOString() }];
      s.vouchers[0].wifiDevicesAt = new Date().toISOString();
    });
    await page.goto(portal + "/dashboard#devices");
    await page.getByText("Unnamed device · ending EE:01", { exact: true }).waitFor();
    await page.route("**/api/account/wifi-devices", (route) => route.fulfill({ status: 503, contentType: "application/json",
      headers: { "access-control-allow-origin": portal, "access-control-allow-credentials": "true" }, body: JSON.stringify({ error: "Router unavailable" }) }));
    await page.getByText("Device updates are unavailable. The last device list may be out of date.", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-wifi-device]").count(), 1);
  }, { signedIn: true });
  console.log(`${checks} coverage browser journeys passed.`);
} finally {
  await browser?.close();
  await close(website); await close(server);
}
