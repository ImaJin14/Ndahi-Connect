import assert from "node:assert/strict";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";

const apiPort = Number(process.env.ADMIN_AUTH_API_PORT || 8398);
const adminPort = Number(process.env.ADMIN_AUTH_PORT || 8399);
const api = `http://127.0.0.1:${apiPort}`;
const admin = `http://127.0.0.1:${adminPort}`;
const fixtureOrigins = new Set([api, admin].map((url) => new URL(url).origin));
const password = "synthetic-admin-password";
const roles = ["owner", "operator", "auditor", "reseller"];
const width = Number(process.env.ADMIN_AUTH_WIDTH || 1440);
const screenshots = process.env.ADMIN_AUTH_SCREENSHOTS || "/tmp/ndahi-admin-auth-checks";
const store = createStore({ persistent: false });
const server = createServer({
  store,
  validateConfig: false,
  env: {
    NODE_ENV: "test",
    PAYMENT_MODE: "mock",
    EMAIL_MODE: "mock",
    MIKROTIK_MODE: "mock",
    OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false",
    SECURITY_ALERTS_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false",
    SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin,
    ALLOWED_ADMIN_ORIGINS: admin,
    ADMIN_SESSION_SECRET: "synthetic-admin-session-secret",
  },
});
const website = createStaticServer("admin", { apiUrl: api });
const listen = (app, port) => new Promise((resolve, reject) => {
  app.once("error", reject);
  app.listen(port, "127.0.0.1", resolve);
});
const close = (app) => new Promise((resolve) => {
  app.close(resolve);
  app.closeAllConnections();
});

await store.transaction(async (state) => {
  const passwordHash = await argon2.hash(password);
  state.adminUsers = roles.map((role) => ({
    id: randomUUID(),
    username: `fixture-${role}`,
    displayName: `Fixture ${role}`,
    role,
    passwordHash,
    passkeys: [],
    active: true,
    createdAt: new Date().toISOString(),
  }));
});

let browser;
try {
  await listen(server, apiPort);
  await listen(website, adminPort);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
  });

  const unauthenticated = await fetch(`${api}/api/admin/dashboard`);
  assert.equal(unauthenticated.status, 401);
  await mkdir(screenshots, { recursive: true });

  for (const role of roles) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return ["http:", "https:"].includes(url.protocol) && !fixtureOrigins.has(url.origin)
        ? route.abort("blockedbyclient")
        : route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
    await page.goto(`${admin}/dashboard`);
    await page.waitForURL("**/login");
    await page.goto(`${admin}/login`);
    await page.getByLabel("Username").fill(`fixture-${role}`);
    await page.locator("#adminPassword").fill(password);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL("**/dashboard");
    await page.getByRole("tab", { name: "Generate voucher" }).click();
    const generateButton = page.getByRole("button", { name: "Generate resale vouchers" });
    await generateButton.waitFor();
    await generateButton.click();
    if (role === "auditor") {
      await page.getByText("Your role does not permit this action.").waitFor();
    } else {
      await page.getByText("1 voucher generated").waitFor();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);

    const responses = await page.evaluate(async ({ api, role }) => {
      const dashboardResponse = await fetch(api + "/api/admin/dashboard", { credentials: "include" });
      const dashboard = { status: dashboardResponse.status, body: await dashboardResponse.json() };
      const call = async (path, options = {}) => {
        const response = await fetch(api + path, {
          credentials: "include",
          headers: { "content-type": "application/json", "x-csrf-token": dashboard.body.csrfToken },
          ...options,
        });
        return { status: response.status, body: await response.json() };
      };
      const generate = {
        method: "POST",
        body: JSON.stringify({ planId: "weekly", purpose: "resale", quantity: 1 }),
      };
      return {
        dashboard,
        operational: await call("/api/admin/vouchers/generate", generate),
        sensitive: await call("/api/admin/users", {
          method: "POST",
          body: JSON.stringify({
            username: `not-created-${role}`,
            role: "auditor",
            password: "synthetic-new-password",
          }),
        }),
      };
    }, { api, role });

    assert.equal(responses.dashboard.status, 200);
    assert.equal(responses.dashboard.body.profile.role, role);
    const operationalAllowed = ["owner", "operator", "reseller"].includes(role);
    assert.equal(responses.operational.status, operationalAllowed ? 201 : 403);
    assert.equal(responses.sensitive.status, role === "owner" ? 201 : 403);
    const state = await store.snapshot();
    assert.equal(state.adminUsers.some((user) => user.username === `not-created-${role}`), role === "owner");
    console.log(`PASS administrator ${role} authorization at ${width}px`);
    } catch (error) {
      await page.screenshot({ path: `${screenshots}/failure-${role}-${width}.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
  console.log("PASS TEST-002 administrator authorization browser journeys");
} finally {
  await browser?.close();
  await close(website);
  await close(server);
}
