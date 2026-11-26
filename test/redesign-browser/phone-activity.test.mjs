import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Activity on phones (canvas: PhoneActivity, #395): bundle payments, shop
// orders and the voucher codes the customer entered, newest first, each with
// its date and how it was paid ("Today · MTN MoMo", "5 Nov · MTN MoMo ·
// Receipt", "8 Nov · Orange Money", "29 Oct · K7PM-42XQ") and its status pill.
// The waiting banner opens the waiting payment; payments open in place (owner,
// 26 Nov); no rules link under the list. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("phone Activity lists payments, orders and entered codes as drawn", { timeout: 120000 }, async (t) => {
  const secret = "redesign-phone-activity", store = createStore({ persistent: false }), now = Date.now();
  const at = (iso) => new Date(iso).toISOString();
  const plan = { id: "weekly", name: "Weekly", price: 3000, validityHours: 168, quotaGb: null };
  const pay = (id, status, createdAt, network) => ({ id, customerId: "amina", status, amount: 3000, currency: "XAF", provider: "mesomb", network, providerReference: `${id}-ref`,
    payerPhone: "670001245", createdAt, ...(status === "paid" ? { confirmedAt: createdAt } : {}), planId: "weekly", planSnapshot: plan });
  const order = (id, ref, status, createdAt, name, network) => ({ id, reference: ref, customerId: "amina", productId: id, product: { name: { en: name, fr: name } }, quantity: 1, status,
    stockState: "consumed", createdAt, expiresAt: "2099-01-01T00:00:00.000Z", payment: { id: `${id}-p`, provider: "mesomb", network, status: "paid", amount: 38000, confirmedAt: createdAt },
    pickup: "Ndahi office", returns: { en: "", fr: "" }, hours: "", contact: {}, history: [] });
  const voucher = (id, code, activatedAt, extra = {}) => ({ id, code, planId: "weekly", customerId: "amina", status: "expired", createdAt: activatedAt, activatedAt,
    expiresAt: at("2026-12-31T10:00:00+01:00"), quotaBytes: null, usedBytes: 0, deviceLimit: 1, ...extra });
  await store.transaction((s) => {
    s.customers.push({ id: "amina", name: "Amina Ndi", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.payments.push(pay("pay-wait", "pending", new Date(now - 60000).toISOString(), "mtn"), pay("pay-paid", "paid", at("2026-11-05T10:00:00+01:00"), "mtn"));
    s.storeOrders ||= [];
    s.storeOrders.push(order("o-ready", "NS-2611-0088", "ready", at("2026-11-08T10:00:00+01:00"), "TP-Link CPE210", "orange"),
      order("o-done", "NS-2610-0061", "collected", at("2026-10-21T10:00:00+01:00"), "Wavlink Mini", "mtn"));
    s.vouchers.push(
      voucher("v-entered", "K7PM-42XQ", at("2026-10-29T10:00:00+01:00")),
      // Bought with the account's own payment: already its "Bundle" row.
      voucher("v-bought", "BUY1-2345", at("2026-11-05T10:05:00+01:00"), { paymentId: "pay-paid" }),
      // A store order's free month and a bulk gift from staff were never entered.
      voucher("v-bonus", "FREE-0001", at("2026-11-09T10:00:00+01:00"), { orderId: "o-ready" }),
      voucher("v-gift", "GIFT-0001", at("2026-11-02T10:00:00+01:00"), { giftBatchId: "batch-1" }));
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = process.env.PHONE_ACTIVITY_SCREENSHOTS || "/tmp/ndahi-phone-activity";
  await mkdir(screenshots, { recursive: true });

  const open = async (lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: lang === "fr" ? "fr-FR" : "en-GB" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/dashboard#activity`);
    await page.locator("#billing [data-order-row]").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  };
  // Each visible row as drawn: title, the line under it, and its status.
  const rows = (page) => page.locator("#billing .portal-activity__list > [data-activity-at]").evaluateAll((nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => [
    node.querySelector(".portal-activity__main strong").innerText, node.querySelector(".portal-activity__main .nd-meta").innerText, node.querySelector(".portal-activity__status .nd-pill").innerText]));

  let { context, page, errors } = await open();
  assert.deepEqual(await rows(page), [
    ["Bundle · Weekly", "Today · MTN MoMo", "Waiting"],
    ["Order · TP-Link CPE210", "8 Nov · Orange Money", "Ready to collect"],
    ["Bundle · Weekly", "5 Nov · MTN MoMo · Receipt", "Paid"],
    ["Voucher redeemed", "29 Oct · K7PM-42XQ", "Used"],
    ["Order · Wavlink Mini", "21 Oct · MTN MoMo", "Collected"],
  ]);
  assert.equal(await page.locator('#billing [data-voucher-row="v-entered"]').getAttribute("href"), "/dashboard#vouchers");
  // No rules link under the list.
  assert.equal(await page.locator('#billing a[href="/billing-terms.html"]').count(), 0);
  // The banner, as drawn, opens the waiting payment's status check in place.
  const banner = page.locator(".portal-activity__waiting");
  assert.equal((await banner.innerText()).replace(/\s+/g, " ").trim(), "1 payment waiting. Approve it on your phone, then tap here to check.");
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await page.screenshot({ path: `${screenshots}/activity-390.png`, fullPage: true });
  await banner.click();
  await page.locator('#billing details[data-payment-row="pay-wait"][open]').waitFor();
  await page.locator('#billing details[data-payment-row="pay-wait"]').getByRole("button", { name: "Check payment status" }).waitFor();
  // Filters.
  await page.locator('button[data-activity-filter="orders"]').click();
  assert.deepEqual((await rows(page)).map(([title]) => title), ["Order · TP-Link CPE210", "Order · Wavlink Mini"]);
  await page.locator('button[data-activity-filter="internet"]').click();
  assert.deepEqual((await rows(page)).map(([title]) => title), ["Bundle · Weekly", "Bundle · Weekly", "Voucher redeemed"]);
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  ({ context, page, errors } = await open("fr"));
  const fr = await rows(page);
  assert.deepEqual(fr[0].slice(1), ["Aujourd'hui · MTN MoMo", "En attente"]);
  assert.deepEqual(fr[3], ["Ticket utilisé", "29 oct. · K7PM-42XQ", "Utilisé"]);
  await page.screenshot({ path: `${screenshots}/activity-390-fr.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});
