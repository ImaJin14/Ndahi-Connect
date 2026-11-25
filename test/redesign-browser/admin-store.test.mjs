import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { publishInitialStoreCatalogue } from "../../lib/initial-store-catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Store orders (#391, canvas: AdminStore) at 1280 px, with the owner's
// decisions of 25 Nov:
// - Open orders: paid, ready and payment-review orders, oldest first; a guest
//   by their masked number;
// - the order panel and its next step: Mark ready to collect, or the
//   collection code and Verify code and hand over;
// - Refund (owner only): the drawn confirmation, no reason field;
// - "Find an order" and "More order actions" stay, collapsed.
// Local servers only, synthetic data, a fixed clock (17:30 in Douala, 25 Nov).

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const now = new Date("2026-11-25T16:30:00Z");

test("Store orders lists the open orders and hands one over, as drawn", { timeout: 300000 }, async (t) => {
  const secret = "redesign-admin-store", store = createStore({ persistent: false });
  await publishInitialStoreCatalogue({ store, now: () => new Date("2026-11-08T08:00:00Z") });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] },
      { id: "u-operator", username: "brenda-op", displayName: "Brenda", role: "operator", active: true, passkeys: [] });
    for (const [user, token] of [["u-owner", "owner-token"], ["u-operator", "operator-token"]])
      s.adminSessions.push({ userId: user, role: user === "u-owner" ? "owner" : "operator", tokenHash: hashSecret(token, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.storeSettings = { ...s.storeSettings, open: true, contact: "NDAHI shop", pickup: "NDAHI shop, Market Road", warranty: { en: "12 months", fr: "12 mois" }, returns: { en: "14 days", fr: "14 jours" } };
    for (const p of s.storeProducts) p.price = 30000;
    s.customers.push({ id: "c-amina", name: "Amina N.", phone: "670001245", status: "active", createdAt: "2026-10-01T08:00:00Z" },
      { id: "c-fon", name: "J. Fon", phone: "690004417", status: "active", createdAt: "2026-10-01T08:00:00Z" });
    const product = (name) => s.storeProducts.find((p) => p.name.en === name);
    const order = (id, reference, name, at, status, contact, customerId, network, extra = {}) => {
      const p = product(name);
      return { id, reference, version: 2, productId: p.id, product: { name: p.name }, quantity: 1, unitPrice: 30000, customerId, contact, status,
        stockState: status === "review" ? "released" : "consumed", createdAt: at, expiresAt: at, history: [], pickup: "NDAHI shop, Market Road", hours: "9:00–18:00",
        collectionCode: "739204", payment: { id: "store-" + id, provider: "mesomb", providerReference: "ref-" + id, amount: 30000, currency: "XAF", status: "paid", network,
          payerPhone: contact.phone, createdAt: at, confirmedAt: at, fee: 600, total: 30600, ...(status === "review" ? { review: "late_payment" } : {}) }, ...extra };
    };
    s.storeOrders.unshift(
      order("o1", "NS-2611-0088", "TP-Link CPE210", "2026-11-08T09:00:00Z", "ready", { name: "Guest buyer", phone: "670008802" }, null, "mtn"),
      order("o2", "NS-2611-0091", "TP-Link AX1500 Travel Router", "2026-11-25T08:12:00Z", "preparing", { name: "Amina N.", phone: "670001245" }, "c-amina", "orange"),
      order("o3", "NS-2611-0092", "Wavlink Mini", "2026-11-25T10:40:00Z", "preparing", { name: "Guest", phone: "670005108" }, null, "mtn"),
      order("o4", "NS-2611-0094", "Wavlink AC1200", "2026-11-25T15:02:00Z", "preparing", { name: "J. Fon", phone: "690004417" }, "c-fon", "mtn"),
      order("o5", "NS-2611-0095", "Wavlink Mini", "2026-11-25T15:40:00Z", "review", { name: "Guest", phone: "670007700" }, null, "mtn"),
      order("o6", "NS-2611-0080", "Wavlink Mini", "2026-11-02T09:00:00Z", "collected", { name: "J. Fon", phone: "690004417" }, "c-fon", "mtn",
        { history: [{ action: "collect", actor: "owner", at: "2026-11-03T16:25:00Z" }] }),
    );
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
  const screenshots = process.env.ADMIN_STORE_SCREENSHOTS || "/tmp/ndahi-admin-store";
  await mkdir(screenshots, { recursive: true });
  const open = async ({ token = "owner-token", lang = "en", width = 1280 } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1110 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: token, url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
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
    await page.goto(`${admin}/dashboard#store`);
    await page.locator("#storeOrderRef").waitFor();
    return { page, context, errors };
  };
  const rows = (page, host = "#storeOrderRows") => page.locator(`${host} .admin-order`).evaluateAll((buttons) => buttons.map((b) => b.innerText.replace(/\s+/g, " ").trim()));
  const facts = (page) => page.locator(".admin-store__facts > div").evaluateAll((divs) => divs.map((d) => d.innerText.replace(/\s+/g, " ").trim()));

  const { page, context, errors } = await open();
  assert.equal(await text(page.locator("#adminEyebrow")), "STORE");
  assert.equal(await text(page.locator("#adminTitle")), "Orders to prepare and hand over.");
  assert.equal(await text(page.locator("#storeHeadOrders a")), "Products & stock");
  assert.equal(await page.locator("#storeHeadOrders a").getAttribute("href"), "/dashboard#products");
  // Paid, ready and payment review, oldest first; collected orders are not open.
  assert.deepEqual(await rows(page), [
    "NS-2611-0088 · TP-Link CPE210 Guest · 6•• •• 88 02 · 8 Nov Ready to collect",
    "NS-2611-0091 · TP-Link AX1500 Travel Router Amina N. · Today 09:12 Paid",
    "NS-2611-0092 · Wavlink Mini Guest · 6•• •• 51 08 · Today 11:40 Paid",
    "NS-2611-0094 · Wavlink AC1200 J. Fon · Today 16:02 Paid",
    "NS-2611-0095 · Wavlink Mini Guest · 6•• •• 77 00 · Today 16:40 Payment review",
  ]);
  // Pills toned as drawn: ready blue, paid orange; payment review red.
  assert.deepEqual(await page.locator("#storeOrderRows .nd-pill").evaluateAll((pills) => pills.map((p) => getComputedStyle(p).color)),
    ["rgb(29, 79, 134)", "rgb(107, 58, 0)", "rgb(107, 58, 0)", "rgb(107, 58, 0)", "rgb(138, 42, 42)"]);
  assert.equal(await page.locator("#storeOrderRows .admin-order").first().getAttribute("aria-pressed"), "true");
  assert.equal(await text(page.locator("#storeOrderRef")), "NS-2611-0088");
  assert.deepEqual(await facts(page), ["Item TP-Link CPE210 × 1", "Customer Guest · 6•• •• 88 02", "Paid 30,000 FCFA · MTN MoMo", "Collect at NDAHI shop, Market Road"]);
  assert.equal(await text(page.locator(".admin-store__label")), "Customer's collection code");
  assert.equal(await text(page.locator("#storeAskRefund")), "Refund (owner only)");
  // The kept tools are collapsed.
  assert.equal(await page.locator("#storeFinder").evaluate((d) => d.open), false);
  assert.equal(await page.locator("#storeOrderMore").evaluate((d) => d.open), false);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/store-en.png`, fullPage: true });

  // The drawn refund, by keyboard: the confirmation takes focus; Keep order gives it back.
  await page.locator("#storeAskRefund").focus();
  await page.keyboard.press("Enter");
  await page.locator(".admin-store__confirm[role=alertdialog]").waitFor();
  assert.equal(await text(page.locator("#storeRefundTitle")), "Refund the full amount to MTN MoMo?");
  assert.equal(await text(page.locator("#storeRefundNote")), "The order is cancelled and the device returns to stock. This can't be undone.");
  assert.equal(await page.locator(".admin-store__confirm input, .admin-store__confirm textarea").count(), 0, "no reason field, as drawn");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "storeKeepOrder");
  await page.keyboard.press("Enter");
  await page.locator("#storeAskRefund").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "storeAskRefund");

  // Hand over: the code as the customer shows it, with its space.
  await page.locator("#storeCollectionCode").fill("739 204");
  await page.locator("#collectOrder .admin-store__go").click();
  await page.locator(".admin-store__done").waitFor();
  assert.equal(await text(page.locator(".admin-store__done")), "Code verified. Handed over 25 Nov, 17:30 — logged to the audit trail.");
  assert.equal(await text(page.locator("#orderEditor .admin-store__detailhead .nd-pill")), "Collected");
  assert.equal((await rows(page))[0], "NS-2611-0088 · TP-Link CPE210 Guest · 6•• •• 88 02 · 8 Nov Collected", "it stays listed on this visit, as drawn");
  assert.equal(await page.locator("#storeAskRefund").count(), 0, "no drawn refund once handed over");
  assert.equal((await store.snapshot()).storeOrders.find((o) => o.id === "o1").status, "collected");

  // A paid order: Mark ready to collect.
  await page.locator("#storeOrderRows .admin-order").nth(1).click();
  assert.equal(await text(page.locator(".admin-store__hint")), "Test the device, pack it, then mark it ready. The customer sees it on their order page and by email if they gave one.");
  assert.deepEqual((await facts(page))[2], "Paid 30,000 FCFA · Orange Money");
  await page.getByRole("button", { name: "Mark ready to collect" }).click();
  await page.locator("#storeCollectionCode").waitFor();
  assert.equal(await text(page.locator("#orderEditor .admin-store__detailhead .nd-pill")), "Ready to collect");

  // Refund it: the drawn confirmation, then refunded at once with the drawn note.
  await page.locator("#storeAskRefund").click();
  await page.locator("#storeConfirmRefund").click();
  await page.locator(".admin-store__refunded").waitFor();
  assert.equal(await text(page.locator(".admin-store__refunded")), "Refund sent to Orange Money. Waiting for the provider to confirm; the device went back into stock.");
  assert.equal(await text(page.locator("#orderEditor .admin-store__detailhead .nd-pill")), "Refunded");
  const refunded = (await store.snapshot()).storeOrders.find((o) => o.id === "o2");
  assert.equal(refunded.payment.refund.reason, "Refunded before collection");
  assert.equal(refunded.payment.refund.restock, true);

  // Payment review: no drawn step; its refund (with a reason) is in More order actions.
  await page.locator("#storeOrderRows .admin-order").nth(4).click();
  assert.equal(await page.locator("#storeAskRefund, .admin-store__go").count(), 0);
  await page.locator("#storeOrderMore > summary").click();
  assert.equal(await page.locator("#refundOrder input[name=reason]").count(), 1);
  assert.equal(await page.locator("#refundOrder input[name=restock]").count(), 1);

  // Find an order: collected orders, by state.
  await page.locator("#storeFinder > summary").click();
  await page.locator("#storeOrderStatus").selectOption("collected");
  assert.deepEqual(await rows(page, "#storeFoundRows"), [
    "NS-2611-0088 · TP-Link CPE210 Guest · 6•• •• 88 02 · 8 Nov Collected",
    "NS-2611-0080 · Wavlink Mini J. Fon · 2 Nov Collected",
  ]);
  await page.locator("#storeFoundRows .admin-order").nth(1).click();
  assert.equal(await text(page.locator(".admin-store__done")), "Code verified. Handed over 3 Nov, 17:25 — logged to the audit trail.");
  assert.equal(await page.locator("#storeFinder").evaluate((d) => d.open), true);
  assert.deepEqual(errors, []);
  await context.close();

  // French: the same screen, amounts with the space.
  const fr = await open({ lang: "fr" });
  assert.equal(await text(fr.page.locator("#adminTitle")), "Commandes à préparer et à remettre.");
  assert.equal(await text(fr.page.locator("#storeOrdersTitle")), "Commandes ouvertes");
  assert.equal(await text(fr.page.locator("#storeHeadOrders a")), "Produits et stock");
  assert.deepEqual(await fr.page.locator("#storeOrderRows .nd-pill").allInnerTexts(), ["Remboursée", "Payée", "Payée", "Paiement à examiner"]);
  await fr.page.locator("#storeOrderRows .admin-order").nth(1).click();
  assert.deepEqual(await facts(fr.page), ["Article Wavlink Mini × 1", "Client Invité · 6•• •• 51 08", "Payé 30 000 FCFA · MTN MoMo", "Retrait à NDAHI shop, Market Road"]);
  assert.equal(await text(fr.page.getByRole("button", { name: "Marquer prête à retirer" })), "Marquer prête à retirer");
  await fr.page.mouse.move(0, 0);
  await fr.page.screenshot({ path: `${screenshots}/store-fr.png`, fullPage: true });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();

  // An operator prepares and hands over, but sees no refund.
  const operator = await open({ token: "operator-token" });
  await operator.page.locator("#storeOrderRows .admin-order").nth(1).click();
  assert.equal(await operator.page.getByRole("button", { name: "Mark ready to collect" }).count(), 1);
  assert.equal(await operator.page.locator("#storeAskRefund").count(), 0);
  assert.deepEqual(operator.errors, []);
  await operator.context.close();

  // Phones: no sideways scrolling.
  const phone = await open({ width: 390 });
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await lowContrastText(phone.page), []);
  await phone.context.close();
});
