import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { publishInitialStoreCatalogue } from "../../lib/initial-store-catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Admin home (#377, canvas: Admin) at 1280 px:
// - five figures from the API, in the canvas's order: devices online, bundles
//   sold today, revenue today, store orders to prepare, router uptime (7 days);
// - Needs attention: the drawn three (payments waiting over 10 min, orders to
//   prepare, low stock), then the operational alerts (owner, 25 Nov), each a
//   link to where it is handled, or "Nothing needs attention right now.";
// - Latest payments: bundle payments, store orders and reseller cash handoffs
//   together ("Cash handoff": owner, 25 Nov), newest first.
// Local servers only, synthetic data, a fixed clock (16:30 in Douala).

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const now = new Date("2026-11-25T15:30:00Z"), ago = (minutes) => new Date(+now - minutes * 60000).toISOString();

async function start(t, seed) {
  const secret = "redesign-admin-home", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  await seed?.(store);
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await listen(apiServer, apiPort);
  t.after(async () => { await close(apiServer); await close(adminServer); });
  return { api, admin };
}

async function seedOperations(store) {
  await publishInitialStoreCatalogue({ store, now: () => now });
  await store.transaction((s) => {
    // 48 devices online (the router integration is off: online sessions are counted).
    for (let i = 0; i < 48; i++) s.sessions.push({ id: `sess-${i}`, voucherId: `v-${i}`, deviceId: `d-${i}`, label: "Phone", status: "online" });
    const bundle = (id, minutes, phone, network, status, extra = {}) => ({ id, status, amount: 1000, currency: "XAF", provider: "mesomb", network, payerPhone: phone,
      planId: "weekly", planSnapshot: { name: "Weekly" }, createdAt: ago(minutes),
      ...(status === "paid" ? { confirmedAt: ago(minutes - 1), providerReference: `ref-${id}` } : {}), ...extra });
    s.payments.push(bundle("p-wait-1", 12, "670001245", "mtn", "pending"), bundle("p-paid-1", 30, "670004019", "mtn", "paid"), bundle("p-wait-2", 95, "670007731", "orange", "pending"));
    // 22 more bundles sold today (23 with p-paid-1), one sold yesterday, one test payment.
    for (let i = 0; i < 22; i++) s.payments.push(bundle(`p-today-${i}`, 120 + i * 5, "670000300", i % 2 ? "orange" : "mtn", "paid"));
    s.payments.push(bundle("p-yesterday", 1000, "670000301", "mtn", "paid"), bundle("p-test", 60, "670000302", "mtn", "paid", { provider: "mock" }));
    // Two payment checks to review: an operational alert.
    s.payments.find((p) => p.id === "p-today-3").reconciliation = { status: "needs_review", issues: ["amount_mismatch"], checkedAt: ago(100) };
    s.payments.find((p) => p.id === "p-today-4").reconciliation = { status: "needs_review", issues: ["amount_mismatch"], checkedAt: ago(100) };
    s.adminUsers.push({ id: "r-kiosk", username: "kiosk", displayName: "Market kiosk", role: "reseller", active: true, passkeys: [],
      remittances: [{ id: "remit-1", amount: 20000, note: "", recordedBy: "owner", createdAt: ago(40) }] });
    // Router checks over the last week: 996 of 1000 reached the router.
    s.insightCounters = [{ id: "router:a", type: "router_hourly", at: ago(180), checks: 1000, reached: 996 },
      { id: "router:old", type: "router_hourly", at: ago(8 * 1440), checks: 50, reached: 0 }];
    const router = s.storeProducts.find((p) => p.name?.en === "TP-Link CPE210");
    const order = (id, minutes, phone, network) => s.storeOrders.unshift({ id, reference: `NS-${id.toUpperCase()}`, productId: router.id, product: { name: router.name }, quantity: 1,
      unitPrice: 30000, customerId: null, contact: { name: "Guest", phone }, status: "preparing", stockState: "sold", createdAt: ago(minutes), expiresAt: ago(minutes - 10), history: [],
      payment: { id: `store-${id}`, provider: "mesomb", amount: 30000, currency: "XAF", payerPhone: phone, network, status: "paid", providerReference: `ref-store-${id}`,
        createdAt: ago(minutes), confirmedAt: ago(minutes - 1) } });
    order("o3", 200, "670002210", "mtn"); order("o2", 150, "670002211", "orange"); order("o1", 20, "670008802", "orange");
  });
}

async function openHome(browser, { admin, api }, { lang = "en" } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1110 }, timezoneId: "Africa/Douala" });
  await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
  if (lang === "fr") await context.addInitScript(() => {
    const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
    new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] });
    set();
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${admin}/dashboard#home`);
  await page.locator("#homeAttention > *").first().waitFor();
  await page.locator("#homePayments > *").first().waitFor();
  return { page, context, errors };
}

