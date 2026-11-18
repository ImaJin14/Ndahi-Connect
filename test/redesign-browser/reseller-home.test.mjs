import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { blank } from "../../lib/api/state.mjs";
import { createAdminVouchersRoutes } from "../../lib/api/admin-vouchers.mjs";

// Exercise the module against a deliberately lost response. The server fixture
// remembers the first sale, so a replay verifies the same key and payload.
test("reseller home retries a lost cash confirmation without a duplicate and owner sees stock requests", async t => {
  const source = await readFile(new URL("../../admin-app-v2/reseller-ledger.js", import.meta.url));
  const server = http.createServer((req, res) => {
    if (req.url === "/reseller-ledger.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(source); }
    res.writeHead(200, { "content-type": "text/html" }); res.end('<div id="panel-home"></div><div id="resellerLedger"></div>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  t.after(() => context.close());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const { mountResellerLedger } = await import("/reseller-ledger.js");
    const summary = { scope: "self", resellers: [{ resellerId: "r1", username: "seller", active: true }], totals: {} };
    window.requests = []; window.savedSale = null;
    window.call = async (url, options) => {
      if (url.endsWith("?view=home")) return { reseller: { outstandingBalance: window.savedSale ? 450 : 0 }, stock: window.savedSale ? [] : [{ id: "v1", code: "NC-TEST", plan: { name: "Day", price: 500 }, faceValue: 500 }], stockCount: window.savedSale ? 0 : 1, salesThisWeek: window.savedSale ? 1 : 0, weeklyCollected: window.savedSale ? 500 : 0, weeklyCommission: window.savedSale ? 50 : 0 };
      if (url.includes("/vouchers/") && url.endsWith("?full=1")) return { detail: { code: "NC-TEST", qr: "data:image/png;base64,YWJj" } };
      if (url.endsWith("/cash-sale")) {
        const payload = JSON.parse(options.body); window.requests.push({ payload, key: options.headers["idempotency-key"] });
        if (!window.savedSale) { window.savedSale = payload; throw new Error("Connection lost after recording"); }
        if (JSON.stringify(window.savedSale) !== JSON.stringify(payload)) throw new Error("Changed request");
        return { replayed: true, sale: { amount: 500 } };
      }
      if (url.endsWith("?view=stock-requests")) return { requests: [{ resellerId: "r1", resellerName: "Seller & Co", createdAt: "2026-11-18T12:00:00Z" }] };
      return summary;
    };
    window.mount = () => mountResellerLedger(document.querySelector("#resellerLedger"), { initialLedger: summary, role: "reseller", scopeKey: "seller", call: window.call });
    window.mount();
  });
  await page.locator("[data-home-stock]").selectOption("v1");
  await page.locator("[data-home-sale]").waitFor();
  assert.equal(await page.locator("[data-delivered-code]").count(), 0);
  assert.equal(await page.getByText("NC-TEST").count(), 0, "code is not displayed before the sale");
  await page.locator("[data-home-sale]").click();
  await page.locator("[data-home-retry]").waitFor();
  assert.equal(await page.locator("[data-delivered-code]").count(), 0, "a lost response does not reveal the code before the sale is confirmed");
  assert.equal(await page.evaluate(() => window.requests.length), 1);
  const pendingBeforeReload = JSON.parse(await page.evaluate(() => sessionStorage.getItem("ndahi-reseller-home:seller")));
  assert.equal(pendingBeforeReload.voucherId, "v1");
  await page.reload();
  // Install the same fixture after reload while preserving browser session storage.
  await page.evaluate(async () => {
    const { mountResellerLedger } = await import("/reseller-ledger.js");
    window.requests = []; const summary = { scope: "self", resellers: [{ resellerId: "r1", username: "seller", active: true }], totals: {} };
    window.call = async (url, options) => {
      if (url.endsWith("?view=home")) return { reseller: { outstandingBalance: 450 }, stock: [], stockCount: 0, salesThisWeek: 1, weeklyCollected: 500, weeklyCommission: 50 };
      if (url.endsWith("/cash-sale")) { window.requests.push(JSON.parse(options.body)); return { replayed: true, sale: { amount: 500 } }; }
      if (url.includes("/vouchers/") && url.endsWith("?full=1")) return { detail: { code: "NC-TEST", qr: "data:image/png;base64,YWJj" } };
      return summary;
    };
    mountResellerLedger(document.querySelector("#resellerLedger"), { initialLedger: summary, role: "reseller", scopeKey: "seller", call: window.call });
  });
  await page.locator("[data-home-retry]").click();
  await page.getByText("Already recorded 500 FCFA cash received.").waitFor();
  await page.locator("[data-delivered-code]").waitFor();
  assert.equal(await page.locator("[data-delivered-code]").textContent(), "NC-TEST");
  assert.deepEqual(await page.evaluate(() => window.requests[0]), { voucherId: "v1", operationKey: pendingBeforeReload.key });
  const confirmed = JSON.parse(await page.evaluate(() => sessionStorage.getItem("ndahi-reseller-home:seller")));
  assert.equal(confirmed.confirmed, true);
  await page.reload();
  await page.evaluate(async () => {
    const { mountResellerLedger } = await import("/reseller-ledger.js");
    const summary = { scope: "self", resellers: [{ resellerId: "r1", username: "seller" }], totals: {} };
    window.saleCalls = 0;
    const call = async url => {
      if (url.endsWith("?view=home")) return { reseller: {}, stock: [], stockCount: 0, salesThisWeek: 1, weeklyCollected: 500, weeklyCommission: 50 };
      if (url.includes("/vouchers/")) return { detail: { code: "NC-TEST", qr: "data:image/png;base64,YWJj" } };
      if (url.endsWith("/cash-sale")) window.saleCalls++;
      return summary;
    };
    mountResellerLedger(document.querySelector("#resellerLedger"), { initialLedger: summary, role: "reseller", scopeKey: "seller", call });
  });
  await page.locator("[data-delivered-code]").waitFor();
  assert.equal(await page.locator("[data-delivered-code]").textContent(), "NC-TEST");
  assert.equal(await page.evaluate(() => window.saleCalls), 0);
  await page.locator("[data-home-done]").click();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("ndahi-reseller-home:seller")), null);
  await page.evaluate(async () => {
    document.querySelector("#panel-home").innerHTML = "";
    const { mountResellerLedger } = await import("/reseller-ledger.js");
    const summary = { scope: "self", resellers: [{ resellerId: "r1", username: "seller" }], totals: {} };
    const call = async url => {
      if (url.endsWith("?view=home")) return { reseller: {}, stock: [{ id: "v2", code: "NC-TEST-2", plan: { name: "Day", price: 500 }, faceValue: 500 }], stockCount: 1, salesThisWeek: 0, weeklyCollected: 0, weeklyCommission: 0 };
      if (url.endsWith("/cash-sale")) throw Object.assign(new Error("This voucher is no longer available for sale."), { status: 409, code: "VOUCHER_NOT_SELLABLE" });
      return summary;
    };
    mountResellerLedger(document.querySelector("#resellerLedger"), { initialLedger: summary, role: "reseller", scopeKey: "seller", call });
  });
  await page.locator("[data-home-stock]").selectOption("v2");
  await page.locator("[data-home-sale]").click();
  await page.getByText(/This action was not recorded/).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("ndahi-reseller-home:seller")), null);
  assert.equal(await page.locator("[data-home-retry]").count(), 0);
  await page.evaluate(async () => {
    const { mountResellerLedger } = await import("/reseller-ledger.js");
    mountResellerLedger(document.querySelector("#resellerLedger"), { initialLedger: { resellers: [{ resellerId: "r1", username: "seller" }], totals: {} }, role: "owner", scopeKey: "owner", call: async () => ({ requests: [{ resellerId: "r1", resellerName: "Seller & Co", createdAt: "2026-11-18T12:00:00Z" }] }) });
  });
  await page.getByText(/Seller & Co/).waitFor();
});

