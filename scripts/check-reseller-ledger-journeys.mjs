import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";

const store = createStore({ persistent: false });
const secret = randomUUID();
const tokens = {
  owner: randomUUID(),
  reseller: randomUUID(),
  reseller2: randomUUID(),
};
const now = new Date("2030-01-01T10:00:00.000Z");

await store.transaction((s) => {
  s.adminUsers.push(
    {
      id: "staff-owner",
      username: "owner-admin",
      displayName: "Main Owner",
      role: "owner",
      active: true,
      passkeys: [],
    },
    {
      id: "staff-reseller-1",
      username: "kiosk-buea",
      displayName: "Buea Market Kiosk",
      role: "reseller",
      active: true,
      commissionPercent: 10,
      remittances: [],
      passkeys: [],
    },
    {
      id: "staff-reseller-2",
      username: "kiosk-molyko",
      displayName: "Molyko Junction POS",
      role: "reseller",
      active: true,
      commissionPercent: 12,
      remittances: [],
      passkeys: [],
    },
  );
  s.adminSessions.push(
    {
      userId: "staff-owner",
      tokenHash: hashSecret(tokens.owner, secret),
      role: "owner",
      csrfToken: randomUUID(),
      expiresAt: "2030-01-02T10:00:00.000Z",
    },
    {
      userId: "staff-reseller-1",
      tokenHash: hashSecret(tokens.reseller, secret),
      role: "reseller",
      csrfToken: randomUUID(),
      expiresAt: "2030-01-02T10:00:00.000Z",
    },
    {
      userId: "staff-reseller-2",
      tokenHash: hashSecret(tokens.reseller2, secret),
      role: "reseller",
      csrfToken: randomUUID(),
      expiresAt: "2030-01-02T10:00:00.000Z",
    },
  );
  // Seed 2 redeemed weekly vouchers (1,000 FCFA each) and 1 unsold weekly voucher for Buea Market Kiosk
  s.vouchers.push(
    {
      id: "v-sold-1",
      code: "NC-SOLD-0001",
      planId: "weekly",
      status: "active",
      activatedAt: now.toISOString(),
      expiresAt: "2030-01-08T10:00:00.000Z",
      quotaBytes: null,
      usedBytes: 0,
      deviceLimit: 2,
      generatedByAdmin: true,
      generatedByAdminId: "staff-owner",
      assignedResellerId: "staff-reseller-1",
      resale: true,
      saleType: "sold",
      saleAmount: 1000,
      faceValue: 1000,
      createdAt: now.toISOString(),
    },
    {
      id: "v-sold-2",
      code: "NC-SOLD-0002",
      planId: "weekly",
      status: "active",
      activatedAt: now.toISOString(),
      expiresAt: "2030-01-08T10:00:00.000Z",
      quotaBytes: null,
      usedBytes: 0,
      deviceLimit: 2,
      generatedByAdmin: true,
      generatedByAdminId: "staff-owner",
      assignedResellerId: "staff-reseller-1",
      resale: true,
      saleType: "sold",
      saleAmount: 1000,
      faceValue: 1000,
      createdAt: now.toISOString(),
    },
    {
      id: "v-stock-1",
      code: "NC-STCK-0003",
      planId: "weekly",
      status: "available",
      activatedAt: null,
      expiresAt: null,
      quotaBytes: null,
      usedBytes: 0,
      deviceLimit: 2,
      generatedByAdmin: true,
      generatedByAdminId: "staff-owner",
      assignedResellerId: "staff-reseller-1",
      resale: true,
      saleType: "sold",
      saleAmount: 1000,
      faceValue: 1000,
      createdAt: now.toISOString(),
    },
  );
});

const listen = (app, port) => new Promise((r) => app.listen(port, "127.0.0.1", r));
const close = (app) => new Promise((r) => { app.close(r); app.closeAllConnections(); });

const apiOrigin = "http://127.0.0.1:8992";
const adminOrigin = "http://127.0.0.1:8991";
const server = createServer({
  store,
  now: () => now,
  validateConfig: false,
  env: {
    NODE_ENV: "test",
    PAYMENT_MODE: "mock",
    EMAIL_MODE: "mock",
    MIKROTIK_MODE: "mock",
    OMADA_MODE: "not-configured",
    BILLING_WORKER_ENABLED: "false",
    SECURITY_ALERTS_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false",
    PAYMENT_WEBHOOK_WORKER_ENABLED: "false",
    SESSION_COOKIE_SECURE: "false",
    ADMIN_SESSION_SECRET: secret,
    ADMIN_APP_URL: adminOrigin,
    ALLOWED_ADMIN_ORIGINS: adminOrigin,
  },
});

