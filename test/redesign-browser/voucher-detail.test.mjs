import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Voucher detail (#258, canvas: AdminVoucherDetail): a code in the list opens
// its page with the ticket, usage, history, details and actions; mark sold,
// revoke with an inline confirmation; an unused code shows "Not used".

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const later = (days) => new Date(Date.now() + days * 864e5).toISOString();
const text = async (locator) => (await locator.textContent()).replace(/\s+/g, " ");

test("a voucher's page shows its ticket and history and runs its actions", { timeout: 180000 }, async (t) => {
  // Created clearly before it was redeemed, so the history order is fixed.
  const secret = "redesign-voucher-detail", store = createStore({ persistent: false }), created = later(-5);
  await store.transaction((s) => {
    s.customers.push({ id: "c-fon", name: "J. Fon", phone: "670004019" });
    s.vouchers.unshift({ id: "v-unused", planId: "weekly", code: "M3VX-7KQD", status: "available", generatedByAdmin: true, saleType: "sold", saleAmount: 1000, faceValue: 1000,
      quotaBytes: 5e9, usedBytes: 0, deviceLimit: 3, createdAt: later(-1) });
    s.vouchers.unshift({ id: "v-active", customerId: "c-fon", planId: "weekly", code: "K7PM-42XQ", status: "active", generatedByAdmin: true, saleType: "gift", saleAmount: 0, faceValue: 1000,
      quotaBytes: 5e9, usedBytes: 1.8e9, deviceLimit: 3, createdAt: created, activatedAt: later(-4.9), expiresAt: later(2), routerSyncStatus: "synchronized",
      wifiDevices: [{ mac: "AA:BB:CC:DD:EE:01" }, { mac: "AA:BB:CC:DD:EE:02" }] });
    s.auditLogs.unshift({ id: "a1", action: "voucher.generated", actor: "owner", meta: { voucherIds: ["v-active"], quantity: 1, saleType: "gift" }, at: created });
    s.adminUsers.push({ id: "vd-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "vd-owner", role: "owner", tokenHash: hashSecret("vd-owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const staticServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${staticServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SESSION_COOKIE_SECURE: "false", ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin,
    CUSTOMER_APP_URL: "https://portal.example.test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(staticServer); });
  const screenshots = "/tmp/ndahi-voucher-detail";
  await mkdir(screenshots, { recursive: true });

  // Phone first: the desktop run changes the voucher (mark sold, revoke).
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "vd-owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${admin}/dashboard#vouchers`);
      await page.getByRole("link", { name: "K7PM-42XQ" }).click();
      await page.waitForURL(/#voucher\/v-active$/);
      await page.getByRole("heading", { name: "K7PM-42XQ", level: 1 }).waitFor();
      const ticket = page.getByRole("region", { name: "Voucher", exact: true });
      await ticket.getByRole("img", { name: "QR code for K7PM-42XQ" }).waitFor();
      assert.match(await text(ticket), /NDAHI.*Gift.*Weekly/);
      assert.match(await text(page.locator("#voucherStatusHost")), /In use/);
      const usage = page.getByRole("region", { name: "Usage" });
      assert.match(await text(usage), /3\.2 GB.*of 5 GB left · 1\.8 GB used.*2 of 3/);
      assert.equal(await usage.locator(".admin-voucher__bar i").evaluate((bar) => bar.style.width), "36%", "the bar shows data used, not full");
      const history = page.getByRole("region", { name: "History" });
      assert.match(await text(history), /Created by Owner.*Redeemed by J\. Fon.*Ends/);
      const details = page.getByRole("region", { name: "Details" });
      assert.match(await text(details), /J\. Fon · 6•• •• 40 19.*Gift · face value 1,000 XAF.*Single voucher.*Synced to MikroTik/);
      assert.deepEqual(await lowContrastText(page), [], `contrast at ${width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
      await page.screenshot({ path: `${screenshots}/active-${width}.png`, fullPage: true });
      if (width === 1280) {
        await page.getByRole("button", { name: "Mark as sold", exact: true }).click();
        await page.getByRole("button", { name: "Mark as gift", exact: true }).waitFor();
        assert.match(await page.getByRole("region", { name: "History" }).textContent(), /Sold — sold for cash, counted as revenue/);
        await page.getByRole("button", { name: "Revoke voucher", exact: true }).click();
        const confirm = page.getByRole("alertdialog", { name: "Confirm revoke" });
        assert.match(await text(confirm), /Revoke K7PM-42XQ\?.*J\. Fon's devices are disconnected now/);
        await confirm.getByRole("button", { name: "Keep it", exact: true }).click();
        assert.equal(await confirm.isVisible(), false);
        assert.equal((await store.snapshot()).vouchers.find((v) => v.id === "v-active").status, "active", "keeping it changes nothing");
        await page.getByRole("button", { name: "Revoke voucher", exact: true }).click();
        await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
        await page.getByText(/^Revoked .* by Owner\.$/).waitFor();
        assert.equal(await page.getByRole("region", { name: "Actions" }).count(), 0, "a revoked voucher has no actions");
        assert.equal((await store.snapshot()).vouchers.find((v) => v.id === "v-active").status, "revoked");
        // An unused code: "Not used" and when its days start.
        await page.goto(`${admin}/dashboard#voucher/v-unused`);
        await page.getByText("Not redeemed yet. The bundle's 7 days only start when someone enters or scans this code.", { exact: true }).waitFor();
        assert.match(await text(page.locator("#voucherStatusHost")), /Not used/);
        await page.screenshot({ path: `${screenshots}/unused-${width}.png`, fullPage: true });
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

// Unlimited (canvas: AdminVoucherDetail, #344; owner 26 Nov): the ticket's terms
// and "Valid until … if not used", time left with a validity bar and device
// slots used, the batch reference, the device and place of the redemption,
// "Used up" once its time ran out (here and in Recent vouchers), every action
// in every state (one that can't act says why), and Resend that sends.
test("an Unlimited voucher's page is drawn as the board", { timeout: 180000 }, async (t) => {
  const secret = "redesign-voucher-unlimited", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.bundles.push({ id: "p2", name: "Week Unlimited", price: 3500, validityHours: 168, accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaGb: null, status: "published", catalogue: "unlimited" });
    s.customers.push({ id: "c-fon", name: "J. Fon", phone: "670004019", email: "fon@example.test", emailVerifiedAt: later(-60) });
    const base = { planId: "p2", generatedByAdmin: true, saleType: "gift", saleAmount: 0, faceValue: 3500, accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, validityHours: 168,
      quotaBytes: null, batchReference: "B-1029-01", createdAt: later(-10), useBy: later(80) };
    s.vouchers.push({ ...base, id: "u-active", code: "K7PM-42XQ", status: "active", customerId: "c-fon", usedBytes: 1.8e9, activatedAt: later(-4.5), expiresAt: later(2.5),
      redeemedDevice: "android_phone", redeemedPlace: "AP-Market", routerSyncStatus: "synchronized", emailStatus: "sent", emailSentAt: later(-4.5) },
    { ...base, id: "u-ended", code: "U5ED-9XQA", status: "expired", customerId: "c-fon", usedBytes: 6.4e9, activatedAt: later(-14), expiresAt: later(-7) },
    { ...base, id: "u-stock", code: "S7CK-4ABC", status: "available", usedBytes: 0 });
    s.wifiDeviceGrants = [{ id: "g1", customerId: "c-fon", voucherId: "u-active", mac: "AA:BB:CC:4F:A2:10", status: "approved", routerRevision: "" },
      { id: "g2", customerId: "c-fon", voucherId: "u-active", mac: "AA:BB:CC:19:C7:5E", status: "approved", routerRevision: "" },
      { id: "g3", customerId: "c-fon", voucherId: "u-ended", mac: "AA:BB:CC:00:00:01", status: "revoked", routerRevision: "" }];
    s.auditLogs.unshift({ id: "b1", action: "voucher.resale_batch_generated", actor: "owner", meta: { voucherIds: ["u-active", "u-ended", "u-stock"], quantity: 3, saleType: "gift" }, at: later(-10) });
    s.adminUsers.push({ id: "vu-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "vu-owner", role: "owner", tokenHash: hashSecret("vu-owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const staticServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${staticServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SESSION_COOKIE_SECURE: "false", ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin,
    CUSTOMER_APP_URL: "https://portal.example.test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(staticServer); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1110 }, timezoneId: "Africa/Douala" });
  await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await context.addCookies([{ name: "admin_session", value: "vu-owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => context.close());
  const useBy = new Date(later(80)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Douala" });

  // In use.
  await page.goto(`${admin}/dashboard#voucher/u-active`);
  const ticket = page.getByRole("region", { name: "Voucher", exact: true });
  await ticket.waitFor();
  assert.match(await text(ticket), new RegExp(`Unlimited data · 7 days · 2 device slots.*Valid until ${useBy} if not used`));
  const usage = page.getByRole("region", { name: "Usage" });
  assert.match(await text(usage), /1\.8 GB\s*used · unlimited data\s*2 days\s*ends .*2 of 2\s*device slots used/);
  assert.equal(await usage.getByRole("img").getAttribute("aria-label"), "4.5 of 7 days used");
  const history = page.getByRole("region", { name: "History" });
  assert.match(await text(history), /Created in batch B-1029-01 by Owner.*Redeemed by J\. Fon on an Android phone at AP-Market.* · receipt emailed.*Ends/);
  assert.match(await text(page.getByRole("region", { name: "Details" })), /Gift · face value 3,500 XAF.*B-1029-01 · 3 codes/);
  assert.deepEqual(await page.getByRole("region", { name: "Actions" }).getByRole("button").allInnerTexts(), ["Mark as sold", "Resend receipt email", "Revoke voucher"]);
  assert.deepEqual(await lowContrastText(page), []);
  // Resend sends again: a fresh delivery.
  await page.getByRole("button", { name: "Resend receipt email", exact: true }).click();
  await page.getByText("The receipt email is on its way.", { exact: true }).waitFor();
  const resent = (await store.snapshot()).vouchers.find((v) => v.id === "u-active");
  assert.deepEqual([resent.emailResends, resent.emailDelivery.status], [1, "pending"]);

  // Ended: "Used up", the slots it used, no Ended row; Print slip and Revoke say why.
  await page.goto(`${admin}/dashboard#voucher/u-ended`);
  await page.getByRole("region", { name: "Usage" }).waitFor();
  assert.match(await text(page.locator("#voucherStatusHost")), /Used up/);
  assert.match(await text(page.getByRole("region", { name: "Usage" })), /6\.4 GB\s*used · unlimited data\s*Ended\s*.* · validity ended\s*1 of 2\s*device slots used/);
  assert.doesNotMatch(await text(page.getByRole("region", { name: "History" })), /validity ran out|Ended/);
  await page.getByRole("button", { name: "Print slip", exact: true }).click();
  await page.getByText("This voucher has ended, so its slip can't be printed.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Revoke voucher", exact: true }).click();
  await page.getByText("This voucher has already ended, so there's nothing to revoke.", { exact: true }).waitFor();
  assert.equal((await store.snapshot()).vouchers.find((v) => v.id === "u-ended").status, "expired", "nothing changed");

  // Not used: Resend says why.
  await page.goto(`${admin}/dashboard#voucher/u-stock`);
  await page.getByRole("button", { name: "Resend receipt email", exact: true }).click();
  await page.getByText("No receipt email yet: it's sent when the code is redeemed.", { exact: true }).waitFor();

  // Recent vouchers: the ended one reads "Used up".
  await page.goto(`${admin}/dashboard#vouchers`);
  await page.locator('[data-voucher-record="u-ended"]').getByText("Used up", { exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/ndahi-voucher-detail/unlimited-list.png" });
  assert.deepEqual(errors, []);
});
