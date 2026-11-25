import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const reservePort = async () => {
  const s = await listen(http.createServer());
  const port = s.address().port;
  await close(s);
  return port;
};
const close = (server) => new Promise((resolve) => {
  server.close(resolve);
  server.closeAllConnections();
});

test("all v2/store pages load cleanly and fixed customer CSRF + admin self-service actions succeed in Chromium", async (t) => {
  const customerSecret = "smoke-cust-secret";
  const adminSecret = "smoke-admin-secret";
  const pepper = "smoke-pepper";
  const oldPin = "482913";
  const newPin = "739152";
  const now = new Date();
  const future = new Date(+now + 7 * 864e5).toISOString();

  const store = createStore({ persistent: false });
  const operatorPassHash = await argon2.hash(oldPin);
  await store.transaction((s) => {
    s.networkSetup = { runtimeRouterEnabled: true, connections: { router: { mode: "live", revision: "rev-1" } } };
    s.customers.push({
      id: "cust-smoke",
      name: "Smoke Customer",
      phone: "670050009",
      pinHash: "$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture",
      passkeys: [],
    });
    s.dashboardSessions.push({
      id: "sess-smoke",
      customerId: "cust-smoke",
      tokenHash: hashSecret("cust-smoke-tok", customerSecret),
      csrfToken: "cust-smoke-csrf",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    s.vouchers.push({
      id: "v-smoke",
      customerId: "cust-smoke",
      code: "NC-SMOK-1234",
      planId: "weekly",
      status: "active",
      activatedAt: now.toISOString(),
      expiresAt: future,
      quotaBytes: 5e9,
      usedBytes: 5e8,
      deviceLimit: 3,
      wifiDevicesAt: now.toISOString(),
      wifiDevices: [
        { mac: "AA:BB:CC:DD:EE:01", name: "Phone", address: "10.20.0.5", sessionId: "*1", startedAt: now.toISOString(), usedBytes: 1000 },
      ],
    });
    s.adminUsers.push({
      id: "op-smoke",
      username: "operator1",
      email: "operator1@ndahi.test",
      displayName: "Operator One",
      role: "operator",
      active: true,
      passwordHash: operatorPassHash,
      pinHash: operatorPassHash,
      passkeys: [],
    });
    s.adminSessions.push({
      id: "adm-sess-smoke",
      userId: "op-smoke",
      role: "operator",
      tokenHash: hashSecret("adm-smoke-tok", adminSecret),
      csrfToken: "adm-smoke-csrf",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    s.adminUsers.push({
      id: "own-smoke",
      username: "owner1",
      email: "owner1@ndahi.test",
      displayName: "Owner One",
      role: "owner",
      active: true,
      passwordHash: operatorPassHash,
      pinHash: operatorPassHash,
      passkeys: [],
    });
    s.adminSessions.push({
      id: "adm-own-sess",
      userId: "own-smoke",
      role: "owner",
      tokenHash: hashSecret("adm-owner-tok", adminSecret),
      csrfToken: "adm-owner-csrf",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });

  const apiPort = await reservePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  const customerServer = createStaticServer("customer", {
    apiUrl,
    hotspotLoginUrl: "https://hotspot.ndahi.test/login",
    env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" },
  });
  const adminServer = createStaticServer("admin", { apiUrl, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } });
  const storeServer = createStaticServer("store", { apiUrl, env: { NODE_ENV: "test" } });
  await Promise.all([listen(customerServer), listen(adminServer), listen(storeServer)]);

  const customerUrl = `http://127.0.0.1:${customerServer.address().port}`;
  const adminUrl = `http://127.0.0.1:${adminServer.address().port}`;
  const storeUrl = `http://127.0.0.1:${storeServer.address().port}`;

  const apiServer = createServer({
    store,
    validateConfig: false,
    env: {
      NODE_ENV: "production",
      PAYMENT_MODE: "mock",
      EMAIL_MODE: "mock",
      MIKROTIK_MODE: "mock",
      OMADA_MODE: "mock",
      CUSTOMER_SESSION_SECRET: customerSecret,
      ADMIN_SESSION_SECRET: adminSecret,
      SECRET_PEPPER: pepper,
      SESSION_COOKIE_SECURE: "false",
      CUSTOMER_APP_URL: customerUrl,
      ADMIN_APP_URL: adminUrl,
      ALLOWED_ADMIN_ORIGINS: adminUrl,
      STORE_APP_URL: storeUrl,
      BILLING_WORKER_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false",
      LOG_LEVEL: "silent",
    },
  });
  await new Promise((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(apiPort, "127.0.0.1", resolve);
  });

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
  });

  t.after(async () => {
    await browser?.close();
    await Promise.all([close(customerServer), close(adminServer), close(storeServer), close(apiServer)]);
  });

  const allowedOrigins = new Set([apiUrl, customerUrl, adminUrl, storeUrl]);
  const attachGuards = (page) => {
    const pageErrors = [];
    const badResponses = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("response", (res) => {
      const u = new URL(res.url());
      if (allowedOrigins.has(u.origin) && res.status() >= 500) {
        badResponses.push(`${res.status()} ${res.url()}`);
      }
      if ([customerUrl, adminUrl, storeUrl].includes(u.origin) && res.status() === 404) {
        badResponses.push(`404 ${res.url()}`);
      }
    });
    return { pageErrors, badResponses };
  };

  // 1. Cold-load sweep of every HTML page across customer-app-v2, admin-app-v2, and store-app
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route("**/*", (route) => allowedOrigins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    const page = await ctx.newPage();
    const { pageErrors, badResponses } = attachGuards(page);

    const customerPages = [
      "/onboarding.html", "/login.html", "/forgot-pin.html", "/verify.html", "/claim.html",
      "/hotspot.html", "/pair.html", "/pair-review.html", "/voucher-connect.html",
      "/voucher-ready.html", "/voucher-print.html", "/home-router.html", "/wifi-connected.html",
      "/billing-terms.html", "/help.html", "/ui-kit.html",
    ];
    for (const p of customerPages) {
      await page.goto(customerUrl + p, { waitUntil: "domcontentloaded" });
    }
    for (const p of ["/login.html", "/home-routers.html", "/voucher-print.html"]) {
      await page.goto(adminUrl + p, { waitUntil: "domcontentloaded" });
    }
    await page.goto(storeUrl + "/", { waitUntil: "domcontentloaded" });
    await page.locator("h1").waitFor();

    assert.deepEqual(pageErrors, [], "No uncaught page errors across static pages");
    assert.deepEqual(badResponses, [], "No 404 assets or 5xx API responses across static pages");
    await ctx.close();
  }

  // 2. Customer v2 device nickname & current/reset actions with CSRF enforcement
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route("**/*", (route) => allowedOrigins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await ctx.addCookies([{
      name: "customer_session",
      value: "cust-smoke-tok",
      url: `${apiUrl}/api/account`,
      httpOnly: true,
      sameSite: "Lax",
    }]);
    const page = await ctx.newPage();
    const { pageErrors, badResponses } = attachGuards(page);

    // Simulated 503 recovery on nickname save, then successful retry
    let failNextNick = true;
    await page.route("**/api/account/device-management/nickname", (route) => {
      if (failNextNick) {
        failNextNick = false;
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary outage." }) });
      }
      return route.continue();
    });
    await page.goto(`${customerUrl}/dashboard#devices`);
    const renameSummary = page.locator("details.rename-device summary").first();
    await renameSummary.waitFor({ state: "visible" });
    await renameSummary.click();
    const renameForm = page.locator('form[data-rename-device="AA:BB:CC:DD:EE:01"]');
    await renameForm.waitFor({ state: "visible" });
    await renameForm.locator('input[name="nickname"]').fill("Mom Tablet");
    await renameForm.locator('button[type="submit"]').click();
    await page.locator("#dashboardMessage").filter({ hasText: "Service temporarily unavailable" }).waitFor();
    assert.equal(await renameForm.locator('button[type="submit"]').isDisabled(), false, "Submit button re-enables after 503");

    const [nickRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/account/device-management/nickname") && r.request().method() === "POST"),
      renameForm.locator('button[type="submit"]').click(),
    ]);
    assert.equal(nickRes.status(), 200);
    await page.locator("#dashboardMessage").filter({ hasText: "Device nickname saved." }).waitFor();
    assert.equal(badResponses.length, 1);
    assert.match(badResponses[0], /^503 .*\/api\/account\/device-management\/nickname$/);
    badResponses.length = 0;

    // Navigate to #home and cycle all 5 portal tabs on mobile, then update profile name
    await page.goto(`${customerUrl}/dashboard#home`);
    await page.locator('body[data-current-tab="home"]').waitFor();
    for (const tab of ["internet", "shop", "activity", "account", "home"]) {
      await page.locator(`[data-portal-tab="${tab}"]`).click();
      await page.locator(`body[data-current-tab="${tab}"]`).waitFor();
    }
    await page.locator('[data-portal-tab="account"]').click();
    await page.locator('a.portal-account__edit[href="/dashboard#editProfile"]').click();
    const profileForm = page.locator("#profileEdit");
    await profileForm.locator('input[name="name"]').waitFor({ state: "visible" });
    await profileForm.locator('input[name="name"]').fill("Smoke Updated");
    const [profRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/account/profile") && r.request().method() === "POST"),
      profileForm.locator('button[type="submit"]').click(),
    ]);
    assert.equal(profRes.status(), 200);

    // Authenticated gift.html load check
    await page.goto(`${customerUrl}/gift.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#giftPhone").waitFor({ state: "visible" });

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(badResponses, []);
    await ctx.close();
  }

  // 3. Admin v2 operator self-service password/PIN change on #profile -> re-login
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route("**/*", (route) => allowedOrigins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await ctx.addCookies([{
      name: "admin_session",
      value: "adm-smoke-tok",
      url: `${apiUrl}/api/admin`,
      httpOnly: true,
      sameSite: "Strict",
    }]);
    const page = await ctx.newPage();
    const { pageErrors, badResponses } = attachGuards(page);

    await page.goto(`${adminUrl}/dashboard#profile`);
    await page.locator("#adminPassword").waitFor({ state: "visible" });
    await page.locator('#adminPassword input[name="newPassword"]').fill(newPin);
    await page.locator('#adminPassword input[name="confirmPassword"]').fill(newPin);

    await page.locator('#adminPassword button[type="submit"]').click();
    const proofDialog = page.getByRole("dialog", { name: "Verify administrator action" });
    await proofDialog.waitFor({ state: "visible" });
    await proofDialog.locator('input[name="currentPassword"]').fill(oldPin);
    const [pwRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/admin/profile/password") && r.request().method() === "POST"),
      proofDialog.locator('button[type="submit"]').click(),
    ]);
    assert.equal(pwRes.status(), 200, "Operator self-service password change must succeed");
    await page.locator("[data-password-message]").filter({ hasText: /changed/i }).waitFor();

    // Clear session and sign back in with the new password
    await ctx.clearCookies({ name: "admin_session" });
    await page.goto(`${adminUrl}/login`);
    await page.getByLabel("Email", { exact: true }).fill("operator1@ndahi.test");
    await page.getByLabel("PIN", { exact: true }).fill(newPin);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/\/dashboard/);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(badResponses, []);
    await ctx.close();
  }

  // 4. Admin v2 owner full-view sweep + bundle create/delete actions
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route("**/*", (route) => allowedOrigins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await ctx.addCookies([{
      name: "admin_session",
      value: "adm-owner-tok",
      url: `${apiUrl}/api/admin`,
      httpOnly: true,
      sameSite: "Strict",
    }]);
    const page = await ctx.newPage();
    const { pageErrors, badResponses } = attachGuards(page);

    for (const hash of ["home", "devices", "connections", "network-setup", "bundles", "vouchers", "payments", "customers", "resellers", "store", "audit", "profile"]) {
      await page.goto(`${adminUrl}/dashboard#${hash}`);
      await page.locator("#adminTitle").waitFor({ state: "visible" });
    }

    // Bundle catalogue (#338): unpublish and publish a bundle, then delete one never bought.
    await page.goto(`${adminUrl}/dashboard#bundles`);
    const row = page.locator('[data-cat-row="unlimited-7d-3"]');
    await row.waitFor({ state: "visible" });
    for (const [label, path] of [["Unpublish", "unpublish"], ["Publish", "publish"]]) {
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith(`/api/admin/catalogue/${path}`) && r.request().method() === "POST"),
        row.getByRole("button", { name: `${label} Personal Unlimited · 7 days · 3 devices`, exact: true }).click(),
      ]);
      assert.equal(res.status(), 200);
    }
    await row.getByRole("button", { name: "Delete Personal Unlimited · 7 days · 3 devices", exact: true }).click();
    const [delRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/admin/catalogue/delete") && r.request().method() === "POST"),
      page.getByRole("alertdialog", { name: "Remove bundle" }).getByRole("button", { name: "Delete permanently", exact: true }).click(),
    ]);
    assert.equal(delRes.status(), 200);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(badResponses, []);
    await ctx.close();
  }
});
