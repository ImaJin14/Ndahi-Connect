import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";

// This harness uses only in-memory state and mock providers, never the local .env.
const portalPort = Number(process.env.PLAN_PREVIEW_PORT || 8187);
const apiPort = Number(process.env.PLAN_PREVIEW_API_PORT || 8188);
const portal = `http://127.0.0.1:${portalPort}`, api = `http://127.0.0.1:${apiPort}`;
const store = createStore({ persistent: false });
const server = createServer({ store, env: {
  PAYMENT_MODE: "mock", OTP_DELIVERY: "mock", EMAIL_MODE: "mock",
  MIKROTIK_MODE: "mock", OMADA_MODE: "mock", SESSION_COOKIE_SECURE: "false",
  CUSTOMER_APP_URL: portal, CUSTOMER_SESSION_SECRET: "plan-preview-only",
  SECRET_PEPPER: "plan-preview-only", ADMIN_SESSION_SECRET: "plan-preview-admin-only",
} });
const website = createStaticServer("customer", { apiUrl: api, production: false });
const listen = (app, port) => new Promise((resolve, reject) => {
  app.once("error", reject);
  app.listen(port, "127.0.0.1", resolve);
});
const close = (app) => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
let sessionCookie;
const staticHandler = website.listeners("request")[0];
website.removeAllListeners("request");
website.on("request", (req, res) => {
  const url = new URL(req.url, portal);
  if (url.pathname === "/preview") {
    const action = url.searchParams.get("action") === "switch" ? "switch" : "renew";
    res.writeHead(302, { "set-cookie": sessionCookie, location: `/onboarding.html?action=${action}` });
    res.end();
  } else void staticHandler(req, res);
});
async function post(path, body) {
  const response = await fetch(api + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `Fixture setup failed: ${path} ${response.status}`);
  return { response, body: await response.json() };
}
let browser;
try {
  await listen(server, apiPort);
  await listen(website, portalPort);
  const created = await post("/api/purchase", { planId: "weekly", name: "Preview Customer", phone: "670000060", email: "preview@example.test" });
  const paid = await post(`/api/payments/${created.body.payment.id}/confirm`, {});
  const login = await post("/api/account/setup/pin", { phone: "670000060", code: paid.body.access.code, pin: "2468", confirmPin: "2468" });
  sessionCookie = login.response.headers.get("set-cookie");
  const baseline = await store.snapshot();
  if (process.argv.includes("--serve")) {
    console.log(`Mock renewal preview: ${portal}/preview`);
    console.log(`Mock switching preview: ${portal}/preview?action=switch`);
    await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  } else {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
    browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
    const screenshotDir = process.env.PLAN_SCREENSHOTS || "/tmp/ndahi-plan-checks";
    await mkdir(screenshotDir, { recursive: true });
    let checks = 0;
    async function scenario(name, change, run, options = {}) {
      await store.transaction((state) => { Object.assign(state, structuredClone(baseline)); change?.(state); });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await run(page, context);
        assert.deepEqual(errors, [], "No browser JavaScript errors");
        console.log(`PASS ${name}`);
        checks++;
      } finally { await context.close(); }
    }
    async function load(page, action = "renew") {
      await page.goto(`${portal}/preview?action=${action}`);
      await page.locator('#plans[aria-busy="false"]').waitFor({ state: "attached" });
    }
    async function noOverflow(page) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No horizontal page overflow");
      assert.deepEqual(await page.locator(".plan, .comparison, button").evaluateAll((elements) => elements.filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map((el) => el.outerHTML.slice(0, 100))), [], "Text and tables fit their controls");
    }
    await scenario("renew only current plan, preserve identity/session, clear payment key", null, async (page, context) => {
      await page.goto(`${portal}/preview`);
      await page.goto(`${portal}/onboarding.html?action=renew&plan=unlimited`);
      await page.locator('#plans[aria-busy="false"]').waitFor();
      assert.equal(await page.locator(".hero").isVisible(), false);
      assert.equal(await page.locator("[data-plan]").count(), 1);
      assert.equal(await page.locator("[data-plan]").getAttribute("data-plan"), "weekly");
      await page.screenshot({ path: `${screenshotDir}/renewal-desktop.png`, fullPage: true });
      const cookieBefore = (await context.cookies()).find((cookie) => cookie.name === "customer_session").value;
      const requests = [];
      page.on("request", (request) => { if (request.url().endsWith("/api/account/plan/purchase")) requests.push(request.postDataJSON()); });
      await page.getByRole("button", { name: "Review renewal" }).click();
      assert.equal(await page.locator('input[name="email"]').getAttribute("readonly"), "");
      await page.getByRole("button", { name: /Request payment/ }).click();
      assert.equal(requests.length, 0, "Replacement consent is required");
      await page.locator('input[name="acknowledge"]').check();
      await page.getByRole("button", { name: /Request payment/ }).click();
      await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].email, undefined);
      assert.equal(requests[0].phone, undefined);
      await page.getByRole("button", { name: "Simulate payment approval" }).click();
      await page.waitForURL("**/dashboard");
      assert.equal((await context.cookies()).find((cookie) => cookie.name === "customer_session").value, cookieBefore);
      assert.equal(await page.evaluate(() => sessionStorage.getItem("ndahi-payment-renew-weekly")), null);
      const state = await store.snapshot();
      assert.equal(state.vouchers.length, 2);
      assert.equal(state.vouchers[1].status, "renewed");
      assert.equal(state.customers[0].email, "preview@example.test");
    });
    await scenario("switch comparisons, keyboard modal, mobile and zoom-equivalent reflow", null, async (page) => {
      await load(page, "switch");
      assert.equal(await page.locator(".comparison").count(), 7);
      assert.equal(await page.locator('[data-plan="weekly"]').count(), 0);
      assert.match(await page.locator('[data-card="monthly"]').textContent(), /Upgrade.*1,500 FCFA more/s);
      assert.match(await page.locator('[data-card="daily"]').textContent(), /Downgrade.*400 FCFA less/s);
      await noOverflow(page);
      await page.screenshot({ path: `${screenshotDir}/switch-desktop.png`, fullPage: true });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await noOverflow(page);
        await page.locator('[data-plan="unlimited"]').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('[data-plan="unlimited"]').isVisible(), true);
      }
      await page.screenshot({ path: `${screenshotDir}/switch-mobile.png`, fullPage: true });
      await page.locator('[data-plan="monthly"]').click();
      assert.match(await page.locator("#checkoutPolicy").textContent(), /ends immediately.*do not carry over.*no prorated credit/s);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.locator("#requestPayment").evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press("Tab");
      assert.equal(await page.locator("#closeCheckout").evaluate((el) => el === document.activeElement), true);
      await noOverflow(page);
      await page.screenshot({ path: `${screenshotDir}/switch-checkout-mobile.png` });
      await page.keyboard.press("Escape");
      assert.equal(await page.locator('[data-plan="monthly"]').evaluate((el) => el === document.activeElement), true);
      await page.locator('[data-plan="monthly"]').click();
      await page.locator('input[name="acknowledge"]').check();
      await page.getByRole("button", { name: /Request payment/ }).click();
      await page.getByRole("button", { name: "Simulate payment approval" }).click();
      await page.waitForURL("**/dashboard");
      const state = await store.snapshot();
      assert.equal(state.vouchers[0].planId, "monthly");
      assert.equal(state.vouchers[1].status, "switched");
    });
    await scenario("Daily cooldown blocks renewal", (state) => {
      state.vouchers[0].planId = "daily";
      state.payments[0].planId = "daily";
    }, async (page) => {
      await load(page);
      assert.equal(await page.locator("[data-plan]").count(), 1);
      assert.equal(await page.locator("[data-plan]").isDisabled(), true);
      assert.match(await page.locator("#planNotice").textContent(), /once every 7 days.*Next eligible/s);
    });
    await scenario("touch and accessible plan/table names reach the last alternative", null, async (page) => {
      await load(page, "switch");
      assert.equal(await page.getByRole("table", { name: "Current and proposed package" }).count(), 7);
      const last = page.getByRole("article", { name: "Unlimited Home", exact: true });
      await last.getByRole("button", { name: "Switch to this plan" }).tap();
      assert.equal(await page.getByRole("dialog", { name: "Switch to Unlimited Home" }).isVisible(), true);
      await noOverflow(page);
    }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    for (const kind of ["missing", "discontinued"]) await scenario(`${kind} current plan cannot fall back to another renewal`, (state) => {
      if (kind === "missing") state.vouchers = [];
      else state.vouchers[0].planId = "plus";
    }, async (page) => {
      await load(page);
      assert.equal(await page.locator("[data-plan]").count(), 0);
      assert.match(await page.locator("#planNotice").textContent(), /no current plan|no longer available/);
    });
    await scenario("custom duration and lateral change", (state) => {
      state.bundles.push({ id: "custom", name: "Flexible", price: 500, quotaGb: 4, validityHours: 36, deviceLimit: 2 });
    }, async (page) => {
      await load(page, "switch");
      assert.match(await page.locator('[data-card="custom"]').textContent(), /Lateral change.*36 hours.*132 hours shorter/s);
    });
    await scenario("in-flight creation locks selection and modal can resume pending payment", null, async (page) => {
      await load(page, "switch");
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      await page.route(`${api}/api/account/plan/purchase`, async (route) => { await gate; await route.continue(); });
      await page.locator('[data-plan="monthly"]').click();
      await page.locator('input[name="acknowledge"]').check();
      await page.getByRole("button", { name: /Request payment/ }).click();
      await page.getByRole("button", { name: "Back to packages" }).click();
      assert.equal(await page.locator('[data-plan="family"]').isDisabled(), true);
      release();
      await page.getByRole("button", { name: "Return to payment" }).click();
      await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
      assert.equal(await page.locator("#selected").textContent(), "Switch to Monthly");
      await page.getByRole("button", { name: "Simulate payment approval" }).click();
      await page.waitForURL("**/dashboard");
    });
    await scenario("pending payment restoration and owner polling clear completed request key", null, async (page) => {
      await load(page);
      await page.getByRole("button", { name: "Review renewal" }).click();
      await page.locator('input[name="acknowledge"]').check();
      await page.getByRole("button", { name: /Request payment/ }).click();
      await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
      const id = (await store.snapshot()).payments[0].id;
      await page.reload();
      await page.getByRole("button", { name: "Check payment status" }).waitFor();
      assert.equal(await page.locator("[data-plan]").isDisabled(), true);
      await page.getByRole("button", { name: "Check payment status" }).click();
      await post(`/api/payments/${id}/confirm`, {});
      await page.getByRole("button", { name: "Check payment status" }).click();
      await page.waitForURL("**/dashboard");
      assert.equal(await page.evaluate(() => sessionStorage.getItem("ndahi-payment-renew-weekly")), null);
      await page.goto(`${portal}/onboarding.html?action=renew`);
      await page.getByRole("button", { name: "Review renewal" }).click();
      await page.locator('input[name="acknowledge"]').check();
      await page.getByRole("button", { name: /Request payment/ }).click();
      await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
      assert.notEqual((await store.snapshot()).payments[0].id, id);
    });
    await scenario("payment polling carries the account cookie and preserves the session", null, async (page) => {
      await load(page);
      await page.route(`${api}/api/account/plan/purchase`, async (route) => {
        const response = await route.fetch(), body = await response.json();
        body.checkout.mode = "mesomb";
        await route.fulfill({ response, json: body });
      });
      await page.getByRole("button", { name: "Review renewal" }).click();
      await page.locator('input[name="acknowledge"]').check();
      const pollingResponse = page.waitForResponse((response) => /\/api\/account\/payments\/[^/]+\/status$/.test(response.url()));
      await page.getByRole("button", { name: /Request payment/ }).click();
      assert.equal((await pollingResponse).status(), 200);
      const id = (await store.snapshot()).payments[0].id;
      await post(`/api/payments/${id}/confirm`, {});
      await page.waitForURL("**/dashboard");
    });
    await scenario("a terminal failure releases checkout for a new payment", null, async (page) => {
      await load(page);
      await page.route(`${api}/api/account/plan/purchase`, async (route) => {
        const response = await route.fetch(), body = await response.json();
        body.payment.status = "failed";
        await store.transaction((state) => { state.payments[0].status = "failed"; });
        await route.fulfill({ response, json: body });
      });
      await page.getByRole("button", { name: "Review renewal" }).click();
      await page.locator('input[name="acknowledge"]').check();
      await page.getByRole("button", { name: /Request payment/ }).click();
      await page.locator("#message [role=alert]").waitFor();
      assert.equal(await page.locator("#requestPayment").isEnabled(), true);
      assert.equal(await page.evaluate(() => sessionStorage.getItem("ndahi-payment-renew-weekly")), null);
      await page.unroute(`${api}/api/account/plan/purchase`);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
      assert.equal((await store.snapshot()).payments.length, 3);
    });
    await scenario("payment confirmed while page is closed does not reuse a completed key", null, async (page) => {
      await load(page);
      await page.getByRole("button", { name: "Review renewal" }).click();
      await page.locator('input[name="acknowledge"]').check();
      await page.getByRole("button", { name: /Request payment/ }).click();
      await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
      const id = (await store.snapshot()).payments[0].id;
      await page.goto(`${portal}/dashboard`);
      await post(`/api/payments/${id}/confirm`, {});
      await page.goto(`${portal}/onboarding.html?action=renew`);
      await page.getByRole("button", { name: "Review renewal" }).waitFor();
      assert.equal(await page.evaluate(() => sessionStorage.getItem("ndahi-payment-renew-weekly")), null);
      await page.getByRole("button", { name: "Review renewal" }).click();
      await page.locator('input[name="acknowledge"]').check();
      await page.getByRole("button", { name: /Request payment/ }).click();
      await page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
      assert.notEqual((await store.snapshot()).payments[0].id, id);
    });
    await scenario("logged-out renewal returns through login; public catalogue remains visible", null, async (page, context) => {
      await page.goto(`${portal}/onboarding.html?action=renew`);
      await page.waitForURL("**/login");
      assert.equal(await page.evaluate(() => sessionStorage.getItem("ndahi-return-to")), "/onboarding.html?action=renew");
      await context.clearCookies();
      await page.goto(`${portal}/onboarding.html`);
      await page.locator('#plans[aria-busy="false"]').waitFor();
      assert.equal(await page.locator(".hero").isVisible(), true);
      assert.equal(await page.locator("[data-plan]").count(), 8);
    });
    console.log(`${checks} browser scenarios passed. Screenshots: ${screenshotDir}`);
  }
} finally {
  await browser?.close();
  await close(website);
  await close(server);
}
