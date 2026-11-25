import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { publishInitialStoreCatalogue } from "../../lib/initial-store-catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Admin payments (#386, canvas: AdminPayments) at 1280 px:
// - the four figures from the dashboard: today's bundle and store takings (the
//   cash report's basis), payments waiting over 10 min, payments failed today;
// - All payments: bundle payments, store orders and reseller cash handoffs in
//   one list, searched by phone, order or reference and filtered by the drawn
//   chips (Paid includes recorded cash);
// - "Check with provider" checks that payment only: a bundle payment through
//   the payment check, a store order through the store's check of that order;
// - kept by the owner (25 Nov): refund actions, the provider reference, paging
//   and the Provider checks section.
// Local servers only, synthetic data, a fixed clock (17:30 in Douala).

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const now = new Date("2026-11-25T16:30:00Z"), ago = (minutes) => new Date(+now - minutes * 60000).toISOString();

test("Payments lists every kind of payment with the drawn figures, chips, search and checks", { timeout: 300000 }, async (t) => {
  const secret = "redesign-admin-payments", store = createStore({ persistent: false });
  await publishInitialStoreCatalogue({ store, now: () => now });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] },
      { id: "r-kiosk", username: "kiosk", displayName: "Market kiosk", role: "reseller", active: true, passkeys: [],
        remittances: [{ id: "remit-1", amount: 20000, note: "", recordedBy: "owner", createdAt: ago(180) }] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    const bundle = (id, minutes, phone, network, status, plan, extra = {}) => ({ id, status, amount: 1000, currency: "XAF", provider: "mesomb", network, payerPhone: phone,
      planId: "weekly", planSnapshot: { name: plan }, createdAt: ago(minutes), ...extra });
    s.payments.push(
      bundle("p-wait", 12, "670001245", "mtn", "pending", "Weekly"),
      bundle("p-wait-new", 3, "670007731", "orange", "pending", "Daily"),
      bundle("p-paid", 55, "670004019", "mtn", "paid", "Monthly", { amount: 3000, confirmedAt: ago(54), providerReference: "MP-PAID-77" }),
      bundle("p-failed", 133, "670000366", "orange", "failed", "Weekly"),
      bundle("p-expired", 1500, "670000366", "mtn", "expired", "Weekly"),
    );
    // 30 older paid payments, so the list has a second page.
    for (let i = 0; i < 30; i++) s.payments.push(bundle(`p-old-${i}`, 3000 + i, "670009000", "mtn", "paid", "Weekly", { confirmedAt: ago(2999 + i), providerReference: `MP-OLD-${i}` }));
    // A payment check to review: the Provider checks section lists it.
    s.payments.find((p) => p.id === "p-old-0").reconciliation = { status: "needs_review", issues: ["amount_mismatch"], checkedAt: ago(100) };
    const router = s.storeProducts.find((p) => p.name?.en === "TP-Link CPE210");
    const order = (id, minutes, phone, status, extra = {}) => s.storeOrders.unshift({ id, reference: `NS-${id.toUpperCase()}`, version: 4, productId: router.id, product: { name: router.name },
      quantity: 1, unitPrice: 30000, customerId: null, contact: { name: "Guest", phone }, status: status === "paid" ? "preparing" : "awaiting_payment", stockState: "reserved",
      createdAt: ago(minutes), expiresAt: ago(minutes - 10), history: [],
      payment: { id: `store-${id}`, provider: "mesomb", amount: 30000, currency: "XAF", payerPhone: phone, network: "mtn", status, createdAt: ago(minutes), ...extra } });
    order("2611ab01", 40, "670008802", "paid", { confirmedAt: ago(39), providerReference: "MP-STORE-1" });
    // An unpaid order expires 10 minutes after it is placed, so a waiting one is recent.
    order("2611ab02", 5, "670008803", "pending", {});
    s.storeOrders.find((o) => o.id === "2611ab02").customerId = "c-account";
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
  const screenshots = process.env.ADMIN_PAYMENTS_SCREENSHOTS || "/tmp/ndahi-admin-payments";
  await mkdir(screenshots, { recursive: true });

  const open = async ({ lang = "en", width = 1280 } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1110 }, timezoneId: "Africa/Douala" });
    // The checks are stood in for here: this test is about what each button asks for.
    const checks = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === api && route.request().method() === "POST" && ["/api/admin/payments/verify", "/api/admin/store/orders/update"].includes(url.pathname)) {
        checks.push([url.pathname, JSON.parse(route.request().postData() || "{}")]);
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      return [api, admin].includes(url.origin) ? route.continue() : route.abort("blockedbyclient");
    });
    await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
    // The page's own clock decides which times are "today"; it matches the server's.
    await context.clock.setFixedTime(now);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] });
      set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${admin}/dashboard#payments`);
    await page.locator("#paymentRecords tbody tr td:nth-child(2)").first().waitFor();
    return { page, context, errors, checks };
  };
  const rows = (page) => page.locator("#paymentRecords tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].slice(0, 6).map((td) => td.innerText.replace(/\s+/g, " ").trim())));
  const settle = (page, count) => page.waitForFunction((n) => !document.querySelector("#paymentRecords[aria-busy=true]") && document.querySelectorAll("#paymentRecords tbody tr").length === n, count);

  const { page, context, errors, checks } = await open();
  assert.equal(await text(page.locator("#adminTitle")), "Payments and revenue.");
  assert.equal(await page.locator("#adminHeadActions [data-payments-export]").isVisible(), true);
  // Today's takings on the cash report's basis: one bundle (3,000) and one order (30,000) confirmed today.
  assert.deepEqual(await page.locator(".admin-payments__metrics .nd-metric").evaluateAll((tiles) => tiles.map((tile) => tile.innerText.replace(/\s+/g, " ").trim())),
    ["3,000 FCFA Today, bundles", "30,000 FCFA Today, store", "1 Waiting over 10 min", "1 Failed today"]);
  const search = page.getByRole("searchbox", { name: "Search payments", exact: true });
  assert.equal(await search.getAttribute("placeholder"), "Search phone, order or reference");
  // Every kind, newest first: 25 a page, 38 in all.
  assert.deepEqual((await rows(page)).slice(0, 8), [
    ["17:27", "6•• •• 77 31", "Bundle · Daily", "Orange Money", "1,000 FCFA", "Waiting"],
    ["17:25", "6•• •• 88 03", "Order NS-2611AB02", "MTN MoMo", "30,000 FCFA", "Waiting"],
    ["17:18", "6•• •• 12 45", "Bundle · Weekly", "MTN MoMo", "1,000 FCFA", "Waiting"],
    ["16:50", "Guest · 6•• •• 88 02", "Order NS-2611AB01 MP-STORE-1", "MTN MoMo", "30,000 FCFA", "Paid"],
    ["16:35", "6•• •• 40 19", "Bundle · Monthly MP-PAID-77", "MTN MoMo", "3,000 FCFA", "Paid"],
    ["15:17", "6•• •• 03 66", "Bundle · Weekly", "Orange Money", "1,000 FCFA", "Failed"],
    ["14:30", "Reseller · Market kiosk", "Cash handoff", "Cash", "20,000 FCFA", "Recorded"],
    ["24 Nov, 16:30", "6•• •• 03 66", "Bundle · Weekly", "MTN MoMo", "1,000 FCFA", "Expired"],
  ]);
  assert.equal(await text(page.locator("#paymentRecords .records-pager span")), "Page 1 of 2 · 38 total");
  // Recorded cash is the kit's grey pill here, as drawn.
  assert.equal(await page.locator("#paymentRecords tbody tr").nth(6).locator(".nd-pill").getAttribute("class"), "nd-pill");
  // Checks: on waiting, failed and expired bundle payments and the unconfirmed order; never on recorded cash.
  const buttons = await page.locator("#paymentRecords tbody tr").evaluateAll((trs) => trs.slice(0, 8).map((tr) => [...tr.querySelectorAll("button")].map((b) => b.innerText.trim()).join(" | ")));
  assert.deepEqual(buttons, ["Check with provider", "Check with provider", "Check with provider", "", "Approve full refund", "Check with provider", "", "Check with provider"]);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/payments-en.png`, fullPage: true });
  // The Provider checks section stays below the list (owner, 25 Nov).
  assert.match(await text(page.locator("section[aria-labelledby=paymentChecksTitle]")), /Payment checks[\s\S]*amount mismatch/);

  // "Check with provider" asks about that payment only, by keyboard too.
  const checked = async (count) => { for (let i = 0; i < 100 && checks.length < count; i++) await page.waitForTimeout(50); await page.locator("#paymentRecords tbody tr td:nth-child(2)").first().waitFor(); };
  await page.locator("#paymentRecords tbody tr").nth(0).getByRole("button", { name: "Check with provider" }).focus();
  await page.keyboard.press("Enter");
  await checked(1);
  await page.locator("#paymentRecords tbody tr").nth(1).getByRole("button", { name: "Check with provider" }).click();
  await checked(2);
  assert.deepEqual(checks, [["/api/admin/payments/verify", { paymentId: "p-wait-new" }], ["/api/admin/store/orders/update", { id: "2611ab02", version: 4, action: "verify" }]]);

  // Chips, as drawn: Paid includes recorded cash; Failed includes expired.
  const chip = (name) => page.locator("#paymentRecords .nd-chip").filter({ hasText: new RegExp(`^${name}$`) });
  await chip("Waiting").click(); await settle(page, 3);
  assert.deepEqual((await rows(page)).map((r) => r[2]), ["Bundle · Daily", "Order NS-2611AB02", "Bundle · Weekly"]);
  assert.equal(await chip("Waiting").getAttribute("aria-pressed"), "true");
  await chip("Failed").click(); await settle(page, 2);
  assert.deepEqual((await rows(page)).map((r) => r[5]), ["Failed", "Expired"]);
  await chip("Paid").click(); await settle(page, 25);
  assert.equal((await rows(page)).filter((r) => r[5] === "Recorded").length, 1);
  await chip("All").click(); await settle(page, 25);
  // Search: phone, order or reference.
  for (const [query, expected] of [["NS-2611AB01", ["Order NS-2611AB01 MP-STORE-1"]], ["MP-PAID-77", ["Bundle · Monthly MP-PAID-77"]], ["1245", ["Bundle · Weekly"]]]) {
    await search.fill(query); await settle(page, expected.length);
    assert.deepEqual((await rows(page)).map((r) => r[2]), expected, query);
  }
  await search.fill(""); await settle(page, 25);
  // Paging, kept by the owner.
  await page.locator('#paymentRecords [data-page="next"]').click(); await settle(page, 13);
  assert.equal(await text(page.locator("#paymentRecords .records-pager span")), "Page 2 of 2 · 38 total");
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  const fr = await open({ lang: "fr" });
  assert.equal(await text(fr.page.locator("#adminTitle")), "Paiements et revenus.");
  assert.equal(await fr.page.getByRole("searchbox", { name: "Rechercher des paiements" }).getAttribute("placeholder"), "Rechercher un téléphone, une commande ou une référence");
  const frRows = await rows(fr.page);
  assert.deepEqual(frRows[3].slice(1, 3), ["Invité · 6•• •• 88 02", "Commande NS-2611AB01 MP-STORE-1"]);
  assert.deepEqual(frRows[6].slice(1, 6), ["Revendeur · Market kiosk", "Remise d'espèces", "Espèces", "20 000 FCFA", "Enregistré"]);
  await fr.page.mouse.move(0, 0);
  await fr.page.screenshot({ path: `${screenshots}/payments-fr.png`, fullPage: true });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();

  // Phones: the list becomes cards, with no sideways scrolling.
  const phone = await open({ width: 390 });
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await lowContrastText(phone.page), []);
  assert.deepEqual(phone.errors, []);
  await phone.context.close();
});
