import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Reseller home (#261, canvas: ResellerHome): a reseller's Home is the phone
// screen. Sell a code shows the code and QR first, then Cash received records
// the sale once; the tiles and Your money come from the server. Ask for more
// codes reaches the owner; Print my codes opens the admin print page.
// Local servers only, synthetic reseller and vouchers.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const at = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();

test("a reseller sells a code for cash from the phone home screen", { timeout: 240000 }, async (t) => {
  const secret = "redesign-reseller-home", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "r-kiosk", username: "brenda", displayName: "Market kiosk", role: "reseller", active: true, passkeys: [], commissionPercent: 10,
      remittances: [{ id: "rem-1", amount: 100, note: "Cash drop", recordedBy: "owner", createdAt: "2026-11-10T09:00:00.000Z" }] });
    s.adminSessions.push({ userId: "r-kiosk", role: "reseller", tokenHash: hashSecret("kiosk", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    let n = 0;
    for (const [planId, price, count] of [["weekly", 1000, 3], ["daily", 300, 2]])
      for (let i = 0; i < count; i++, n++) s.vouchers.push({ id: `v-${planId}-${i}`, planId, code: `NC-KS${String(n).padStart(2, "0")}-${planId === "weekly" ? "WKLY" : "DALY"}`, status: "available",
        activatedAt: null, expiresAt: null, quotaBytes: 5e9, usedBytes: 0, deviceLimit: 1, generatedByAdmin: true, assignedResellerId: "r-kiosk", commissionPercent: 10,
        resale: true, saleType: "sold", saleAmount: price, faceValue: price, createdAt: at(-600) });
    // One sold earlier this week.
    s.vouchers.push({ id: "v-sold", planId: "daily", code: "NC-KS99-SOLD", status: "available", activatedAt: null, expiresAt: null, quotaBytes: 1e9, usedBytes: 0, deviceLimit: 1,
      generatedByAdmin: true, assignedResellerId: "r-kiosk", commissionPercent: 10, resale: true, saleType: "sold", saleAmount: 300, faceValue: 300, createdAt: at(-900),
      cashSale: { id: "sale-0", operationKey: "k".repeat(32), resellerId: "r-kiosk", amount: 300, commissionPercent: 10, receivedAt: at(-1) } });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.RESELLER_SCREENSHOTS || "/tmp/ndahi-reseller-home";
  await mkdir(screenshots, { recursive: true });
  const open = async (width) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "kiosk", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { context, page, errors };
  };
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };

  const { context, page, errors } = await open(390);
  await page.goto(`${admin}/dashboard`);
  const home = page.locator("#resellerHome");
  await home.locator(".reseller-home__title").waitFor();
  assert.equal(await page.locator(".nd-admin-shell").isVisible(), false, "the phone screen replaces the admin shell");
  assert.equal(await text(home.locator(".reseller-home__title")), "Market kiosk");
  assert.equal(await text(home.locator(".reseller-home__sub")), "brenda · keeps 10% of each sale");
  // From the server: one 300 FCFA sale less 10% commission, less the 100 FCFA paid on 10 Nov, leaves 170 to pay.
  assert.equal(await text(home.locator(".reseller-home__stats")), "5 codes in hand 1 sold this week 170 FCFA to pay NDAHI");
  assert.equal(await text(home.locator(".reseller-home__money")), "Your money Collected this week 300 FCFA Your commission 30 FCFA Paid to NDAHI · 10 Nov 100 FCFA Still to pay NDAHI 170 FCFA");
  assert.deepEqual(await home.locator("#resellerPlan option").allTextContents(), ["Weekly · 3 in hand", "Daily · 2 in hand"]);
  await check(page, "reseller-home-390");

  // Sell a code: the code and its QR first, then Cancel.
  await home.getByRole("button", { name: "Sell a code" }).click();
  const sell = home.getByRole("region", { name: "Sell a code" });
  await sell.waitFor();
  assert.equal(await text(sell.locator(".reseller-home__eyebrow")), "SHOW THE CUSTOMER · WEEKLY");
  assert.equal(await text(sell.locator("[data-sell-code]")), "NC-KS00-WKLY");
  assert.match(await sell.locator("img.reseller-home__qr").getAttribute("src"), /^data:image\/png;base64,/);
  assert.equal(await text(sell.locator(".reseller-home__take")), "They scan it, or type it on the Wi-Fi page. Take 1,000 FCFA cash.");
  await check(page, "reseller-selling-390");
  await sell.getByRole("button", { name: "Cancel" }).click();
  await home.getByRole("button", { name: "Sell a code" }).waitFor();
  assert.equal((await store.snapshot()).vouchers.find((v) => v.id === "v-weekly-0").cashSale, undefined, "cancelling records nothing");

  // Sell again, then Cash received: recorded once at the issue price.
  await home.getByRole("button", { name: "Sell a code" }).click();
  await sell.getByRole("button", { name: "Cash received" }).click();
  await home.locator(".reseller-home__sold").waitFor();
  assert.equal(await text(home.locator(".reseller-home__sold")), "Sold NC-KS00-WKLY · 1,000 FCFA added to what you collected");
  assert.equal(await text(home.locator("[data-stock-count]")), "4");
  assert.equal(await text(home.locator("[data-sold-count]")), "2");
  const sale = (await store.snapshot()).vouchers.find((v) => v.id === "v-weekly-0").cashSale;
  assert.deepEqual([sale.amount, sale.commissionPercent, sale.resellerId], [1000, 10, "r-kiosk"]);
  assert.equal(await text(home.locator("[data-collected]")), "1,300 FCFA");
  assert.equal(await text(home.locator("[data-still]")), "1,070 FCFA", "1,300 collected − 130 commission − 100 paid");
  await check(page, "reseller-sold-390");

  // Ask for more codes reaches the owner, once.
  await home.getByRole("button", { name: "Ask for more codes" }).click();
  await home.getByRole("button", { name: "Request sent" }).waitFor();
  assert.equal(await home.getByRole("button", { name: "Request sent" }).isDisabled(), true);
  assert.equal((await store.snapshot()).adminUsers.find((u) => u.id === "r-kiosk").stockRequests.length, 1);

  // Print my codes opens the admin print page in the shell.
  await home.getByRole("link", { name: "Print my codes" }).click();
  await page.waitForURL(/#voucher-print$/);
  await page.locator(".nd-admin-shell").waitFor();
  assert.equal(await home.isHidden(), true);
  assert.deepEqual(errors, []);
  await context.close();

  // Desktop: the same phone column, centred.
  const wide = await open(1280);
  await wide.page.goto(`${admin}/dashboard`);
  await wide.page.locator("#resellerHome .reseller-home__title").waitFor();
  const box = await wide.page.locator(".reseller-home__screen").boundingBox();
  assert.ok(box.width <= 480 && Math.abs(box.x + box.width / 2 - 640) < 2, "a centred phone column");
  await check(wide.page, "reseller-home-1280");
  assert.deepEqual(wide.errors, []);
  await wide.context.close();
});
