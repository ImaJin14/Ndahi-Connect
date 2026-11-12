import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";

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

test("customer security deep links mount in fresh authenticated contexts and survive refresh", async (t) => {
  const secret = "redesign-deep-link-secret";
  let apiServer, staticServer, browser;
  t.after(async () => {
    await browser?.close();
    if (staticServer) await close(staticServer);
    if (apiServer) await close(apiServer);
  });
  const store = createStore({ persistent: false });
  await store.transaction((state) => {
    state.customers.push({
      id: "customer-deep-link",
      name: "Deep Link Customer",
      phone: "670050001",
      pinHash: "$argon2id$v=19$m=65536,t=3,p=4$fixture$fixture",
      passkeys: [],
    });
    state.dashboardSessions.push({
      id: "deep-link-session",
      customerId: "customer-deep-link",
      tokenHash: hashSecret("deep-link-token", secret),
      csrfToken: "deep-link-csrf",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  const apiPort = await reservePort();
  staticServer = createStaticServer("customer", {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    env: { NODE_ENV: "test", UI_V2_PERCENT: "0" },
  });
  await listen(staticServer);
  const portal = `http://127.0.0.1:${staticServer.address().port}`;
  apiServer = createServer({
    store,
    validateConfig: false,
    env: {
      NODE_ENV: "test",
      CUSTOMER_SESSION_SECRET: secret,
      SECRET_PEPPER: secret,
      SESSION_COOKIE_SECURE: "false",
      CUSTOMER_APP_URL: portal,
      BILLING_WORKER_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false",
    },
  });
  await new Promise((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(apiPort, "127.0.0.1", resolve);
  });
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
  });
  const routes = [
    { hash: "passkeys", section: "#accountSecurity", panel: "passkeys" },
    { hash: "pin", section: "#accountSecurity", panel: "pin" },
    { hash: "sessions", section: "#accountSessions" },
    { hash: "editProfile", section: "#emailAccount" },
  ];
  for (const route of routes) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    const failures = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (new URL(response.url()).origin === apiUrl && response.status() >= 500) {
        failures.push(`${response.status()} ${response.url()}`);
      }
    });
    await context.addCookies([{
      name: "customer_session",
      value: "deep-link-token",
      url: `${apiUrl}/api/account`,
      httpOnly: true,
      sameSite: "Lax",
    }]);
    try {
      await page.goto(`${portal}/dashboard?ui=new#${route.hash}`);
      await page.locator(route.section).waitFor({ state: "visible" });
      if (route.panel) {
        await page.locator(`[data-security-content="${route.panel}"]`).waitFor({ state: "visible" });
        assert.equal(await page.locator(`[data-security-panel="${route.panel}"]`).getAttribute("aria-pressed"), "true");
      }
      await page.reload();
      await page.locator(route.section).waitFor({ state: "visible" });
      if (route.panel) {
        await page.locator(`[data-security-content="${route.panel}"]`).waitFor({ state: "visible" });
      }
      assert.deepEqual(errors, [], `${route.hash} emitted page errors`);
      assert.deepEqual(failures, [], `${route.hash} returned failed API responses`);
    } finally {
      await context.close();
    }
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  const failures = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (new URL(response.url()).origin === apiUrl && response.status() >= 500) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });
  await context.addCookies([{
    name: "customer_session",
    value: "deep-link-token",
    url: `${apiUrl}/api/account`,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  try {
    await page.goto(`${portal}/dashboard?ui=new#passkeys`);
    await page.locator('[data-security-content="passkeys"]').waitFor({ state: "visible" });
    await page.getByRole("link", { name: /back/i }).click();
    await page.locator("section.portal-account").waitFor({ state: "visible" });
    await page.goBack();
    await page.locator('[data-security-content="passkeys"]').waitFor({ state: "visible" });
    await page.reload();
    await page.locator('[data-security-content="passkeys"]').waitFor({ state: "visible" });
    assert.deepEqual(errors, [], "passkeys back/reload emitted page errors");
    assert.deepEqual(failures, [], "passkeys back/reload returned failed API responses");
  } finally {
    await context.close();
  }
});