test("Admin home shows the drawn figures, Needs attention and Latest payments from the API", { timeout: 240000 }, async (t) => {
  const servers = await start(t, seedOperations);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(() => browser.close());
  const screenshots = process.env.ADMIN_HOME_SCREENSHOTS || "/tmp/ndahi-admin-home";
  await mkdir(screenshots, { recursive: true });

  const { page, context, errors } = await openHome(browser, servers);
  assert.equal(await text(page.locator("#adminTitle")), "Your operations.");
  assert.deepEqual(await page.locator("#adminHeadActions [data-head-view=home]:visible").allInnerTexts(), ["Print vouchers", "Add product"]);
  // The five figures, in order. Labels are plain text, as drawn.
  const figures = page.locator(".admin-home__metrics .nd-metric");
  await page.waitForFunction(() => document.getElementById("homeOrdersMetric")?.textContent === "3");
  const pairs = [];
  for (let i = 0; i < await figures.count(); i++) pairs.push([await text(figures.nth(i).locator(".nd-metric__value")), await text(figures.nth(i).locator(".nd-metric__label"))]);
  // Revenue today: 23 bundles at 1,000 plus 3 orders at 30,000, all confirmed today; the test payment and yesterday's sale are not counted.
  assert.deepEqual(pairs, [["48", "Devices online now"], ["23", "Bundles sold today"], ["113,000 FCFA", "Revenue today"], ["3", "Store orders to prepare"], ["99.6%", "Router uptime, 7 days"]]);
  assert.equal(await page.locator(".admin-home__metrics a").count(), 0);
  // Needs attention: the drawn three, then the operational alert, each a link.
  const attention = page.locator("#homeAttention a");
  assert.deepEqual(await attention.evaluateAll((links) => links.map((a) => [a.innerText.replace(/\s+/g, " ").replace(" →", "").trim(), a.getAttribute("href"), a.className])), [
    ["2 payments waiting over 10 min", "/dashboard#payments", "admin-attention admin-attention--warning"],
    ["3 orders paid, not yet prepared", "/dashboard#store", "admin-attention admin-attention--info"],
    ["Wavlink AC1200: 2 left in stock", "/dashboard#products", "admin-attention admin-attention--neutral"],
    ["2 payment checks need review", "/dashboard#payments", "admin-attention admin-attention--warning"],
  ]);
  // Side menu counts, as drawn: payments waiting, orders to prepare.
  assert.equal(await text(page.locator("#admin-nav-payments")), "Payments 2");
  assert.equal(await text(page.locator("#admin-nav-store")), "Store orders 3");
  // Latest payments: every kind, newest first.
  const rows = page.locator("#homePayments tbody tr");
  assert.deepEqual(await rows.evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.trim()))), [
    ["6•• •• 12 45", "Bundle · Weekly", "MTN MoMo", "Waiting"],
    ["6•• •• 88 02", "Order · TP-Link CPE210", "Orange Money", "Paid"],
    ["6•• •• 40 19", "Bundle · Weekly", "MTN MoMo", "Paid"],
    ["Reseller · Market kiosk", "Cash handoff", "Cash", "Recorded"],
  ]);
  assert.deepEqual(await page.locator("#homePayments th").allInnerTexts(), ["Customer", "For", "Method", "Status"]);
  assert.equal(await page.locator(".admin-home__payments .admin-link").getAttribute("href"), "/dashboard#payments");
  // As drawn: both panels as tall as each other, 366 and 590 px wide at 1280.
  const boxes = await page.evaluate(() => [".admin-home__attention", ".admin-home__payments"].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  assert.deepEqual(boxes.map(([w]) => w), [366, 590]);
  assert.equal(boxes[0][1], boxes[1][1]);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("adminTitle")).fontSize), "38px");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/home-en.png`, fullPage: true });
  // Keyboard: after the head's buttons, Tab reaches Needs attention, and Enter opens where it leads.
  await page.locator("#adminHeadActions a[href$='#product/new']").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.innerText.replace(/\s+/g, " ").trim()), "2 payments waiting over 10 min →");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none", "the focused item shows a focus ring");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#payments");
  await page.locator("#panel-payments:not([hidden])").waitFor();
  // Another screen keeps the usual title size.
  await page.goto(`${servers.admin}/dashboard#customers`);
  await page.locator("#panel-customers:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("adminTitle")).fontSize), "36px");
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  const fr = await openHome(browser, servers, { lang: "fr" });
  await fr.page.waitForFunction(() => document.getElementById("homeOrdersMetric")?.textContent === "3");
  assert.equal(await text(fr.page.locator("#adminTitle")), "Vos opérations.");
  assert.deepEqual(await fr.page.locator(".admin-home__metrics .nd-metric__label").allInnerTexts(),
    ["Appareils connectés", "Forfaits vendus aujourd'hui", "Recettes du jour", "Commandes à préparer", "Disponibilité du routeur, 7 jours"]);
  assert.equal(await text(fr.page.locator("#routerUptimeMetric")), "99,6 %");
  assert.equal(await text(fr.page.locator("#revenueTodayMetric")), "113 000 FCFA");
  assert.deepEqual(await fr.page.locator("#homePayments tbody tr").nth(3).evaluate((tr) => [...tr.cells].map((td) => td.innerText.trim())),
    ["Revendeur · Market kiosk", "Remise d'espèces", "Espèces", "Enregistré"]);
  assert.equal(await text(fr.page.locator("#homePayments tbody tr").nth(1).locator("td").nth(1)), "Commande · TP-Link CPE210");
  await fr.page.mouse.move(0, 0);
  await fr.page.screenshot({ path: `${screenshots}/home-fr.png`, fullPage: true });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();
});

test("an empty Home says nothing needs attention and shows no uptime it has not measured", { timeout: 120000 }, async (t) => {
  const servers = await start(t);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(() => browser.close());
  const { page, errors } = await openHome(browser, servers);
  assert.equal(await text(page.locator("#homeAttention")), "Nothing needs attention right now.");
  assert.equal(await text(page.locator("#homePayments")), "No payments yet.");
  assert.equal(await text(page.locator("#routerUptimeMetric")), "—");
  assert.equal(await text(page.locator("#revenueTodayMetric")), "0 FCFA");
  assert.equal(await text(page.locator("#bundlesSoldTodayMetric")), "0");
  await page.screenshot({ path: `${process.env.ADMIN_HOME_SCREENSHOTS || "/tmp/ndahi-admin-home"}/home-empty-en.png`, fullPage: true });
  assert.deepEqual(errors, []);
});