// Verify the real authenticated route's role-scoped detail payload used for
// code recovery; a different reseller must not receive the sold code or QR.
test("sold voucher details return code and QR only to the assigned reseller", async () => {
  const s = blank();
  s.adminUsers.push({ id: "r1", role: "reseller", username: "seller" }, { id: "r2", role: "reseller", username: "other" });
  s.vouchers.push({ id: "v1", code: "NC-TEST-CODE", assignedResellerId: "r1", status: "available", planId: "daily", faceValue: 500,
    cashSale: { resellerId: "r1", operationKey: "operation-test-123456", amount: 500 } });
  const route = createAdminVouchersRoutes({ clock: () => new Date("2026-11-18T12:00:00Z"), customerOrigin: "https://portal.example.test" });
  async function request(userId) {
    const user = s.adminUsers.find(u => u.id === userId);
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await route({ method: "GET", headers: {} }, res, new URL("/api/admin/vouchers/v1/details?full=1", "http://test"),
      { s, i: {}, administrator: { userId }, adminUser: user, role: "reseller", effects: {} });
    return res;
  }
  const owner = await request("r1");
  assert.equal(owner.status, 200);
  assert.equal(owner.body.detail.code, "NC-TEST-CODE");
  assert.match(owner.body.detail.qr, /^data:image\/png;base64,/);
  const other = await request("r2");
  assert.equal(other.status, 404);
  assert.equal(other.body.detail, undefined);
});