const website = createStaticServer("admin", { apiUrl: apiOrigin });
await listen(server, 8992);
await listen(website, 8991);

const origins = new Set([apiOrigin, adminOrigin]);
let browser;

try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
  });

  // Journey 1: Owner views reseller inventory, updates commission %, assigns new stock, and records cash remittance
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", (route) =>
      origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"),
    );
    await context.addCookies([
      { name: "admin_session", value: tokens.owner, url: apiOrigin, httpOnly: true, sameSite: "Lax" },
    ]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${adminOrigin}/dashboard#vouchers`);
    await page.locator("[data-reseller-ledger]").waitFor();

    const row = page.locator('[data-reseller-row="staff-reseller-1"]');
    await row.waitFor();
    assert.match(await row.locator('[data-cell="stock"]').textContent(), /1 unsold \/ 2 sold \/ 3 total/);
    assert.match(await row.locator('[data-cell="collected"]').textContent(), /2,000 FCFA/);
    assert.match(await row.locator('[data-cell="commission"]').textContent(), /200 FCFA \(10%\)/);
    assert.match(await row.locator('[data-cell="outstanding"]').textContent(), /1,800 FCFA/);

    // Configure commission split to 15%
    const commForm = page.locator("[data-reseller-commission-form]");
    await commForm.locator('select[name="resellerId"]').selectOption("staff-reseller-1");
    await commForm.locator('input[name="commissionPercent"]').fill("15");
    await commForm.locator('button[type="submit"]').click();
    await page.getByText("Updated commission split for Buea Market Kiosk to 15%.").waitFor();
    assert.match(await row.locator('[data-cell="commission"]').textContent(), /300 FCFA \(15%\)/);
    assert.match(await row.locator('[data-cell="outstanding"]').textContent(), /1,700 FCFA/);

    // Record a 1,200 FCFA cash remittance handoff
    const remitForm = page.locator("[data-reseller-remittance-form]");
    await remitForm.locator('select[name="resellerId"]').selectOption("staff-reseller-1");
    await remitForm.locator('input[name="amount"]').fill("1200");
    await remitForm.locator('input[name="note"]').fill("Evening cash drop");
    await remitForm.locator('button[type="submit"]').click();
    await page.getByText("Recorded 1,200 FCFA cash remittance from Buea Market Kiosk.").waitFor();
    assert.match(await row.locator('[data-cell="remitted"]').textContent(), /1,200 FCFA/);
    assert.match(await row.locator('[data-cell="outstanding"]').textContent(), /500 FCFA/);
    assert.match(await page.locator("[data-remittance-history-table]").textContent(), /Evening cash drop/);

    // Generate 2 more resale vouchers assigned directly to Buea Market Kiosk
    await page.goto(`${adminOrigin}/dashboard#voucher-create`);
    await page.locator("#voucherResellerSelect").selectOption("staff-reseller-1");
    await page.locator('#voucherQuantity input[name="quantity"]').fill("2");
    await page.locator('#generate button[type="submit"], #generate button:not([type])').click();
    await page.locator("#generated .generated-codes code").first().waitFor();

    await page.goto(`${adminOrigin}/dashboard#vouchers`);
    assert.match(await row.locator('[data-cell="stock"]').textContent(), /3 unsold \/ 2 sold \/ 5 total/);

    assert.deepEqual(errors, []);
    await context.close();
    console.log("PASS owner manages reseller inventory, commission split, and audited cash remittance");
  }

  // Journey 2: Reseller sees only their own stock, sales, commission earnings, and remittance balance
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) =>
      origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"),
    );
    await context.addCookies([
      { name: "admin_session", value: tokens.reseller, url: apiOrigin, httpOnly: true, sameSite: "Lax" },
    ]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${adminOrigin}/dashboard#vouchers`);
    await page.locator("[data-reseller-ledger]").waitFor();
    const ledgerText = await page.locator("[data-reseller-ledger]").textContent();
    assert.match(ledgerText, /My inventory, sales & cash remittance/);
    assert.match(ledgerText, /Buea Market Kiosk/);
    assert.doesNotMatch(ledgerText, /Molyko Junction POS/);
    assert.equal(await page.locator("[data-reseller-remittance-form]").count(), 0);
    assert.equal(await page.locator("[data-reseller-commission-form]").count(), 0);
    assert.match(
      await page.locator('[data-reseller-row="staff-reseller-1"] [data-cell="outstanding"]').textContent(),
      /500 FCFA/,
    );

    assert.deepEqual(errors, []);
    await context.close();
    console.log("PASS reseller role sees only own stock, sales, earnings, and remittance balance");
  }
} finally {
  await browser?.close();
  await close(website);
  await close(server);
}
