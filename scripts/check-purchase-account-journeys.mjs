import assert from "node:assert/strict";
import { useVoucherSignIn } from "./portal-tabs.mjs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";

// Isolated local API, mock payments and real portal assets. No live accounts.
const store = createStore({ persistent: false }), website = http.createServer();
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
await listen(website);
const portal = `http://127.0.0.1:${website.address().port}`;
const server = createServer({ store, env: {
  NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal, CUSTOMER_SESSION_SECRET: "identity-browser-only",
  BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", ADMIN_PIN: "9999", LOG_LEVEL: "warn",
} });
let browser;
try {
  await listen(server);
  const api = `http://127.0.0.1:${server.address().port}`;
  const assets = createStaticServer("customer", { apiUrl: api });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const post = async (path, data) => {
    const response = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    assert.equal(response.ok, true, `Fixture failed: ${path} ${response.status}`);
    return { body: await response.json(), cookie: response.headers.getSetCookie().find((s) => s.startsWith("customer_session="))?.split(";")[0] };
  };
  const phone = "670180011", name = "Imajin", email = "imajin@example.test";
  const first = await post("/api/purchase", { phone, name, email, planId: "weekly", network: "mtn", requestKey: randomUUID() });
  const paid = await post(`/api/payments/${first.body.payment.id}/confirm`, {});
  const owner = await post("/api/account/setup/pin", { phone, code: paid.body.access.code, pin: "2468", confirmPin: "2468" });
  await store.transaction((s) => { s.customers[0].emailVerifiedAt = new Date().toISOString(); });
  const baseline = await store.snapshot();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  for (const width of [320, 1280]) {
    async function scenario(label, { signedIn = false, active = false } = {}, run) {
      await store.transaction((s) => { Object.assign(s, structuredClone(baseline)); if (!active) s.vouchers[0].status = "expired"; });
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/*", (route) => [portal, api].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
      if (signedIn) await context.addCookies([{ name: "customer_session", value: owner.cookie.slice("customer_session=".length), domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
      try {
        await page.goto(portal + "/onboarding.html");
        await run(page, context);
        assert.deepEqual(errors, [], "No browser errors");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        console.log(`PASS ${width}px ${label}`);
      } finally { await context.close(); }
    }
    for (const [plan, action] of [["weekly", "renew"], ["monthly", "switch"]]) {
      await scenario(`general Packages reuses original account for ${action} and voucher delivery`, { signedIn: true }, async (page) => {
        const requests = [];
        page.on("request", (request) => { if (/\/api\/(purchase|account\/plan\/purchase)$/.test(new URL(request.url()).pathname)) requests.push(request); });
        await page.locator(`[data-plan="${plan}"]`).click();
        assert.equal(await page.locator('[name="name"]').inputValue(), name);
        assert.equal(await page.locator('[name="email"]').inputValue(), email);
        assert.equal(await page.locator('[name="phone"]').inputValue(), phone);
        assert.equal(await page.locator('[name="name"]').getAttribute("readonly"), "");
        await page.getByText(name, { exact: true }).waitFor();
        await page.locator('[name="payerPhone"]').fill("670180099");
        await page.locator('[name="acknowledge"]').check();
        await page.locator("#requestPayment").click();
        await page.locator("#confirm").waitFor();
        assert.equal(requests.length, 1); assert.equal(new URL(requests[0].url()).pathname, "/api/account/plan/purchase");
        assert.equal(requests[0].postDataJSON().action, action);
        assert.equal(requests[0].postDataJSON().phone, undefined);
        await page.locator("#confirm").click();
        await page.waitForURL(/\/voucher-ready\.html/);
        await page.getByRole("button", { name: "Download Voucher", exact: true }).waitFor();
        const s = await store.snapshot();
        assert.equal(s.customers.length, 1); assert.equal(s.customers[0].name, name); assert.equal(s.customers[0].email, email);
        assert.equal(s.customers[0].phone, phone); assert.equal(s.payments[0].payerPhone, "670180099");
        assert.equal(s.payments[0].customerName, name); assert.equal(s.payments[0].email, email);
        assert.equal(s.payments[0].customerId, baseline.customers[0].id);
      });
    }
    await scenario("conflicting guest details offer sign-in before creating another payment", {}, async (page) => {
      await page.locator('[data-plan="weekly"]').click();
      await page.locator('[name="name"]').fill("Different Name");
      await page.locator('[name="phone"]').fill("+237 670 180 011");
      await page.locator('[name="email"]').fill("different@example.test");
      await page.locator("#requestPayment").click();
      await page.getByRole("button", { name: "Sign in to existing account", exact: true }).waitFor();
      assert.ok(!(await page.locator("#message").innerText()).includes(email));
      const s = await store.snapshot();
      assert.equal(s.payments.length, 1); assert.equal(s.customers.length, 1); assert.equal(s.customers[0].name, name);
      await page.getByRole("button", { name: "Sign in to existing account", exact: true }).click();
      await page.waitForURL(/\/login\?account=1/);
      await page.locator('[name="phone"]').fill(phone);
      await useVoucherSignIn(page); await page.locator('[name="code"]').fill(paid.body.access.code);
      await page.locator("#loginSubmit").click();
      await page.locator("#customerPin").fill("2468");
      await page.locator("#loginSubmit").click();
      await page.waitForURL((url) => url.pathname === "/onboarding.html" && url.searchParams.get("plan") === "weekly");
      await page.locator("#accountContact").waitFor();
      assert.equal(await page.locator('[name="name"]').inputValue(), name);
      assert.equal(await page.locator('[name="email"]').inputValue(), email);
    });
    await scenario("active account keeps its existing bundle accessible without another charge", { active: true }, async (page) => {
      await page.locator('[data-plan="weekly"]').click();
      await page.locator('[name="name"]').fill("Different Name");
      await page.locator('[name="phone"]').fill(phone);
      await page.locator("#requestPayment").click();
      await page.getByRole("button", { name: "Sign in to connect", exact: true }).waitFor();
      assert.equal((await store.snapshot()).payments.length, 1);
    });
    await scenario("lost authenticated payment response recovers the same account payment", { signedIn: true }, async (page) => {
      await page.route("**/api/account/plan/purchase", async (route) => { await route.fetch(); await route.abort("failed"); });
      await page.locator('[data-plan="weekly"]').click();
      await page.locator('[name="acknowledge"]').check();
      await page.locator("#requestPayment").click();
      const check = page.getByRole("button", { name: "Check payment again", exact: true });
      await check.waitFor();
      const s = await store.snapshot();
      assert.equal(s.payments.length, 2); assert.equal(s.payments[0].checkoutAudience, "account");
      await post(`/api/payments/${s.payments[0].id}/confirm`, {});
      await check.click();
      await page.waitForURL(/\/voucher-ready\.html/);
      await page.getByRole("button", { name: "Download Voucher", exact: true }).waitFor();
      assert.equal((await store.snapshot()).payments.length, 2);
    });
  }
} finally {
  await browser?.close();
  await close(server); await close(website);
}
