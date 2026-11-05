import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";

const store = createStore({ persistent: false });
const secret = randomUUID();
const ownerToken = randomUUID();
const resellerToken = randomUUID();
const at = new Date("2030-01-01T12:00:00Z");

const apiServer = createServer({
  store,
  now: () => at,
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
    ADMIN_SESSION_SECRET: secret,
    ADMIN_APP_URL: "http://127.0.0.1:8959",
    ALLOWED_ADMIN_ORIGINS: "http://127.0.0.1:8959",
  },
});

const listen = (server, port) => new Promise((r) => server.listen(port, "127.0.0.1", r));
const close = (server) => new Promise((r) => { server.close(r); server.closeAllConnections(); });

await store.transaction((s) => {
  s.adminUsers.push(
    { id: "staff-owner", username: "fixture-owner", role: "owner", active: true, passkeys: [] },
    { id: "staff-reseller", username: "fixture-reseller", role: "reseller", active: true, passkeys: [] },
  );
  s.adminSessions.push(
    { userId: "staff-owner", tokenHash: hashSecret(ownerToken, secret), role: "owner", csrfToken: "csrf-owner", expiresAt: "2030-01-02T12:00:00Z" },
    { userId: "staff-reseller", tokenHash: hashSecret(resellerToken, secret), role: "reseller", csrfToken: "csrf-reseller", expiresAt: "2030-01-02T12:00:00Z" },
  );
  s.customers.push({
    id: "cust-pii-1",
    name: "Confidential Customer Name",
    phone: "670998877",
    email: "confidential@example.com",
  });
});

const baseline = await store.snapshot();
let browser, website, checks = 0;

try {
  await listen(apiServer, 8958);
  const api = `http://127.0.0.1:${apiServer.address().port}`;
  website = createStaticServer("admin", { apiUrl: api });
  await listen(website, 8959);
  const admin = `http://127.0.0.1:${website.address().port}`;
  const origins = new Set([api, admin]);

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
  });

  async function scenario(name, work, { token = ownerToken, width = 1280 } = {}) {
    await store.transaction((s) => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/*", (route) =>
      origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort(),
    );
    await context.addCookies([{ name: "admin_session", value: token, url: api, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    const errors = [];
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await work(page, context);
      assert.deepEqual(errors, []);
      checks++;
      console.log(`PASS ${name}`);
    } finally {
      await context.close();
    }
  }

  await scenario("bulk voucher generation defaults to A4 3x7 cuttable sheet and supports switching to 58mm/80mm thermal slips and launching print", async (page) => {
    await page.goto(`${admin}/dashboard#voucher-create`);
    await page.locator("#generate").waitFor();

    await page.evaluate(() => {
      window.printCalls = 0;
      window.print = () => {
        window.printCalls++;
      };
    });

    await page.locator('#generate [name="planId"]').selectOption("weekly");
    await page.locator('#generate [name="quantity"]').fill("24");
    await page.getByRole("button", { name: "Generate resale vouchers", exact: true }).click();

    await page.getByText("24 vouchers generated", { exact: true }).waitFor();
    await page.locator("#voucherPrintPreview").waitFor();

    // Multi-voucher batch defaults to A4 bulk cuttable sheet (3x7 = 21 per page -> 2 pages for 24 vouchers)
    const layoutSelect = page.locator("#voucherPrintLayout");
    assert.equal(await layoutSelect.inputValue(), "a4-sheet");
    assert.equal(await page.locator(".a4-voucher-page").count(), 2);
    assert.equal(await page.locator(".a4-voucher-card").count(), 24);
    assert.equal(await page.locator(".a4-voucher-card svg").count(), 24);

    // Switch to 58mm thermal POS slip
    await layoutSelect.selectOption("thermal-58");
    assert.equal(await page.locator('[data-print-surface="thermal-58"]').count(), 1);
    assert.equal(await page.locator(".thermal-slip").count(), 24);

    // Switch to 80mm thermal POS slip
    await layoutSelect.selectOption("thermal-80");
    assert.equal(await page.locator('[data-print-surface="thermal-80"]').count(), 1);

    // Click Print vouchers and verify window.print() is invoked and @media print hides admin shell chrome
    await page.getByRole("button", { name: "Print vouchers", exact: true }).click();
    assert.equal(await page.evaluate(() => window.printCalls), 1);

    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator(".admin-nav").isVisible(), false);
    assert.equal(await page.locator("#generate").isVisible(), false);
    assert.equal(await page.locator(".voucher-print-toolbar").isVisible(), false);
    assert.equal(await page.locator("#voucherPrintSurface").isVisible(), true);
    await page.emulateMedia({ media: "screen" });

    // Close codes clears print preview and resets body attribute
    await page.getByRole("button", { name: "Close codes", exact: true }).click();
    assert.equal(await page.locator("#voucherPrintPreview").count(), 0);
    assert.equal(await page.evaluate(() => document.body.dataset.voucherPrintLayout || ""), "");
  });

  await scenario("single assigned voucher defaults to 58mm thermal POS slip and never leaks customer PII onto printed slips", async (page) => {
    await page.goto(`${admin}/dashboard#voucher-create`);
    await page.locator("#voucherPurpose").selectOption("assigned");
    await page.locator("#voucherSaleType").selectOption("sold");
    await page.locator("#customerSelect").selectOption("cust-pii-1");
    await page.getByRole("button", { name: "Generate assigned voucher", exact: true }).click();

    await page.getByText("1 voucher generated", { exact: true }).waitFor();
    assert.equal(await page.locator("#voucherPrintLayout").inputValue(), "thermal-58");
    assert.equal(await page.locator(".thermal-slip").count(), 1);

    const printHtml = await page.locator("#voucherPrintSurface").innerHTML();
    for (const forbidden of ["cust-pii-1", "Confidential Customer Name", "670998877", "confidential@example.com"]) {
      assert.ok(!printHtml.includes(forbidden), `Printed voucher surface leaked customer PII: ${forbidden}`);
    }
  });

  console.log(`${checks} voucher print browser journeys passed.`);
} finally {
  await browser?.close();
  await close(website);
  await close(apiServer);
}

