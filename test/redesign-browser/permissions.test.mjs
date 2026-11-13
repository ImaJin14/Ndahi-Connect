import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";

const roles = ["owner", "operator", "auditor", "reseller"];
const variants = [
  { name: "v1", query: "ui=old" },
  { name: "v2", query: "ui=new" },
];
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const reservePort = async () => {
  const server = await listen(http.createServer());
  const port = server.address().port;
  await close(server);
  return port;
};
const close = (server) => new Promise((resolve) => {
  server.close(resolve);
  server.closeAllConnections();
});
const restrictedCollections = new Set(["customers", "payments", "sessions", "events", "audit", "security"]);
const restrictedRequest = (url) => {
  if (url.pathname === "/api/admin/home") return true;
  if (url.pathname !== "/api/admin/records") return false;
  return restrictedCollections.has(new URLSearchParams(url.search).get("collection"));
};

test("admin role permissions stay scoped at phone and desktop sizes on both UI variants", async (t) => {
  const secret = "redesign-permissions-secret";
  let apiServer, staticServer, browser;
  t.after(async () => {
    await browser?.close();
    if (staticServer) await close(staticServer);
    if (apiServer) await close(apiServer);
  });
  const store = createStore({ persistent: false });
  await store.transaction((state) => {
    state.customers.push({ id: "permission-customer", name: "Permission Customer", phone: "670050001" });
    state.payments.push({
      id: "permission-payment",
      customerId: "permission-customer",
      status: "paid",
      amount: 3000,
      currency: "XAF",
      provider: "mesomb",
      providerReference: "permission-payment-ref",
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      planId: "weekly",
      planSnapshot: { id: "weekly", name: "Weekly", price: 3000 },
    });
    for (const role of roles) {
      const id = `permission-${role}`;
      state.adminUsers.push({ id, username: id, displayName: role, role, active: true, passkeys: [] });
      state.adminSessions.push({
        userId: id,
        role,
        tokenHash: hashSecret(id, secret),
        csrfToken: `csrf-${role}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
  });
  const apiPort = await reservePort();
  staticServer = createStaticServer("admin", {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    env: { NODE_ENV: "test", UI_V2_PERCENT: "0" },
  });
  await listen(staticServer);
  const admin = `http://127.0.0.1:${staticServer.address().port}`;
  apiServer = createServer({
    store,
    validateConfig: false,
    env: {
      NODE_ENV: "test",
      ADMIN_SESSION_SECRET: secret,
      SESSION_COOKIE_SECURE: "false",
      ADMIN_APP_URL: admin,
      ALLOWED_ADMIN_ORIGINS: admin,
      PAYMENT_MODE: "mock",
      EMAIL_MODE: "mock",
      MIKROTIK_MODE: "mock",
      OMADA_MODE: "mock",
      BILLING_WORKER_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false",
    },
  });
  await new Promise((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(apiPort, "127.0.0.1", resolve);
  });
  const api = `http://127.0.0.1:${apiPort}`;
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
  });
  // Verify the real default without a query or preference, including browsers
  // that saved the previous automatically selected v1 interface.
  const screenshots = "/tmp/ndahi-admin-default-policy";
  await mkdir(screenshots, { recursive: true });
  for (const width of [390, 1280]) {
    for (const legacy of [false, true]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
      if (legacy) await context.addCookies([{ name: "ndahi_ui", value: "v1", url: admin, httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${admin}/login`);
        await page.getByLabel("Email", { exact: true }).waitFor();
        assert.equal(await page.locator("html").getAttribute("data-ui-variant"), "v2");
        assert.equal((await context.cookies()).some((cookie) => cookie.name === "ndahi_admin_ui"), false, "computed defaults are not saved as preferences");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `${screenshots}/${legacy ? "legacy" : "fresh"}-${width}.png`, fullPage: true });
        await page.goto(`${admin}/login?ui=old`);
        await page.getByLabel("Username", { exact: true }).waitFor();
        assert.notEqual(await page.locator("html").getAttribute("data-ui-variant"), "v2");
        await page.reload();
        assert.notEqual(await page.locator("html").getAttribute("data-ui-variant"), "v2", "deliberate old view survives reload");
        await page.goto(`${admin}/login?ui=new`);
        await page.getByLabel("Email", { exact: true }).waitFor();
        assert.equal(await page.locator("html").getAttribute("data-ui-variant"), "v2");
        assert.deepEqual(errors, []);
        console.info(`PASS default/legacy migration and old/new choices at ${width}px (${legacy ? "legacy" : "fresh"})`);
      } finally {
        await context.close();
      }
    }
  }
  for (const variant of variants) {
    for (const role of roles) {
      for (const width of [390, 1280]) {
        console.info(`Checking ${variant.name}/${role}/${width}`);
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const failures = [];
        const pageErrors = [];
        const unauthorizedRequests = [];
        const unauthorizedResponses = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (request.method() === "GET" && url.origin === api && restrictedRequest(url) && (role === "auditor" || role === "reseller")) {
            unauthorizedRequests.push(url.href);
          }
        });
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (url.origin !== api) return;
          if (response.status() >= 500) failures.push(`${response.status()} ${url.pathname}${url.search}`);
          if (response.request().method() === "GET" && restrictedRequest(url) && (role === "auditor" || role === "reseller")) {
            unauthorizedResponses.push({ url: url.href, status: response.status() });
          }
        });
        await context.addCookies([{
          name: "admin_session",
          value: `permission-${role}`,
          url: `${api}/api/admin`,
          httpOnly: true,
          sameSite: "Lax",
        }]);
        try {
          await page.goto(`${admin}/dashboard?${variant.query}#home`);
          if (variant.name === "v2") {
            await page.locator("#adminSideMenu [data-admin-nav]").first().waitFor({ state: "visible" });
            await page.locator("#panel-home:not([hidden])").waitFor({ state: "visible" });
            await page.waitForFunction(() => Boolean(document.querySelector("#homeAttention")?.textContent.trim()), null, { timeout: 10000 });
          } else {
            await page.locator("#adminNav:not([hidden])").waitFor({ state: "visible" });
            await page.locator("#activeSessionsMetric").waitFor({ state: "visible" });
          }
          await page.locator("#adminTitle").waitFor({ state: "visible" });
          const restricted = role === "auditor" || role === "reseller";
          if (restricted && variant.name === "v1") {
            const checks = await page.evaluate(async (apiUrl) => Promise.all([
              ...["customers", "payments", "sessions", "audit", "security"].map((collection) => `/api/admin/records?collection=${collection}`),
              "/api/admin/home",
            ].map(async (path) => {
              const response = await fetch(apiUrl + path, { credentials: "include" });
              return { status: response.status, body: await response.text() };
            })), api);
            assert.ok(checks.every(({ status }) => status === 403), "v1 restricted endpoints deny access");
            assert.ok(checks.every(({ body }) => !/Permission Customer|permission-payment/i.test(body)), "v1 restricted endpoints expose no fixture records");
          }
          assert.deepEqual(failures, [], `${variant.name}/${role}/${width} has failed API responses`);
          assert.deepEqual(pageErrors, [], `${variant.name}/${role}/${width} emitted page errors`);
          if (restricted && variant.name === "v1") {
            assert.ok(unauthorizedResponses.every((response) => response.status === 403),
              `${variant.name}/${role}/${width} restricted requests were not forbidden`);
          }
          if (restricted && variant.name === "v2") {
            assert.deepEqual(unauthorizedRequests, [], `${variant.name}/${role}/${width} made unauthorized requests`);
          }

          const body = await page.locator("body").innerText();
          if (restricted) {
            if (variant.name === "v2") {
              assert.doesNotMatch(body, /Export CSV|Export for accountant|Approve full refund|Refund payment/i);
              const metrics = page.locator(".admin-home__metrics .nd-metric");
              await metrics.nth(1).waitFor({ state: "visible" });
              assert.equal(await metrics.nth(1).locator(".nd-metric__value").innerText(), "Unavailable");
              assert.equal(await metrics.nth(0).locator(".nd-metric__value").innerText(), "0");
              assert.equal(await page.locator("#cashCollectedMetric").innerText(), "Unavailable");
              for (const nav of ["payments", "customers", "audit"]) {
                assert.equal(await page.locator(`[data-admin-nav="${nav}"]`).count(), 0);
              }
              for (const href of ["#payments", "#customers", "#customer/permission-customer", "#audit"]) {
                await page.goto(`${admin}/dashboard?${variant.query}${href}`);
                await page.locator("#panel-home:not([hidden])").waitFor({ state: "visible" });
                assert.equal(await page.locator("[data-admin-nav=\"home\"]").getAttribute("aria-current"), "page");
              }
              if (role === "auditor") {
                assert.equal(await page.locator("[data-head-view=\"home\"][href$=\"#vouchers\"]").isVisible(), false);
                await page.goto(`${admin}/dashboard?${variant.query}#vouchers`);
                await page.locator("#panel-vouchers:not([hidden])").waitFor({ state: "visible" });
                await page.goto(`${admin}/dashboard?${variant.query}#voucher-print`);
                await page.locator("#panel-home:not([hidden])").waitFor({ state: "visible" });
                assert.equal(await page.locator('[data-admin-nav="home"]').getAttribute("aria-current"), "page");
                await page.goto(`${admin}/dashboard?${variant.query}#vouchers`);
                await page.locator("#panel-vouchers:not([hidden])").waitFor({ state: "visible" });
                assert.equal(await page.locator("#panel-vouchers:not([hidden]) #generate").isVisible(), false);
                assert.equal(await page.locator("#panel-vouchers:not([hidden]) a[href$=\"#voucher-print\"]").count(), 0);
              } else {
                await page.goto(`${admin}/dashboard?${variant.query}#vouchers`);
                await page.locator("#panel-vouchers:not([hidden])").waitFor({ state: "visible" });
                assert.equal(await page.locator("#panel-vouchers:not([hidden]) #generate").isVisible(), true);
                assert.equal(await page.locator("[data-admin-nav=\"vouchers\"]").count(), 1);
              }
            }
          } else {
            assert.match(body, /Payments|Revenue/i);
            assert.notEqual(await page.locator("#cashCollectedMetric").innerText(), "Unavailable");
            assert.match(await page.locator("#cashCollectedMetric").innerText(), /3[,.]?000/);
            if (variant.name === "v2") {
              await page.goto(`${admin}/dashboard?${variant.query}#vouchers`);
              await page.locator("#panel-vouchers:not([hidden])").waitFor({ state: "visible" });
              assert.equal(await page.locator("#panel-vouchers:not([hidden]) #generate").isVisible(), true);
            }
          }
          assert.deepEqual(failures, [], `${variant.name}/${role}/${width} has failed API responses`);
          assert.deepEqual(pageErrors, [], `${variant.name}/${role}/${width} emitted page errors`);
          if (restricted && variant.name === "v2") {
            assert.deepEqual(unauthorizedRequests, [], `${variant.name}/${role}/${width} made unauthorized requests`);
          }
        } finally {
          await context.close();
        }
      }
    }
  }
});
