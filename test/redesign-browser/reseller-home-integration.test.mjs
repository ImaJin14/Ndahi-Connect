import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";

const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

// Real authenticated API and real static app, synthetic accounts and providers.
// Lose one response only after the server has committed the cash sale.
test("reseller confirms cash through the authenticated API and recovers delivery after a lost response", { timeout: 90000 }, async t => {
  const secret = "reseller-browser-secret", store = createStore({ persistent: false });
  let apiServer, staticServer, browser;
  t.after(async () => { await browser?.close(); if (apiServer) await close(apiServer); if (staticServer) await close(staticServer); });
  await store.transaction(s => {
    s.adminUsers.push({ id: "seller", username: "seller", displayName: "Market seller", role: "reseller", active: true, commissionPercent: 10 },
      { id: "owner", username: "owner", displayName: "Owner", role: "owner", active: true });
    for (const id of ["seller", "owner"]) s.adminSessions.push({ userId: id, role: id === "owner" ? "owner" : "reseller", tokenHash: hashSecret(`session-${id}`, secret), csrfToken: `csrf-${id}`, expiresAt: "2099-01-01T00:00:00Z" });
    s.vouchers.unshift({ id: "resale-voucher", code: "NC-MARKET-ONE", assignedResellerId: "seller", generatedByAdmin: true,
      planId: "weekly", status: "available", resale: true, saleType: "sold", faceValue: 1000, saleAmount: 1000, commissionPercent: 10,
      quotaBytes: 5e9, usedBytes: 0, deviceLimit: 1, createdAt: new Date().toISOString() });
  });
  const port = await reservePort(), api = `http://127.0.0.1:${port}`;
  staticServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", UI_V2_PERCENT: "0" } }));
  const admin = `http://127.0.0.1:${staticServer.address().port}`;
  apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, CUSTOMER_APP_URL: "https://portal.example.test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve, reject) => { apiServer.once("error", reject); apiServer.listen(port, "127.0.0.1", resolve); });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  t.after(() => context.close());
  await context.route("**/*", route => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await context.addCookies([{ name: "admin_session", value: "session-seller", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  let first = true, firstKey = "", secondKey = "";
  await page.route(`${api}/api/admin/resellers/cash-sale`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    const key = route.request().headers()["idempotency-key"];
    if (!first) { secondKey = key; return route.continue(); }
    first = false; firstKey = key;
    const response = await route.fetch();
    assert.equal(response.status(), 201, "the real server commits the first sale before response loss");
    return route.abort("failed");
  });
  await page.goto(`${admin}/dashboard?ui=new#home`);
  await page.locator("[data-home-stock]").selectOption("resale-voucher");
  assert.equal(await page.locator("[data-delivered-code]").count(), 0);
  await page.locator("[data-home-sale]").click();
  await page.locator("[data-home-retry]").waitFor();
  assert.equal(await page.locator("[data-delivered-code]").count(), 0, "uncertain response cannot reveal the code");
  let snapshot = await store.snapshot();
  assert.equal(snapshot.vouchers.find(v => v.id === "resale-voucher").cashSale.amount, 1000);
  assert.equal(snapshot.auditLogs.filter(a => a.action === "reseller.cash_sale_recorded").length, 1);
  await page.reload();
  await page.locator("[data-home-retry]").click();
  await page.locator("[data-delivered-code]").waitFor();
  assert.equal(await page.locator("[data-delivered-code]").textContent(), "NC-MARKET-ONE");
  await page.getByRole("img", { name: "QR code for NC-MARKET-ONE" }).waitFor();
  assert.equal(firstKey, secondKey);
  snapshot = await store.snapshot();
  assert.equal(snapshot.auditLogs.filter(a => a.action === "reseller.cash_sale_recorded").length, 1);
  assert.equal(snapshot.vouchers.find(v => v.id === "resale-voucher").status, "available", "sale does not activate customer access");
  await page.reload();
  await page.locator("[data-delivered-code]").waitFor();
  await page.locator("[data-home-done]").click();
  await page.locator("[data-home-request]").click();
  await page.getByText("Stock request sent.").waitFor();
  snapshot = await store.snapshot();
  assert.equal(snapshot.adminUsers.find(u => u.id === "seller").stockRequests.length, 1);
  assert.equal(snapshot.auditLogs.filter(a => a.action === "reseller.stock_requested").length, 1);
  assert.deepEqual(errors, []);
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => owner.close());
  await owner.route("**/*", route => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await owner.addCookies([{ name: "admin_session", value: "session-owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
  const ownerPage = await owner.newPage(); ownerPage.setDefaultTimeout(12000);
  await ownerPage.goto(`${admin}/dashboard?ui=new#resellers`);
  await ownerPage.locator("[data-owner-stock-requests]").getByText(/Market seller/).waitFor();
});
