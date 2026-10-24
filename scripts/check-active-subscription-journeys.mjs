import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";

// Synthetic local accounts and mock adapters only. Never load production .env.
const apiPort = Number(process.env.SUBSCRIPTION_API_PORT || 9078), portalPort = Number(process.env.SUBSCRIPTION_PORT || 9077);
const api = `http://127.0.0.1:${apiPort}`, portal = `http://127.0.0.1:${portalPort}`, phone = "670132101";
const store = createStore({ persistent: false });
let now = new Date();
const server = createServer({ store, now: () => now, env: {
  NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  CUSTOMER_APP_URL: portal, SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false",
  NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
} });
const website = createStaticServer("customer", { apiUrl: api });
const listen = (app, port) => new Promise((resolve, reject) => { app.once("error", reject); app.listen(port, "127.0.0.1", resolve); });
const close = (app) => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
const post = async (path, input, cookie = "") => {
  const response = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(input) });
  return { response, body: await response.json() };
};
const exhaust = () => store.transaction((s) => { s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes; });
let browser, checks = 0;
const screenshots = process.env.SUBSCRIPTION_SCREENSHOTS || "/tmp/ndahi-subscription-checks";
try {
  await listen(server, apiPort); await listen(website, portalPort); await mkdir(screenshots, { recursive: true });
  const created = await post("/api/purchase", { phone, name: "Protected Customer", planId: "weekly", requestKey: randomUUID() });
  assert.equal(created.response.status, 201);
  const paid = await post(`/api/payments/${created.body.payment.id}/confirm`, {}), pin = String(randomInt(1000, 10000));
  const setup = await post("/api/account/setup/pin", { phone, code: paid.body.access.code, pin, confirmPin: pin });
  assert.equal(setup.response.status, 200);
  const cookie = setup.response.headers.get("set-cookie").split(";")[0], baseline = await store.snapshot();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function scenario(name, work, { signedIn = true, width = 390 } = {}) {
    now = new Date(); await store.transaction((s) => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    if (signedIn) await context.addCookies([{ name: "customer_session", value: cookie.split("=")[1], domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000); page.on("pageerror", (error) => errors.push(error.message));
    try { await work(page, context); assert.deepEqual(errors, []); console.log(`PASS ${name}`); checks++; }
    catch (error) { await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  for (const width of [1440, 390, 320]) {
    await scenario(`active dashboard hides every customer renewal/switch/quick-renew control at ${width}px`, async (page) => {
      await page.goto(portal + "/dashboard"); await page.locator("#dataBalance").waitFor();
      assert.equal(await page.locator("[data-quick-renew]").count(), 0);
      assert.equal(await page.locator('a[href^="/onboarding.html"]').count(), 0);
      await page.locator('[data-portal-tab="bundles"]').click();
      await page.locator("#managePlan").getByText(/cannot be stacked, renewed or switched/).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${screenshots}/active-bundles-${width}.png`, fullPage: true });
      assert.equal((await store.snapshot()).payments.length, 1);
    }, { width });
    for (const query of ["action=renew&plan=weekly&quick=1", "action=switch&plan=monthly", "upgrade=1&plan=monthly", ""]) {
      await scenario(`active deep link ${query || "public catalogue"} cannot open checkout at ${width}px`, async (page) => {
        await page.goto(portal + "/onboarding.html?" + query);
        await page.getByRole("link", { name: "Connect using existing bundle" }).waitFor();
        assert.equal(await page.locator("[data-plan]:enabled").count(), 0);
        assert.equal(await page.locator("#checkout").isVisible(), false);
        assert.equal((await store.snapshot()).payments.length, 1);
        await page.getByRole("link", { name: "Connect using existing bundle" }).click();
        await page.waitForURL("**/dashboard"); await page.locator("#dataBalance").getByText("Weekly", { exact: true }).waitFor();
      }, { width });
    }
  }
  await scenario("anonymous phone re-entry exposes no bundle details and offers sign-in/reconnect", async (page) => {
    await page.goto(portal + "/onboarding.html"); await page.locator('[data-plan="monthly"]').click();
    await page.locator('[name="name"]').fill("Guest"); await page.locator('[name="phone"]').fill("+237 670132101");
    const rejected = page.waitForResponse((r) => r.url().endsWith("/api/purchase") && r.request().method() === "POST");
    await page.locator("#requestPayment").click(); const response = await rejected;
    assert.equal(response.status(), 409); assert.deepEqual(Object.keys(await response.json()).sort(), ["code", "error"]);
    await page.getByRole("button", { name: "Sign in to connect" }).waitFor();
    assert.equal(await page.locator("#requestPayment").isDisabled(), true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(await page.locator("#requestPayment").isDisabled(), true);
    await page.screenshot({ path: `${screenshots}/guest-sign-in-to-connect.png`, fullPage: true });
    await page.getByRole("button", { name: "Sign in to connect" }).click(); await page.waitForURL("**/login");
    await page.locator('[name="phone"]').fill(phone); await page.locator('[name="code"]').fill(paid.body.access.code);
    await page.locator("#loginSubmit").click(); await page.locator("#customerPin").fill(pin); await page.locator("#loginSubmit").click();
    await page.waitForURL("**/dashboard"); await page.locator("#dataBalance").getByText("Weekly", { exact: true }).waitFor();
    assert.equal((await store.snapshot()).payments.length, 1);
    await page.locator("#connectDevice button").click();
    await page.getByText("Device connected.", { exact: false }).waitFor();
  }, { signedIn: false });
  for (const state of ["expired", "exhausted"]) await scenario(`${state} customer can buy a fresh package and preserves history`, async (page) => {
    await store.transaction((s) => {
      if (state === "expired") s.vouchers[0].expiresAt = now.toISOString();
      else s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes;
    });
    await page.goto(portal + "/onboarding.html?action=switch&plan=monthly");
    await page.locator("#checkout").waitFor(); await page.locator('[name="acknowledge"]').check();
    await page.locator("#requestPayment").click(); await page.locator("#confirm").click();
    await page.waitForURL("**/dashboard"); await page.locator("#dataBalance").getByText("Monthly", { exact: true }).waitFor();
    const stored = await store.snapshot(); assert.equal(stored.payments.length, 2);
    assert.equal(stored.vouchers.find((v) => v.id === paid.body.voucher.id).status, state);
    assert.equal(stored.vouchers.filter((v) => v.status === "active").length, 1);
  });
  await scenario("a bundle activated after page load is protected against a stale checkout and focus recheck", async (page) => {
    await exhaust(); await page.goto(portal + "/onboarding.html?action=renew&plan=weekly");
    await page.locator("#checkout").waitFor();
    await store.transaction((s) => { s.vouchers[0].usedBytes = 0; });
    await page.locator('[name="acknowledge"]').check(); await page.locator("#requestPayment").click();
    await page.getByRole("button", { name: "Use existing bundle" }).waitFor();
    assert.equal(await page.locator("#requestPayment").isDisabled(), true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(await page.locator("#requestPayment").isDisabled(), true);
    assert.equal((await store.snapshot()).payments.length, 1);
  });
  await scenario("legacy pending payment remains recoverable but cannot replace an active bundle", async (page) => {
    const id = randomUUID();
    await store.transaction((s) => { s.payments.unshift({ id, customerId: s.customers[0].id, planId: "monthly", provider: "mock",
      amount: 2000, currency: "XAF", status: "pending", action: "switch", creationState: "accepted", payerPhone: phone,
      replaceVoucherId: paid.body.voucher.id, createdAt: now.toISOString(), paymentExpiresAt: new Date(+now + 300000).toISOString() }); });
    await page.goto(portal + "/onboarding.html?action=switch"); await page.locator("#checkExisting").waitFor();
    const result = await post(`/api/payments/${id}/confirm`, {}); assert.equal(result.response.status, 409);
    await page.locator("#checkExisting").click(); await page.locator("#planNotice").getByText(/needs support review/).waitFor();
    const stored = await store.snapshot(); assert.equal(stored.vouchers.length, 1);
    assert.equal(stored.vouchers[0].id, paid.body.voucher.id); assert.equal(stored.vouchers[0].status, "active");
    assert.equal(stored.payments[0].fulfillmentStatus, "needs_review");
  });
  console.log(`${checks} active-subscription browser scenarios passed. Screenshots: ${screenshots}`);
} finally { await browser?.close(); await close(website); await close(server); }
