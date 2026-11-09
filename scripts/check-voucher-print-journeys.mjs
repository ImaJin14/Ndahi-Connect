import assert from "node:assert/strict";
import jsQR from "jsqr";
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
    CUSTOMER_APP_URL: "http://127.0.0.1:8957",
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
function assertPaperWidth(pdf, expectedMm) {
  const box = pdf.toString("latin1").match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  assert.ok(box, "PDF must declare its physical page dimensions");
  assert.ok(Math.abs(Number(box[1]) * 25.4 / 72 - expectedMm) < 0.3, `PDF paper width must be ${expectedMm}mm`);
}

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

  await scenario("bulk voucher generation offers only 58mm/80mm thermal slips and launches print", async (page) => {
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

    // Bulk generation uses the same thermal slip design as individual vouchers.
    const layoutSelect = page.locator("#voucherPrintLayout");
    assert.equal(await layoutSelect.inputValue(), "thermal-58");
    assert.deepEqual(await layoutSelect.locator("option").evaluateAll(options => options.map(o => o.value)), ["thermal-58", "thermal-80"]);
    assert.equal(await page.locator(".thermal-slip").count(), 24);
    assert.equal(await page.locator(".thermal-slip img").count(), 24);

    // Decode actual rendered pixels: a decorative pattern is not a QR code.
    const pixels = await page.locator(".thermal-slip img").first().evaluate(async (img) => {
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0);
      return { width: canvas.width, height: canvas.height, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
    });
    const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    assert.ok(decoded, "printed QR must decode");
    const redemption = new URL(decoded.data);
    assert.equal(redemption.origin, "http://127.0.0.1:8957");
    assert.equal(redemption.pathname, "/onboarding.html");
    assert.equal(redemption.searchParams.get("action"), "connect");
    assert.equal(redemption.searchParams.get("code"), await page.locator(".thermal-voucher-code").first().textContent());
    assert.deepEqual([...redemption.searchParams.keys()].sort(), ["action", "code"]);
    const thermal58Pdf = await page.pdf({ path: "/tmp/ndahi-voucher-print-58.pdf", preferCSSPageSize: true });
    assertPaperWidth(thermal58Pdf, 58);
    assert.equal((thermal58Pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length, 24, "one thermal slip per page");

    // Switch to 80mm thermal POS slip
    await layoutSelect.selectOption("thermal-80");
    assert.equal(await page.locator('[data-print-surface="thermal-80"]').count(), 1);

    const thermal80Pdf = await page.pdf({ path: "/tmp/ndahi-voucher-print-80.pdf", preferCSSPageSize: true });
    assertPaperWidth(thermal80Pdf, 80);

    // Click Print vouchers and verify window.print() is invoked and @media print hides admin shell chrome
    await page.getByRole("button", { name: "Print vouchers", exact: true }).click();
    assert.equal(await page.evaluate(() => window.printCalls), 1);

    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator(".admin-nav").isVisible(), false);
    assert.equal(await page.locator("main > .page-head").isVisible(), false);
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

    await page.pdf({ path: "/tmp/ndahi-voucher-print-assigned.pdf", preferCSSPageSize: true });
    const printHtml = await page.locator("#voucherPrintSurface").innerHTML();
    for (const forbidden of ["cust-pii-1", "Confidential Customer Name", "670998877", "confidential@example.com"]) {
      assert.ok(!printHtml.includes(forbidden), `Printed voucher surface leaked customer PII: ${forbidden}`);
    }
  });

  await scenario("admin can print a specific user's active voucher from the Vouchers table, Details panel, and Customers tab without PII leakage", async (page) => {
    await store.transaction((s) => {
      s.customers.push({ id: "cust-user-2", name: "Second Customer", phone: "670112233" });
      s.payments.push({
        id: "pay-pii-1",
        customerId: "cust-pii-1",
        planId: "weekly",
        status: "paid",
        amount: 1000,
        currency: "XAF",
        provider: "mock",
        providerReference: "MOMO-PRIVATE-REF",
        payerPhone: "699887766",
      });
      s.vouchers.push(
        {
          id: "v-active-user-1",
          customerId: "cust-pii-1",
          paymentId: "pay-pii-1",
          planId: "weekly",
          code: "NC-USER-ONE1",
          status: "active",
          activatedAt: at.toISOString(),
          expiresAt: "2030-01-08T12:00:00.000Z",
          quotaBytes: 5e9,
          usedBytes: 1e9,
          deviceLimit: 2,
        },
        {
          id: "v-expired-user-2",
          customerId: "cust-user-2",
          planId: "daily",
          code: "NC-USER-TWO2",
          status: "expired",
          activatedAt: "2029-12-30T12:00:00.000Z",
          expiresAt: "2029-12-31T12:00:00.000Z",
          quotaBytes: 1e9,
          usedBytes: 1e9,
          deviceLimit: 1,
        },
      );
    });

    await page.goto(`${admin}/dashboard#vouchers`);
    await page.locator('[data-voucher-record="v-active-user-1"]').waitFor();

    // Active voucher row exposes Print voucher; expired voucher row does not
    assert.equal(await page.locator('[data-voucher-record="v-active-user-1"] [data-print-voucher="v-active-user-1"]').count(), 1);
    assert.equal(await page.locator('[data-voucher-record="v-expired-user-2"] [data-print-voucher]').count(), 0);

    // Expand Details to verify ownership, then click Print voucher slip from inside Details
    await page.getByRole("button", { name: "Details for voucher NC-USER-ONE1", exact: true }).click();
    const detailsPanel = page.locator('[data-voucher-panel="v-active-user-1"]');
    await detailsPanel.getByText("Confidential Customer Name", { exact: true }).waitFor();
    await detailsPanel.getByRole("button", { name: "Print voucher slip", exact: true }).click();

    await page.locator("#activeVoucherPrint").getByText("Voucher slip ready to print (NC-USER-ONE1)", { exact: true }).waitFor();
    assert.equal(await page.locator("#voucherPrintLayout").inputValue(), "thermal-58");
    assert.equal(await page.locator("#activeVoucherPrint .thermal-slip").count(), 1);
    assert.match(await page.locator("#activeVoucherPrint .thermal-slip").textContent(), /Expires 2030-01-08/);

    // Verify QR code decodes to exact onboarding redemption link for NC-USER-ONE1
    const pixels = await page.locator("#activeVoucherPrint .thermal-slip img").first().evaluate(async (img) => {
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0);
      return { width: canvas.width, height: canvas.height, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
    });
    const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    assert.ok(decoded, "active voucher printed QR must decode");
    assert.equal(decoded.data, "http://127.0.0.1:8957/onboarding.html?action=connect&code=NC-USER-ONE1");

    // Verify zero PII leaks onto the printed surface
    const slipHtml = await page.locator("#voucherPrintSurface").innerHTML();
    for (const forbidden of ["cust-pii-1", "Confidential Customer Name", "670998877", "confidential@example.com", "pay-pii-1", "MOMO-PRIVATE-REF", "699887766"]) {
      assert.ok(!slipHtml.includes(forbidden), `Active voucher slip leaked PII: ${forbidden}`);
    }

    // Verify @media print hides table and admin shell and produces a 1-page 58mm PDF
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator("#voucherRecords").isVisible(), false);
    assert.equal(await page.locator("#voucherPrintSurface").isVisible(), true);
    await page.emulateMedia({ media: null });

    const active58Pdf = await page.pdf({ path: "/tmp/ndahi-voucher-print-active-58.pdf", preferCSSPageSize: true });
    assertPaperWidth(active58Pdf, 58);
    assert.equal((active58Pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length, 1);

    // Close preview in Vouchers tab
    await page.getByRole("button", { name: "Close print preview", exact: true }).click();
    assert.equal(await page.locator("#voucherPrintPreview").count(), 0);

    // Now navigate to Customers tab and print directly from User One's customer row
    await page.getByRole("link", { name: "Customers", exact: true }).click();
    await page.locator('[data-print-customer-voucher="cust-pii-1"]').waitFor();
    await page.locator('[data-print-customer-voucher="cust-pii-1"]').click();

    await page.locator("#customerVoucherPrint").getByText("Voucher slip ready to print (NC-USER-ONE1)", { exact: true }).waitFor();
    const customer58Pdf = await page.pdf({ path: "/tmp/ndahi-voucher-print-customer-58.pdf", preferCSSPageSize: true });
    assertPaperWidth(customer58Pdf, 58);
    assert.equal((customer58Pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length, 1);
  });

  console.log(`${checks} voucher print browser journeys passed.`);
} finally {
  await browser?.close();
  await close(website);
  await close(apiServer);
}

