import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Voucher print (#392, canvas: AdminVoucherPrint) at 1280 px, with the
// owner's decisions of 25 Nov:
// - "Print batch B-2511-01" over "20 slips · [plan] · for [reseller] · 58 mm
//   thermal slips"; the slips stay thermal (#208, #240), chosen by width;
// - the accurate note: codes work as soon as they're made;
// - Print 20 slips, then "Sent to printer", with the preview link kept.
// Local servers only, synthetic data, a fixed clock (17:30 in Douala, 25 Nov).

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const now = new Date("2026-11-25T16:30:00Z");

test("Voucher print names the batch, keeps thermal slips and prints them", { timeout: 300000 }, async (t) => {
  const secret = "redesign-admin-voucher-print", store = createStore({ persistent: false });
  await store.transaction((s) => {
    seedCatalogue(s, now);
    s.catalogue = { ...(s.catalogue || {}), mode: "unlimited" };
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] },
      { id: "r-kiosk", username: "kiosk", displayName: "Market kiosk", role: "reseller", active: true, passkeys: [], commissionPercent: 10, remittances: [] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await listen(apiServer, apiPort);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.ADMIN_VOUCHER_PRINT_SCREENSHOTS || "/tmp/ndahi-admin-voucher-print";
  await mkdir(screenshots, { recursive: true });
  // Opens Vouchers, creates a batch, and opens its print screen.
  const batch = async ({ lang = "en", width = 1280, count = 20, reseller = "r-kiosk" } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1110 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
    await context.clock.setFixedTime(now);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] });
      set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Fonts from outside are blocked here on purpose; any other console error counts.
    page.on("console", (message) => { if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) errors.push(message.text()); });
    await page.goto(`${admin}/dashboard#vouchers`);
    await page.locator("#voucherModeBatch").click();
    await page.locator('#generate select[name="planId"]').selectOption("unlimited-7d-2");
    await page.locator('#voucherQuantity input[name="quantity"]').fill(String(count));
    if (reseller) await page.locator("#voucherResellerSelect").selectOption(reseller);
    await page.locator('#generate button[type="submit"]').click();
    await page.locator("#generated .admin-batch a.nd-btn").click();
    await page.locator("#voucherPrintSurface .thermal-slip").first().waitFor();
    return { page, context, errors };
  };

  const { page, context, errors } = await batch();
  assert.equal(await text(page.locator("#adminBack")), "← Vouchers");
  assert.equal(await text(page.locator("#adminTitle")), "Print batch B-2511-01");
  assert.equal(await page.locator("#adminTitle").evaluate((el) => getComputedStyle(el).fontSize), "34px");
  assert.equal(await text(page.locator("#adminLede")), "20 slips · Personal Unlimited · for Market kiosk · 58 mm thermal slips");
  assert.equal(await text(page.locator(".admin-print__format")), "Slip width");
  assert.deepEqual(await page.locator("#voucherPrintLayout option").allInnerTexts(), ["58 mm thermal", "80 mm thermal"]);
  assert.equal(await text(page.locator("#printVouchersNow")), "Print 20 slips");
  assert.equal(await text(page.locator(".admin-print__note")), "Codes work as soon as they're made and start when a customer first redeems one. Hand them only to the named reseller — every print is logged.");
  assert.equal(await page.locator(".admin-print__tray .thermal-slip").count(), 20);
  // The reference is the server's, kept on each code.
  const codes = (await store.snapshot()).vouchers.filter((v) => v.resale);
  assert.equal(codes.length, 20);
  assert.ok(codes.every((v) => v.batchReference === "B-2511-01"));
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/voucher-print-en.png`, fullPage: false });

  // The width chosen is named under the title.
  await page.locator("#voucherPrintLayout").selectOption("thermal-80");
  await page.locator('[data-print-surface="thermal-80"]').waitFor();
  assert.equal(await text(page.locator("#adminLede")), "20 slips · Personal Unlimited · for Market kiosk · 80 mm thermal slips");
  // Print opens the preview; the button then reads as drawn, with the preview link kept.
  const popup = context.waitForEvent("page");
  await page.locator("#printVouchersNow").click();
  await (await popup).close();
  assert.equal(await text(page.locator("#printVouchersNow")), "Sent to printer");
  assert.equal(await page.getByRole("link", { name: "Open print preview in this tab", exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  await context.close();

  // A batch with no reseller: the second of the day, and the other note.
  const own = await batch({ count: 3, reseller: "" });
  assert.equal(await text(own.page.locator("#adminTitle")), "Print batch B-2511-02");
  assert.equal(await text(own.page.locator("#adminLede")), "3 slips · Personal Unlimited · 58 mm thermal slips");
  assert.equal(await text(own.page.locator(".admin-print__note")), "Codes work as soon as they're made and start when a customer first redeems one. Hand them only to the person they're for — every print is logged.");
  assert.deepEqual(own.errors, []);
  await own.context.close();

  // French.
  const fr = await batch({ lang: "fr", count: 2 });
  assert.equal(await text(fr.page.locator("#adminTitle")), "Imprimer le lot B-2511-03");
  assert.equal(await text(fr.page.locator("#adminLede")), "2 tickets · Personal Unlimited · pour Market kiosk · tickets thermiques 58 mm");
  assert.equal(await text(fr.page.locator(".admin-print__format")), "Largeur du ticket");
  assert.deepEqual(await fr.page.locator("#voucherPrintLayout option").allInnerTexts(), ["Thermique 58 mm", "Thermique 80 mm"]);
  assert.match(await text(fr.page.locator(".admin-print__note")), /^Les codes fonctionnent dès leur création/);
  await fr.page.mouse.move(0, 0);
  await fr.page.screenshot({ path: `${screenshots}/voucher-print-fr.png`, fullPage: false });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();

  // Phones: no sideways scrolling.
  const phone = await batch({ width: 390, count: 1 });
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await lowContrastText(phone.page), []);
  await phone.context.close();
});
