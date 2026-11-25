import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Cash and settlements (#379, canvas: AdminCash) at 1280 px:
// - Today · 7 days · Month (owner, 25 Nov: they replace the fixed "since
//   1 November" total), opening on 7 days; a change reloads every figure;
// - the four figures and Net provider settlements per network from saved
//   payments: confirmed collections, what customers paid (price plus the saved
//   fee), fees, completed refunds ("—" when none, as drawn) and the net;
// - the accountant's CSV of the table, and "See individual payments →".
// Local servers only, synthetic data, a fixed clock (17:30 in Douala, 25 Nov).

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const now = new Date("2026-11-25T16:30:00Z");

async function start(t, seed) {
  const secret = "redesign-admin-cash", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    seed(s);
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
  const open = async ({ lang = "en", width = 1280 } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1110 }, timezoneId: "Africa/Douala", acceptDownloads: true });
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
    await page.goto(`${admin}/dashboard#cash`);
    await page.locator("#cashCollectedReport .nd-metric").first().waitFor();
    return { page, context, errors };
  };
  return { open };
}

// Saved payments over the month: MTN and Orange bundles, a store order, a refund, reseller cash.
function seedMonth(s) {
  const paid = (id, network, amount, at, extra = {}) => ({ id, provider: "mesomb", providerReference: `ref-${id}`, network, payerPhone: network === "mtn" ? "670001245" : "690001245",
    amount, fee: Math.round(amount * 0.02), total: Math.round(amount * 1.02), currency: "XAF", status: "paid", createdAt: at, confirmedAt: at, ...extra });
  s.payments.push(
    paid("t1", "mtn", 2500, "2026-11-25T10:00:00Z", { providerFee: 48, providerTotal: 2548 }), // today, MeSomb's reported fee
    paid("t2", "orange", 1000, "2026-11-25T08:00:00Z"), // today
    paid("w1", "mtn", 2500, "2026-11-21T10:00:00Z", { status: "refunded", refund: { status: "completed" } }), // this week, refunded
    paid("w2", "orange", 2500, "2026-11-19T10:00:00Z"), // this week
    paid("m1", "mtn", 5000, "2026-11-05T10:00:00Z"), // this month
    { id: "mock", provider: "mock", amount: 99999, currency: "XAF", status: "paid", confirmedAt: "2026-11-25T10:00:00Z" }, // a test payment: never counted
  );
  s.storeOrders = [{ id: "o1", payment: { id: "store-o1", provider: "mesomb", providerReference: "ref-store", network: "mtn", payerPhone: "670002210", amount: 30000, fee: 600, total: 30600,
    currency: "XAF", status: "paid", createdAt: "2026-11-24T09:00:00Z", confirmedAt: "2026-11-24T09:00:00Z" } }];
  s.adminUsers.push({ id: "r-kiosk", username: "kiosk", displayName: "Market kiosk", role: "reseller", active: true, passkeys: [],
    remittances: [{ id: "rem-1", amount: 20000, recordedBy: "owner", createdAt: "2026-11-23T09:00:00Z" }, { id: "rem-2", amount: 5000, recordedBy: "owner", createdAt: "2026-11-10T09:00:00Z" }] });
}

const figures = (page) => page.locator("#cashCollectedReport .nd-metric").evaluateAll((tiles) => tiles.map((tile) => tile.innerText.replace(/\s+/g, " ").trim()));
const table = (page) => page.locator("#cashCollectedReport tbody tr").evaluateAll((rows) => rows.map((tr) => [...tr.cells].map((td) => td.innerText.replace(/\s+/g, " ").trim())));

