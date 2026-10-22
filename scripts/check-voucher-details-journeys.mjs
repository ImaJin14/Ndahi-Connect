import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";

const store = createStore({ persistent: false }), secret = randomUUID(), token = randomUUID();
const at = new Date("2030-01-01T12:00:00Z");
const apiServer = createServer({ store, now: () => at, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret, ADMIN_APP_URL: "http://127.0.0.1:8949", ALLOWED_ADMIN_ORIGINS: "http://127.0.0.1:8949" } });
const listen = (server, port) => new Promise((r) => server.listen(port, "127.0.0.1", r));
const close = (server) => new Promise((r) => { server.close(r); server.closeAllConnections(); });
await store.transaction((s) => {
  s.adminUsers.push({ id: "staff-owner", username: "fixture-owner", role: "owner", active: true, passkeys: [] });
  s.adminSessions.push({ userId: "staff-owner", tokenHash: hashSecret(token, secret), role: "owner", csrfToken: "csrf", expiresAt: "2030-01-02T12:00:00Z" });
  s.customers.push({ id: "c1", name: "Linked customer", phone: "670000001" });
  s.payments.push({ id: "p1", provider: "mock", status: "paid", amount: 500, currency: "XAF", payerPhone: "699999999", providerReference: "PAYMENT-REF" });
  s.vouchers.push({ id: "linked", code: "NC-LINKED", customerId: "c1", paymentId: "p1", planId: "weekly", status: "active", quotaBytes: 1000000, usedBytes: 500000, deviceLimit: 2, activatedAt: at.toISOString(), expiresAt: "2030-01-02T12:00:00Z" },
    { id: "stock", code: "NC-STOCK", customerId: null, planId: "weekly", status: "available", quotaBytes: null, usedBytes: 0, deviceLimit: 2 });
});
const baseline = await store.snapshot();
let browser, website, checks = 0;
try {
  await listen(apiServer, 8948); const api = `http://127.0.0.1:${apiServer.address().port}`;
  website = createStaticServer("admin", { apiUrl: api }); await listen(website, 8949);
  const admin = `http://127.0.0.1:${website.address().port}`, origins = new Set([api, admin]);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function scenario(name, work) {
    await store.transaction((s) => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
    await context.route("**/*", (route) => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    await context.addCookies([{ name: "admin_session", value: token, url: api, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(12000); page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(`${admin}/dashboard#vouchers`); await page.getByRole("button", { name: "Details for voucher NC-LINKED", exact: true }).waitFor();
      await work(page, context); assert.deepEqual(errors, []); checks++; console.log(`PASS ${name}`);
    } finally { await context.close(); }
  }
  const panel = (page, id = "linked") => page.locator(`[data-voucher-panel="${id}"]`);
  const expand = (page, code = "NC-LINKED") => page.getByRole("button", { name: `Details for voucher ${code}`, exact: true });
  await scenario("lazy ownership expansion is accessible and read-only at 320px; refresh follows current customer not payer", async (page) => {
    let reads = 0; page.on("request", (request) => { if (request.url().endsWith("/linked/details")) reads++; });
    assert.equal(reads, 0); const before = await store.snapshot(), button = expand(page);
    await button.focus(); await page.keyboard.press("Enter");
    await panel(page).getByText("Linked customer", { exact: true }).waitFor();
    assert.equal(await button.getAttribute("aria-expanded"), "true");
    assert.equal(await panel(page).locator("section").getAttribute("id"), await button.getAttribute("aria-controls"));
    await panel(page).getByText("670000001", { exact: true }).waitFor(); await panel(page).getByText("699999999", { exact: true }).waitFor();
    await panel(page).getByText("Payer phone (may differ from account phone)", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await store.transaction((s) => { s.customers[0].name = "Updated linked customer"; s.customers[0].phone = "670000003"; });
    await panel(page).getByRole("button", { name: "Refresh details" }).click();
    await panel(page).getByText("Updated linked customer", { exact: true }).waitFor();
    assert.equal(await panel(page).getByText("670000001", { exact: true }).count(), 0);
    assert.equal(await panel(page).getByText("699999999", { exact: true }).count(), 1);
    await button.click(); assert.equal(await button.getAttribute("aria-expanded"), "false");
    assert.equal(await panel(page).locator("dd").count(), 0, "collapsed contact data removed");
    await expand(page, "NC-STOCK").click(); await panel(page, "stock").getByText("Not linked yet", { exact: true }).waitFor();
    const after = await store.snapshot();
    for (const key of ["vouchers", "payments", "routerCommands", "auditLogs"]) assert.deepEqual(after[key], before[key]);
  });
  await scenario("failed expansion retries locally; background refresh preserves panel and keyboard focus", async (page) => {
    await page.clock.install(); let count = 0;
    await page.route("**/api/admin/vouchers/linked/details", async (route) => {
      if (++count === 1) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Synthetic read failed" }) });
      return route.continue();
    });
    const button = expand(page); await button.click();
    await panel(page).getByText("Synthetic read failed", { exact: false }).waitFor();
    await panel(page).getByRole("button", { name: "Retry details" }).click(); await panel(page).getByText("Linked customer", { exact: true }).waitFor();
    await button.focus(); await page.clock.fastForward(15010);
    await page.waitForFunction(() => document.querySelector('[data-voucher-panel="linked"]').getAttribute("aria-busy") !== "true");
    assert.equal(await button.getAttribute("aria-expanded"), "true"); assert.equal(await button.evaluate((b) => b === document.activeElement), true);
    assert.equal(await panel(page).getByText("Linked customer", { exact: true }).count(), 1);
  });
  await scenario("a delayed detail cannot fill a filtered replacement row", async (page) => {
    let release, started; const gate = new Promise((r) => { release = r; }), begun = new Promise((r) => { started = r; });
    await page.route("**/api/admin/vouchers/linked/details", async (route) => {
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response }).catch(() => {});
    });
    await expand(page).click(); await begun;
    await page.getByRole("searchbox", { name: "Search vouchers", exact: true }).fill("NC-STOCK");
    await expand(page, "NC-STOCK").waitFor(); release();
    await page.waitForFunction(() => document.querySelectorAll('[data-voucher-record="linked"]').length === 0);
    await expand(page, "NC-STOCK").click(); await panel(page, "stock").getByText("Not linked yet", { exact: true }).waitFor();
    assert.equal(await page.locator("#voucherRecords").getByText("Linked customer", { exact: true }).count(), 0);
    assert.equal(await page.locator("#voucherRecords").getByText("670000001", { exact: true }).count(), 0);
  });
  await scenario("pagination drops the previous row and delayed details cannot reappear on another page", async (page) => {
    await store.transaction((s) => {
      for (let n = 0; n < 28; n++) s.vouchers.push({ id: `page-${n}`, code: `NC-PAGE-${n}`, planId: "weekly", status: "available", quotaBytes: null, usedBytes: 0, deviceLimit: 1 });
    });
    await page.reload(); await expand(page).waitFor();
    let release, started; const gate = new Promise((r) => { release = r; }), begun = new Promise((r) => { started = r; });
    await page.route("**/api/admin/vouchers/linked/details", async (route) => {
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response }).catch(() => {});
    });
    await expand(page).click(); await begun;
    await page.locator("#voucherRecords").getByRole("button", { name: "Next", exact: true }).click();
    await expand(page, "NC-PAGE-23").waitFor(); release();
    assert.equal(await page.locator('[data-voucher-record="linked"]').count(), 0);
    await expand(page, "NC-PAGE-23").click(); await panel(page, "page-23").getByText("Not linked yet", { exact: true }).waitFor();
    assert.equal(await page.locator("#voucherRecords").getByText("670000001", { exact: true }).count(), 0);
  });
  await scenario("demotion while details are delayed rechecks authority before rendering contacts", async (page) => {
    let release, started; const gate = new Promise((r) => { release = r; }), begun = new Promise((r) => { started = r; });
    await page.route("**/api/admin/vouchers/linked/details", async (route) => {
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response }).catch(() => {});
    });
    await expand(page).click(); await begun;
    await store.transaction((s) => { s.adminUsers[0].role = "auditor"; }); release();
    const restricted = page.getByRole("button", { name: "Details for voucher linked", exact: true }); await restricted.waitFor();
    await restricted.click(); await panel(page).getByText("Restricted for this staff role", { exact: true }).waitFor();
    assert.equal(await page.locator("#voucherRecords").getByText("670000001", { exact: true }).count(), 0);
    assert.equal(await page.locator("#voucherRecords [data-voucher]").count(), 0);
  });
  await scenario("logout invalidates an in-flight detail and removes all contact DOM", async (page) => {
    let release, started; const gate = new Promise((r) => { release = r; }), begun = new Promise((r) => { started = r; });
    await page.route("**/api/admin/vouchers/linked/details", async (route) => {
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response }).catch(() => {});
    });
    await expand(page).click(); await begun;
    await page.getByRole("button", { name: "Logout", exact: true }).click();
    await page.waitForFunction(() => location.pathname === "/login"); release();
    assert.equal(await page.getByText("670000001", { exact: true }).count(), 0);
    const state = await store.snapshot(); assert.equal(state.adminSessions.length, 0);
  });
  await scenario("visibility revalidation clears old contact DOM and disabled staff redirect to sign-in", async (page) => {
    await expand(page).click(); await panel(page).getByText("Linked customer", { exact: true }).waitFor();
    await store.transaction((s) => { s.adminUsers[0].active = false; });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(() => location.pathname === "/login");
    assert.equal(await page.getByText("670000001", { exact: true }).count(), 0);
  });
  console.log(`PASS ${checks} voucher ownership browser journeys`);
} finally { await browser?.close(); if (website) await close(website); await close(apiServer); }
