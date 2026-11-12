import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
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
  for (const variant of variants) {
    for (const role of roles) {
      for (const width of [390, 1280]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        const failures = [];
        const pageErrors = [];
        const unauthorizedRequests = [];
        const unauthorizedResponses = [];
        const responseBodies = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (url.origin === api && restrictedRequest(url) && (role === "auditor" || role === "reseller")) {
            unauthorizedRequests.push(url.href);
          }
        });
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (url.origin !== api) return;
          if (response.status() >= 500) failures.push(`${response.status()} ${url.pathname}${url.search}`);
          if (restrictedRequest(url) && (role === "auditor" || role === "reseller")) {
            unauthorizedResponses.push({ url: url.href, status: response.status() });
            responseBodies.push(response.text().then((body) => ({ url: url.href, status: response.status(), body })));
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
            await page.waitForFunction(() => Boolean(document.querySelector("#homeAttention")?.textContent.trim()));
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
          const bodies = await Promise.all(responseBodies);
          assert.deepEqual(failures, [], `${variant.name}/${role}/${width} has failed API responses`);
          assert.deepEqual(pageErrors, [], `${variant.name}/${role}/${width} emitted page errors`);
          if (restricted && variant.name === "v1") {
            assert.ok(unauthorizedResponses.every((response) => response.status === 403),
              `${variant.name}/${role}/${width} restricted requests were not forbidden`);
            assert.ok(bodies.every(({ body }) => !/Permission Customer|permission-payment|PRIVATE/i.test(body)),
              `${variant.name}/${role}/${width} restricted response contained private data`);
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
                assert.equal(await page.locator("[data-admin-nav=\"voucher-print\"]").count(), 0);
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
          await Promise.all(responseBodies);
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