test("Cash and settlements shows the drawn periods, figures and net provider settlements from saved payments", { timeout: 300000 }, async (t) => {
  const { open } = await start(t, seedMonth);
  const screenshots = process.env.ADMIN_CASH_SCREENSHOTS || "/tmp/ndahi-admin-cash";
  await mkdir(screenshots, { recursive: true });
  const { page, context, errors } = await open();
  assert.equal(await text(page.locator("#adminTitle")), "Cash and settlements.");
  const periods = page.locator("#cashPeriods button");
  assert.deepEqual(await periods.allInnerTexts(), ["Today", "7 days", "Month"]);
  assert.deepEqual(await periods.evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-pressed"))), ["false", "true", "false"]);
  assert.equal(await page.locator("#cashPeriods").getAttribute("role"), "group");
  // The last 7 days (from 19 Nov): t1, t2, w1, w2 and the store order.
  assert.deepEqual(await figures(page), ["8,500 FCFA Internet payments, last 7 days", "30,000 FCFA Store purchases, last 7 days",
    "2,500 FCFA Completed refunds, last 7 days", "20,000 FCFA Reseller cash received, last 7 days"]);
  assert.equal(await text(page.locator("#cashReportTitle")), "Net provider settlements");
  assert.equal(await text(page.locator(".admin-cash__lede")), "What each provider should pay into the bank after fees, last 7 days.");
  assert.deepEqual(await page.locator("#cashCollectedReport th").allInnerTexts(), ["Provider", "Confirmed collections", "Cash before fees", "Fees", "Refunds", "Net to settle"]);
  // MTN: t1 (2,500 + MeSomb's 48), w1 (2,550, refunded), the store order (30,600). Orange: t2, w2, no refund: "—".
  assert.deepEqual(await table(page), [
    ["MTN MoMo", "3", "35,698 FCFA", "698 FCFA", "2,500 FCFA", "32,500 FCFA"],
    ["Orange Money", "2", "3,570 FCFA", "70 FCFA", "—", "3,500 FCFA"],
  ]);
  assert.equal(await page.locator(".admin-cash__link").getAttribute("href"), "/dashboard#payments");
  assert.equal(await text(page.locator(".admin-cash__link")), "See individual payments →");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/cash-week-en.png`, fullPage: true });
  // The accountant's CSV: the table as shown, with the period.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export for accountant (CSV)" }).click();
  const csv = await download;
  assert.equal(csv.suggestedFilename(), "ndahi-settlements-week.csv");
  assert.deepEqual((await readFile(await csv.path(), "utf8")).split("\n"), [
    '"provider","confirmed_collections","cash_before_fees_xaf","fees_xaf","refunds_xaf","net_to_settle_xaf","from","to"',
    '"mtn","3","35698","698","2500","32500","2026-11-18T23:00:00.000Z","2026-11-25T16:30:00.000Z"',
    '"orange","2","3570","70","0","3500","2026-11-18T23:00:00.000Z","2026-11-25T16:30:00.000Z"',
  ]);
  // Today, by keyboard: every figure and row reloads.
  await periods.nth(1).focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.innerText), "Today");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".admin-cash__lede")?.textContent.endsWith("today."));
  assert.equal(await periods.nth(0).getAttribute("aria-pressed"), "true");
  assert.deepEqual(await figures(page), ["3,500 FCFA Internet payments, today", "0 FCFA Store purchases, today", "0 FCFA Completed refunds, today", "0 FCFA Reseller cash received, today"]);
  assert.deepEqual(await table(page), [["MTN MoMo", "1", "2,548 FCFA", "48 FCFA", "—", "2,500 FCFA"], ["Orange Money", "1", "1,020 FCFA", "20 FCFA", "—", "1,000 FCFA"]]);
  await page.screenshot({ path: `${screenshots}/cash-today-en.png`, fullPage: true });
  // This month: from 1 November.
  await periods.nth(2).click();
  await page.waitForFunction(() => document.querySelector(".admin-cash__lede")?.textContent.endsWith("this month."));
  assert.deepEqual(await figures(page), ["13,500 FCFA Internet payments, this month", "30,000 FCFA Store purchases, this month",
    "2,500 FCFA Completed refunds, this month", "25,000 FCFA Reseller cash received, this month"]);
  assert.deepEqual((await table(page)).map((row) => row.slice(0, 2)), [["MTN MoMo", "4"], ["Orange Money", "2"]]);
  await page.screenshot({ path: `${screenshots}/cash-month-en.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  const fr = await open({ lang: "fr" });
  assert.equal(await text(fr.page.locator("#adminTitle")), "Espèces et règlements.");
  assert.deepEqual(await fr.page.locator("#cashPeriods button").allInnerTexts(), ["Aujourd'hui", "7 jours", "Mois"]);
  assert.equal(await text(fr.page.locator(".admin-cash__lede")), "Ce que chaque opérateur doit verser à la banque après frais, 7 derniers jours.");
  assert.deepEqual(await fr.page.locator("#cashCollectedReport th").allInnerTexts(), ["Opérateur", "Encaissements confirmés", "Encaissé avant frais", "Frais", "Remboursements", "Net à reverser"]);
  assert.equal((await table(fr.page))[0][5], "32 500 FCFA");
  await fr.page.mouse.move(0, 0);
  await fr.page.screenshot({ path: `${screenshots}/cash-week-fr.png`, fullPage: true });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();

  // Phones: no sideways scrolling.
  const phone = await open({ width: 390 });
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await lowContrastText(phone.page), []);
  await phone.context.close();
});

test("evidence that needs review shows no settlement figures, only the review notice", { timeout: 120000 }, async (t) => {
  const { open } = await start(t, (s) => {
    s.payments.push({ id: "bad", provider: "mesomb", providerReference: "ref-bad", network: "mtn", amount: 1000, currency: "EUR", status: "paid", createdAt: "2026-11-25T10:00:00Z", confirmedAt: "2026-11-25T10:00:00Z" });
  });
  const { page, errors } = await open();
  assert.equal(await page.locator("#cashCollectedReport table").count(), 0);
  assert.equal(await text(page.locator("#cashCollectedReport [role=status]")), "The cash total needs review. No partial or estimated amount is shown.");
  assert.deepEqual((await figures(page)).slice(0, 3).map((f) => f.split(" ")[0]), ["Unavailable", "Unavailable", "Unavailable"]);
  assert.equal(await page.getByRole("button", { name: "Export for accountant (CSV)" }).count(), 0);
  assert.deepEqual(errors, []);
});
