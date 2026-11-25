import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { adminGenerateName, adminLinkName, adminMoreCount, openAdminMore, uiV2, adminIdentifierLabel } from "./admin-nav.mjs";
import { lowContrastText } from "./ui-checks.mjs";

const apiPort = Number(process.env.ADMIN_JOURNEY_API_PORT || 8998), adminPort = Number(process.env.ADMIN_JOURNEY_PORT || 8997);
const api = `http://127.0.0.1:${apiPort}`, admin = `http://127.0.0.1:${adminPort}`, origins = new Set([api, admin]);
const store = createStore({ persistent: false }), secret = randomUUID(), tokens = Object.fromEntries(["owner", "operator", "auditor", "reseller"].map((r) => [r, randomUUID()]));
let now = new Date("2030-01-01T08:00:00Z"), devices, failRead = false, readGate, disconnectGate, readCalls = 0;
const observed = [{ mac: "AA:BB:CC:DD:EE:01", sessionId: "*A", startedAt: "2030-01-01T07:55:00.000Z", address: "10.20.0.2" },
  { mac: "AA:BB:CC:DD:EE:02", sessionId: "*B", startedAt: "2030-01-01T07:55:00.000Z", address: "10.20.0.3" }];
const server = createServer({ store, now: () => now, validateConfig: false, router: {
  readUsage: async () => { readCalls++; if (readGate) await readGate; if (failRead) throw Error("Fixture router unavailable"); return [{ voucherId: "v1", usedBytes: 0, devices }]; },
  disconnectWifiDevice: async (target) => { if (disconnectGate) await disconnectGate; devices = devices.filter((d) => d.sessionId !== target.sessionId); return { confirmed: true, outcome: "disconnected" }; },
}, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "live", OMADA_MODE: "not-configured", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "true", NETWORK_QUEUE_MAX_ATTEMPTS: "1", NETWORK_USAGE_SYNC_SECONDS: "0", NETWORK_QUEUE_INTERVAL_SECONDS: "3600", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin } });
const website = createStaticServer("admin", { apiUrl: api });
const listen = (app, port) => new Promise((r) => app.listen(port, "127.0.0.1", r));
const close = (app) => new Promise((r) => { app.close(r); app.closeAllConnections(); });
const screenshots = "/tmp/ndahi-admin-app-checks";
let browser, checks = 0;
// v2 Live devices (#381) has no Refresh button: the router is read on its own.
// The journeys ask for a reading through the same API the button used.
const requestReading = (page) => page.evaluate(async (base) => {
  const { csrfToken } = await (await fetch(base + "/api/admin/dashboard", { credentials: "include" })).json();
  return (await fetch(base + "/api/admin/wifi-devices/refresh", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: "{}" })).status;
}, api);
// v2: one row per customer; its devices are in the pop-up.
const openLiveDevices = async (page) => {
  await page.locator("#liveDeviceRows .admin-devices__view").first().click();
  await page.locator("#liveDeviceDialog[open]").waitFor();
};
await store.transaction((s) => {
  s.customers.push({ id: "c1", name: "Fixture customer", phone: "670042001" });
  s.vouchers.push({ id: "v1", customerId: "c1", assignedResellerId: "staff-reseller", code: "NC-FIXTURE", planId: "weekly", status: "active", quotaBytes: null, usedBytes: 0, expiresAt: "2030-01-02T08:00:00Z", deviceLimit: 2, wifiDevices: observed, wifiDevicesAt: now.toISOString() });
  s.routerCommands.push({ id: "router:disconnect_device:legacy-uuid", kind: "router_command", action: "disconnect_device", targetId: "legacy-uuid", status: "dead_letter", attempts: 1, totalAttempts: 49, lastError: "Legacy device disconnection needs a fresh router session mapping.", at: now.toISOString() });
  for (const [role, token] of Object.entries(tokens)) {
    s.adminUsers.push({ id: `staff-${role}`, username: `fixture-${role}`, role, active: true, passkeys: [] });
    s.adminSessions.push({ userId: `staff-${role}`, tokenHash: hashSecret(token, secret), role, csrfToken: randomUUID(), expiresAt: "2030-01-02T08:00:00Z" });
  }
});
const baseline = await store.snapshot();
try {
  await listen(server, apiPort); await listen(website, adminPort); await mkdir(screenshots, { recursive: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function scenario(name, work, { width = 390, role = "owner", apple = false } = {}) {
    if (process.env.ADMIN_APP_CASE && !new RegExp(process.env.ADMIN_APP_CASE).test(name)) return;
    now = new Date("2030-01-01T08:00:00Z"); devices = structuredClone(observed); failRead = false; readGate = disconnectGate = undefined; readCalls = 0;
    await store.transaction((s) => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width, height: 900 }, ...(apple ? { userAgent: "Mozilla/5.0 (iPad; CPU OS 15_8 like Mac OS X) AppleWebKit/605.1.15 Version/15.0 Mobile/15E148 Safari/604.1" } : {}) });
    await context.route("**/*", (route) => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: tokens[role], url: api, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000); page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    try { await work(page, context); assert.deepEqual(errors, []); console.log(`PASS ${name}`); checks++; }
    catch (e) { await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true }).catch(() => {}); throw e; }
    finally { await context.close(); }
  }
  // Redesigned admin Home (v2 only; canvas: Admin).
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned admin Home shows metrics, Needs attention and latest payments at ${width}px`, async (page) => {
    await page.goto(`${admin}/dashboard#home`);
    await page.getByRole("heading", { name: "Your operations.", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Needs attention", exact: true }).waitFor();
    await page.locator("#homeAttention > *").first().waitFor();
    assert.equal(await page.locator("#activeSessionsMetric").textContent(), "2");
    await page.getByRole("heading", { name: "Latest payments", exact: true }).waitFor();
    await page.getByRole("link", { name: "Print vouchers", exact: true }).waitFor();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/home-${width}.png`, fullPage: true });
    await page.getByRole("link", { name: adminLinkName("Payments"), exact: true }).click();
    await page.locator('[data-admin-nav="payments"][aria-current]').waitFor();
    assert.equal(await page.getByRole("link", { name: "Print vouchers", exact: true }).count(), 0, "head actions belong to Home");
  }, { width });
  if (uiV2) await scenario("optional Home discovery failure keeps an authenticated dashboard open", async (page) => {
    await page.route("**/api/admin/home", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture Home unavailable" }) }));
    const discovery = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/home");
    await page.goto(`${admin}/dashboard#home`);
    assert.equal((await discovery).status(), 503);
    await page.waitForLoadState("networkidle");
    assert.equal(new URL(page.url()).pathname, "/dashboard");
    await page.locator('[data-admin-nav="home"][aria-current]').waitFor();
  });
  // Redesigned Payments and Cash (v2 only; canvas: AdminPayments, AdminCash).
  // "Today" is read on the server (Africa/Douala; #377, #386), so these payments are
  // dated from the API's clock, and the page's clock is set to match.
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Payments and Cash show today's figures, filters and exports at ${width}px`, async (page) => {
    await page.clock.setFixedTime(now);
    const real = +now, today = Math.floor((real + 3600000) / 864e5) * 864e5 - 3600000, at = (ms) => new Date(ms).toISOString();
    const recent = Math.max(today + 1000, real - 60000);
    const payment = (id, status, createdAt, amount, extra = {}) => ({ id, status, createdAt: at(createdAt), amount, currency: "XAF", provider: "mesomb", network: "mtn",
      payerPhone: "670042011", providerReference: `REF-${id.toUpperCase()}`, planId: "weekly", planSnapshot: { id: "weekly", name: "Weekly", price: amount }, ...extra });
    await store.transaction((s) => {
      s.payments.unshift(
        payment("paid", "paid", recent, 3000, { confirmedAt: at(recent) }),
        payment("failed", "failed", recent - 1, 1000),
        payment("waitnew", "pending", recent - 2, 1000),
        payment("waitold", "pending", real - 20 * 60000, 1000),
        payment("paidold", "paid", today - 3 * 3600000, 250, { confirmedAt: at(today - 3 * 3600000) }),
      );
    });
    await page.goto(`${admin}/dashboard#payments`);
    await page.getByRole("heading", { name: "Payments and revenue.", exact: true }).waitFor();
    await page.waitForFunction(() => document.getElementById("paymentsTodayBundles").textContent !== "—");
    assert.deepEqual(await page.locator("#paymentsTodayBundles, #paymentsTodayStore, #paymentsWaiting, #paymentsFailedToday").allTextContents(), ["3,000 FCFA", "0 FCFA", "1", "1"]);
    const rows = page.locator("#paymentRecords tbody tr");
    await page.getByRole("heading", { name: "All payments", exact: true }).waitFor();
    await rows.filter({ hasText: "REF-PAIDOLD" }).waitFor();
    assert.equal(await rows.count(), 5);
    await page.getByRole("button", { name: "Waiting", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("#paymentRecords tbody tr").length === 2);
    assert.equal(await page.getByRole("button", { name: "Waiting", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await rows.getByRole("button", { name: "Check with provider", exact: true }).count(), 2);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search payments", exact: true }).fill("REF-PAIDOLD");
    await page.waitForFunction(() => document.querySelectorAll("#paymentRecords tbody tr").length === 1);
    await rows.getByRole("button", { name: "Approve full refund", exact: true }).waitFor();
    const csv = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV", exact: true }).click();
    assert.equal((await csv).suggestedFilename(), "ndahi-report.csv");
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/payments-${width}.png`, fullPage: true });

    await page.locator("#admin-nav-cash").click();
    await page.getByRole("heading", { name: "Cash and settlements.", exact: true }).waitFor();
    // Cash and settlements (#379): the last 7 days, then the per-network table.
    await page.getByRole("heading", { name: "Net provider settlements", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Export CSV", exact: true }).count(), 0, "head actions belong to Payments");
    assert.equal(await page.getByRole("button", { name: "7 days", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#cashCollectedReport tbody tr").count(), 2);
    assert.equal(await page.locator("#settlementReport").count(), 0, "the gateway's own settlement report stays apart (#191)");
    assert.match(await page.locator("#panel-cash").innerText(), /3,250 FCFA\s*Internet payments, last 7 days/);
    const cash = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export for accountant (CSV)", exact: true }).click();
    assert.equal((await cash).suggestedFilename(), "ndahi-settlements-week.csv");
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/cash-${width}.png`, fullPage: true });
  }, { width });
  // Redesigned Vouchers and batch printing (v2 only; canvas: AdminVouchers, AdminVoucherPrint).
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Vouchers creates a batch and prints it on its own screen at ${width}px`, async (page) => {
    await page.goto(`${admin}/dashboard#vouchers`);
    await page.getByRole("heading", { name: "Your vouchers.", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Batch to print or sell", exact: true }).click();
    await page.getByRole("heading", { name: "Create a batch", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Recent vouchers", exact: true }).waitFor();
    await page.locator('[data-voucher-record="v1"]').waitFor();
    assert.equal(await page.locator('[data-voucher-record="v1"] .nd-pill').textContent(), "In use");
    assert.equal(await page.locator("#voucherOptions").evaluate((details) => details.open), false, "purpose and sale type wait under More options");
    await page.getByLabel("How many", { exact: true }).fill("3");
    await page.getByRole("button", { name: "Create 3 vouchers", exact: true }).click();
    await page.getByText("3 vouchers generated", { exact: true }).waitFor();
    assert.equal(await page.locator("#generated .generated-codes code").count(), 3);
    await page.locator('#voucherRecords tbody tr[data-voucher-record]').nth(3).waitFor();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/vouchers-${width}.png`, fullPage: true });

    await page.getByRole("link", { name: "Print slips", exact: true }).click();
    // A batch is named by its reference (canvas: AdminVoucherPrint, #392).
    await page.getByRole("heading", { name: /^Print batch B-\d{4}-\d{2}$/ }).waitFor();
    assert.match(await page.locator("#adminLede").textContent(), /^3 slips · .* · 58 mm thermal slips$/);
    assert.equal(await page.locator("#voucherPrintSurface .thermal-slip").count(), 3);
    await page.getByRole("button", { name: "Print 3 slips", exact: true }).waitFor();
    assert.equal(await page.locator("#adminEyebrow").isVisible(), false, "the back link replaces the eyebrow");
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/voucher-print-${width}.png`, fullPage: false });
    await page.getByRole("link", { name: "Back to Vouchers", exact: true }).click();
    await page.getByRole("heading", { name: "Your vouchers.", exact: true }).waitFor();
    assert.equal(await page.locator("#voucherPrintSurface").count(), 0, "slips leave the page with their screen");
    assert.equal(await page.evaluate(() => document.body.dataset.voucherPrintLayout || ""), "");
    // A reload forgets the batch, so its print screen falls back to Vouchers.
    await page.evaluate(() => { location.hash = "voucher-print"; });
    await page.getByRole("heading", { name: /^Print batch B-\d{4}-\d{2}$/ }).waitFor();
    await page.reload();
    await page.waitForFunction(() => location.hash === "#vouchers");
    await page.getByRole("heading", { name: "Your vouchers.", exact: true }).waitFor();
  }, { width });
  // Redesigned Customers and customer detail (v2 only; canvas: AdminCustomers, AdminCustomerDetail).
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Customers lists bundles and opens a customer's detail at ${width}px`, async (page) => {
    const { routerRevision } = await import("../lib/device-identities.mjs"), { seedCatalogue } = await import("../lib/catalogue.mjs");
    await store.transaction((s) => {
      delete s.catalogue; seedCatalogue(s, now);
      s.customers.push({ id: "c-unlimited", name: "Unlimited customer", phone: "670042077", status: "active", createdAt: "2029-12-01T08:00:00Z" });
      s.vouchers.unshift({ id: "v-unlimited", customerId: "c-unlimited", code: "NC-UNLI-0001", planId: "unlimited-7d-2", status: "active", activatedAt: "2029-12-28T08:00:00Z",
        expiresAt: new Date(+now + (2 * 24 + 14) * 36e5).toISOString(), quotaBytes: null, usedBytes: 0, deviceLimit: 2, accessType: "personal_unlimited", deviceSlots: 2, sharing: false });
      s.wifiDeviceGrants.push({ id: "g-unl", customerId: "c-unlimited", mac: "AA:BB:CC:00:00:77", voucherId: "v-unlimited", status: "approved", routerRevision: routerRevision(s) });
    });
    await page.goto(`${admin}/dashboard#customers`);
    await page.getByRole("heading", { name: "Your customers.", exact: true }).waitFor();
    const row = page.locator("#customerRecords tbody tr").filter({ hasText: "Fixture customer" });
    await row.waitFor();
    // Name, masked phone, bundle (unlimited shows data used), last active,
    // devices, state, actions (#256, canvas: AdminCustomers).
    // The first cell is the selection box (#257).
    const cells = (await row.locator("td").allInnerTexts()).map((text) => text.trim()).slice(1);
    assert.deepEqual([cells[0], cells[1], cells[2], cells[4], cells[5], cells[6]], ["Fixture customer", "6•• •• 20 01", "Weekly · 0 GB used", "2 / 2", "Active", "Suspend"]);
    assert.match(cells[3], /^(Online now|Today|Yesterday|—|\d{1,2} [A-Z][a-z]{2})$/);
    // An Unlimited bundle shows time left and device slots used / slots (#342);
    // the Weekly bundle above keeps its own terms (data, its device limit).
    const unlimited = page.locator("#customerRecords tbody tr").filter({ hasText: "Unlimited customer" });
    const unlimitedCells = (await unlimited.locator("td").allInnerTexts()).map((text) => text.trim()).slice(1);
    assert.deepEqual([unlimitedCells[2], unlimitedCells[4]], ["Personal Unlimited · 2 d 14 h left", "1 / 2"]);
    await page.getByRole("searchbox", { name: "Search customers", exact: true }).fill("nobody-here");
    await page.locator("#customerRecords tbody").getByText("No matching customers.", { exact: true }).waitFor();
    await page.getByRole("searchbox", { name: "Search customers", exact: true }).fill("670042001");
    await row.waitFor();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/customers-${width}.png`, fullPage: true });

    await row.getByRole("link", { name: "Fixture customer", exact: true }).click();
    await page.getByRole("heading", { name: "Fixture customer", exact: true }).waitFor();
    assert.equal(await page.locator("#adminAvatar").textContent(), "F");
    assert.match(await page.locator("#adminLede").textContent(), /^\+237 670 04 20 01/);
    await page.getByRole("link", { name: "Back to Customers", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Support actions", exact: true }).waitFor();
    for (const name of ["Print active voucher", "Recover PIN with a support code", "Give a voucher (sold or gift)", "Suspend customer"]) await page.getByRole("button", { name, exact: true }).waitFor();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    await page.screenshot({ path: `${screenshots}/customer-${width}.png`, fullPage: true });
    await page.getByRole("tab", { name: "Devices", exact: true }).click();
    await page.getByRole("tabpanel", { name: "Devices" }).getByText("AA:BB:CC:DD:EE:01", { exact: false }).waitFor();
    await page.getByRole("tab", { name: "Devices", exact: true }).press("ArrowRight");
    assert.equal(await page.getByRole("tab", { name: "Overview", exact: true }).getAttribute("aria-selected"), "true", "arrow keys move between tabs");
    await page.getByRole("tab", { name: "Payments & orders", exact: true }).click();
    await page.getByText("No payments or store orders yet.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Give a voucher opens the customer mode without consenting to replacement.
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Give a voucher (sold or gift)", exact: true }).click();
    await page.getByRole("heading", { name: "Your vouchers.", exact: true }).waitFor();
    await page.locator(".customer-voucher__picked").waitFor();
    assert.equal(await page.locator('#customerVoucherForm [name="replaceActive"]').isChecked(), false);
    assert.equal(await page.locator("[data-give-submit]").isDisabled(), true);
  }, { width });
  // Redesigned Bundles (v2 only; canvas: AdminBundles, #338): the catalogue from the API.
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Bundles shows the catalogue, reorders, publishes and removes at ${width}px`, async (page) => {
    // The reset keeps settings the baseline lacks; start from an unseeded catalogue.
    await store.transaction((s) => { delete s.catalogue; });
    await page.goto(`${admin}/dashboard#bundles`);
    await page.getByRole("heading", { name: "Bundle catalogue.", exact: true }).waitFor();
    assert.equal(await page.locator("#adminEyebrow").textContent(), "Sales · catalogue managers only");
    const grid = page.getByRole("table", { name: "Personal Unlimited prices in FCFA by validity and device slots" });
    await grid.waitFor();
    assert.equal(await grid.getByRole("link", { name: "Personal Unlimited 7 days, 2 devices: 4,000 XAF, published" }).count(), 1);
    assert.equal(await grid.getByRole("link", { name: "Not offered: create Personal Unlimited 5 hours for 2 devices" }).getAttribute("href"),
      "/dashboard#bundle/new?accessType=personal_unlimited&validityValue=5&validityUnit=hours&deviceSlots=2");
    assert.match(await page.locator("[data-home]").innerText(), /30 days[\s\S]*0 active subscriptions[\s\S]*50,000[\s\S]*Published/);
    // The earlier plans are read-only rows until the switch (owner, #338).
    const weekly = page.locator('[data-cat-row="weekly"]');
    assert.match(await weekly.innerText(), /Weekly[\s\S]*5 GB · 7 days · 1 device[\s\S]*1,000[\s\S]*Published[\s\S]*1 order · 1 active/);
    assert.equal(await weekly.getByRole("button").filter({ hasText: /Edit|Unpublish|Delete/ }).count(), 0);
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/bundles-${width}.png`, fullPage: true });
    // Reorder: the second bundle moves to the top, and the store follows.
    const rows = () => page.locator("[data-cat-row]").evaluateAll((list) => list.map((row) => row.dataset.catRow));
    const [first, second] = await rows();
    await page.locator(`[data-cat-row="${second}"]`).getByRole("button", { name: /^Move .* up$/ }).click();
    await page.getByText("New order saved — the store shows it now.", { exact: true }).waitFor();
    assert.deepEqual((await rows()).slice(0, 2), [second, first]);
    // Unpublish, then the Unpublished filter shows only it.
    const row = page.locator('[data-cat-row="unlimited-7d-3"]');
    await row.getByRole("button", { name: "Unpublish Personal Unlimited · 7 days · 3 devices", exact: true }).click();
    await page.getByText("Personal Unlimited · 7 days · 3 devices unpublished — new checkouts stopped.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Unpublished · 1", exact: true }).click();
    assert.deepEqual(await rows(), ["unlimited-7d-3"]);
    await page.getByRole("button", { name: /^All · / }).click();
    // Never bought: deleted for good, after the dialog.
    await row.getByRole("button", { name: "Delete Personal Unlimited · 7 days · 3 devices", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove bundle" });
    assert.match(await dialog.innerText(), /Delete Personal Unlimited · 7 days · 3 devices\? It has never been bought\./);
    await dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
    await page.getByText("Personal Unlimited deleted permanently.", { exact: true }).waitFor();
    assert.equal(await row.count(), 0);
    assert.equal(await grid.getByRole("link", { name: "Not offered: create Personal Unlimited 7 days for 3 devices" }).count(), 1);
    // An unknown bundle address falls back to the list.
    await page.evaluate(() => { location.hash = "bundle/missing"; });
    await page.waitForFunction(() => location.hash === "#bundles");
  }, { width });
  // Redesigned Edit bundle (v2 only; canvas: AdminBundleEdit, #339).
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Edit bundle edits, adds and removes catalogue bundles at ${width}px`, async (page) => {
    await store.transaction((s) => { delete s.catalogue; });
    await page.goto(`${admin}/dashboard#bundles`);
    await page.getByRole("link", { name: "Personal Unlimited 7 days, 2 devices: 4,000 XAF, published" }).click();
    await page.getByRole("heading", { name: "Personal Unlimited · 7 days · 2 devices", exact: true }).waitFor();
    assert.equal(await page.locator("#adminBack").textContent(), "← Bundle catalogue");
    assert.equal(await page.locator("#bundleStatusHost").textContent(), "Published");
    assert.equal(await page.getByRole("radio", { name: /^Personal Unlimited/ }).getAttribute("aria-checked"), "true");
    assert.equal(await page.getByRole("button", { name: "2", exact: true }).getAttribute("aria-pressed"), "true");
    assert.match(await page.locator(".admin-edit__card").innerText(), /Personal Unlimited · 7 days · 2 devices\s+4,000 XAF[\s\S]*Unlimited data · 7 days · 2 registered devices[\s\S]*Restricts sharing — works on your registered devices/);
    // Save waits for valid terms; the server's rules show beside the field.
    await page.getByLabel("Price (XAF, whole number)", { exact: true }).fill("40.5");
    await page.getByText("Use a whole number of XAF, 1 or more — no decimals.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save bundle", exact: true }).isDisabled(), true);
    await page.getByLabel("Price (XAF, whole number)", { exact: true }).fill("4200");
    await page.getByRole("button", { name: "3", exact: true }).click();
    assert.match(await page.locator("#editSuggested").textContent(), /Personal Unlimited · 7 days · 3 devices$/);
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/bundle-edit-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Save bundle", exact: true }).click();
    await page.getByText("Saved. New checkouts use these terms now. Logged in the audit trail.", { exact: true }).waitFor();
    const saved = (await store.snapshot()).bundles.find((b) => b.id === "unlimited-7d-2");
    assert.deepEqual([saved.price, saved.deviceSlots], [4200, 3]);
    // Home WISP locks the router and changes what customers see.
    await page.getByRole("radio", { name: /^Home WISP Unlimited/ }).click();
    await page.getByText("Supported WISP router · household sharing on", { exact: true }).waitFor();
    assert.match(await page.locator(".admin-edit__card").innerText(), /household sharing[\s\S]*Share with your household through a supported router/);
    // Add a bundle from a "Not offered" cell, published at once.
    await page.goto(`${admin}/dashboard#bundles`);
    await page.getByRole("link", { name: "Not offered: create Personal Unlimited 5 hours for 2 devices" }).click();
    await page.getByRole("heading", { name: "Personal Unlimited · 5 hours · 2 devices", exact: true }).waitFor();
    assert.equal(await page.locator(".admin-edit__err:not([hidden])").count(), 0, "no error before a field is used");
    await page.getByLabel("Price (XAF, whole number)", { exact: true }).fill("450");
    await page.getByRole("radio", { name: "Published", exact: true }).click();
    await page.getByRole("button", { name: "Save bundle", exact: true }).click();
    await page.getByText("Saved. New checkouts use these terms now. Logged in the audit trail.", { exact: true }).waitFor();
    assert.match(await page.evaluate(() => location.hash), /^#bundle\/unlimited-/);
    const added = (await store.snapshot()).bundles.find((b) => b.validityUnit === "hours" && b.validityValue === 5 && b.deviceSlots === 2);
    assert.deepEqual([added.price, added.status, added.name], [450, "published", "Personal Unlimited · 5 hours · 2 devices"]);
    // Never bought: deleted for good, back to the catalogue.
    await page.getByRole("button", { name: "Delete permanently", exact: true }).click();
    await page.waitForFunction(() => location.hash === "#bundles");
    assert.equal((await store.snapshot()).bundles.some((b) => b.id === added.id), false);
  }, { width });
  // Redesigned Live devices (v2 only; canvas: AdminDevices; #381): one row per customer.
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Live devices shows one row per customer and their devices at ${width}px`, async (page) => {
    await page.goto(`${admin}/dashboard#devices`);
    await page.getByRole("heading", { name: "Live Wi-Fi devices.", exact: true }).waitFor();
    const row = page.locator("#liveDeviceRows tr").filter({ hasText: "Fixture customer" });
    await row.waitFor();
    assert.match(await page.locator("#wifiSummary").textContent(), /^2 devices · 1 customer online · updated \d+ s ago$/);
    assert.equal(await page.locator("#wifiLive").getAttribute("data-state"), "ready");
    assert.match(await row.innerText(), /Fixture customer[\s\S]*Weekly · current plan, original terms[\s\S]*2 devices/);
    assert.equal(await page.getByRole("button", { name: "Refresh devices", exact: true }).count(), 0, "read on its own, as drawn");
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/live-devices-${width}.png`, fullPage: true });
    await row.getByRole("button", { name: "View the devices of Fixture customer", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /••:DD:EE:01[\s\S]*••:DD:EE:02/);
    await dialog.getByRole("link", { name: "Open customer", exact: true }).click();
    await page.getByRole("heading", { name: "Fixture customer", exact: true }).waitFor();
    assert.equal(await page.locator("#liveDeviceDialog[open]").count(), 0, "the pop-up closes on leaving");
  }, { width });
  // Redesigned Connections (v2 only; canvas: AdminConnections).
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Connections shows services, admin security and router checks at ${width}px`, async (page) => {
    await page.goto(`${admin}/dashboard#connections`);
    await page.getByRole("heading", { name: "Connections and security.", exact: true }).waitFor();
    const router = page.locator(".admin-service").filter({ hasText: "MikroTik gateway" });
    assert.match(await router.innerText(), /Connected[\s\S]*2 devices confirmed connected/);
    await router.getByRole("button", { name: "Sync usage", exact: true }).waitFor();
    assert.match(await page.locator(".admin-service").filter({ hasText: "Omada controller" }).innerText(), /Not connected/);
    const security = page.getByRole("region", { name: "Admin security" });
    assert.match(await security.innerText(), /Password or passkey[\s\S]*1 owner · 1 operator · 1 auditor · 1 reseller[\s\S]*1 stuck/);
    await security.getByRole("link", { name: "Open audit log" }).waitFor();
    await page.getByRole("row").filter({ hasText: "legacy-uuid" }).getByRole("button", { name: "Mark obsolete" }).waitFor();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/connections-${width}.png`, fullPage: true });
  }, { width });
  // Redesigned Profile & security (v2 only; canvas: AdminProfile).
  for (const role of ["owner", "operator"]) if (uiV2) await scenario(`redesigned Profile & security shows you, your passkeys and (owners) staff as ${role}`, async (page) => {
    await page.goto(`${admin}/dashboard#profile`);
    await page.getByRole("heading", { name: "Profile and security.", exact: true }).waitFor();
    assert.match(await page.getByRole("region", { name: "You", exact: true }).innerText(), new RegExp(`fixture-${role}[\\s\\S]*${role === "owner" ? "Owner" : "Operator"}`));
    await page.getByRole("button", { name: "Change PIN", exact: true }).waitFor();
    await page.getByRole("region", { name: "You", exact: true }).getByLabel("Email", { exact: true }).waitFor(); // Phase 6: staff sign in with their email
    await page.getByRole("heading", { name: "Your passkeys", exact: true }).waitFor();
    await page.getByRole("button", { name: "Add a passkey on this device", exact: true }).waitFor();
    const staff = page.getByRole("region", { name: "Staff (owner only)", exact: true });
    if (role === "owner") {
      assert.match(await staff.innerText(), /fixture-owner · owner[^\n]*\s*You/);
      assert.equal(await staff.getByRole("button", { name: "Deactivate", exact: true }).count(), 3);
      await staff.getByText("Add a staff account", { exact: true }).click();
      await staff.getByLabel("Temporary PIN", { exact: true }).waitFor();
    } else assert.equal(await staff.count(), 0, "only owners manage staff");
    // Mismatched PINs never reach the verification step.
    await page.getByLabel("New PIN", { exact: true }).fill("123456");
    await page.getByLabel("Confirm new PIN", { exact: true }).fill("654321");
    await page.getByRole("button", { name: "Change PIN", exact: true }).click();
    await page.getByText("The two PINs don't match.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/profile-${role}.png`, fullPage: true });
  }, { role, width: role === "owner" ? 1280 : 390 });
  // Redesigned Audit log (v2 only; canvas: AdminAudit).
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Audit log words actions and filters by area at ${width}px`, async (page) => {
    await store.transaction((s) => {
      s.auditLogs.unshift(
        { id: "audit-1", action: "voucher.revoked", actor: "fixture-owner", ip: "127.0.0.1", meta: { voucherId: "v1" }, at: now.toISOString() },
        { id: "audit-2", action: "payment.refund_requested", actor: "fixture-operator", ip: "127.0.0.1", meta: { paymentId: "p1" }, at: now.toISOString() },
      );
    });
    await page.goto(`${admin}/dashboard#audit`);
    await page.getByRole("heading", { name: "Audit log.", exact: true }).waitFor();
    const rows = page.locator("#auditRecords tbody tr");
    await rows.filter({ hasText: "Revoked a voucher" }).waitFor();
    // Who reads as designed: the role, not the account name (#232).
    assert.match(await rows.filter({ hasText: "Revoked a voucher" }).innerText(), /Owner[\s\S]*Revoked a voucher[\s\S]*v1/);
    await page.getByRole("button", { name: "Money", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("#auditRecords tbody tr")].every((row) => !row.textContent.includes("Revoked a voucher")));
    await rows.filter({ hasText: "Approved a full refund" }).waitFor();
    const csv = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    assert.match((await csv).suggestedFilename(), /^ndahi-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/audit-${width}.png`, fullPage: true });
  }, { width });
  // Redesigned Resellers (v2 only; canvas: AdminResellers).
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Resellers shows the ledger and cash handoff at ${width}px`, async (page) => {
    await page.goto(`${admin}/dashboard#resellers`);
    await page.getByRole("heading", { name: "Resellers, stock and cash.", exact: true }).waitFor();
    await page.locator('[data-reseller-row="staff-reseller"]').waitFor();
    await page.getByRole("heading", { name: "Record a cash handoff", exact: true }).waitFor();
    await page.getByLabel("Amount received (FCFA)").waitFor();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/resellers-${width}.png`, fullPage: true });
  }, { width });
  // Redesigned Network setup (v2 only; canvas: AdminNetworkSetup).
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned Network setup walks four steps over the existing forms at ${width}px`, async (page) => {
    await page.goto(`${admin}/dashboard#network-setup`);
    await page.getByRole("heading", { name: "Connect and configure your equipment.", exact: true }).waitFor();
    const steps = page.getByRole("list", { name: "Setup steps" });
    assert.deepEqual((await steps.getByRole("button").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()), ["1 Router", "2 Access points", "3 Wi-Fi", "4 Review"]);
    assert.equal(await page.locator("#networkRouterConnection").isVisible(), true);
    assert.equal(await page.locator("#networkOmadaConnection").isVisible(), false);
    await steps.getByRole("button", { name: "Access points" }).click();
    assert.equal(await steps.getByRole("button", { name: "Access points" }).getAttribute("aria-current"), "step");
    assert.equal(await page.locator("#networkOmadaConnection").isVisible(), true);
    await steps.getByRole("button", { name: "Review" }).click();
    await page.getByText("Preview router, access point or Wi-Fi changes", { exact: false }).waitFor();
    await page.locator("#networkPairingStatus").waitFor();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/network-setup-${width}.png`, fullPage: true });
  }, { width });
  // Redesigned sign-in (v2 only; canvas: AdminLogin), Phase 6: email + PIN, then the passkey step.
  if (uiV2) for (const width of [390, 1280]) await scenario(`redesigned admin sign-in asks for email and PIN first at ${width}px`, async (page, context) => {
    await context.clearCookies({ name: "admin_session" });
    await page.goto(`${admin}/login`);
    await page.getByRole("heading", { name: "Administrator access.", exact: true }).waitFor();
    await page.getByText("Step 1 of 2", { exact: true }).waitFor();
    await page.getByLabel(adminIdentifierLabel, { exact: true }).waitFor();
    await page.getByLabel("PIN", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).count(), 0, "the passkey confirms the PIN; it does not sign in alone");
    await page.getByText("Every sign-in is logged.", { exact: false }).waitFor();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/login-${width}.png`, fullPage: true });
  }, { width });

  await scenario("owner can inspect and copy purchase diagnostics in admin, with bounded retries and no provisioning", async (page) => {
    let attempts = 0, release;
    const gate = new Promise((r) => { release = r; });
    const report = { checkedAt: now.toISOString(), clientTestRequired: true,
      findings: [{ label: "Before-login HTTPS", status: "review", detail: "No matching exception was found. <script>throw Error('unsafe')</script>" }],
      targets: [{ host: "api.example.test", addresses: ["216.24.57.16"] }], readings: [],
      nextStep: "Test an unpaid phone with mobile data off. Copy this report for support." };
    await page.route("**/api/admin/network/setup/purchase-access", async (route) => {
      assert.equal(route.request().method(), "POST");
      assert.ok(route.request().headers()["x-csrf-token"]);
      attempts++;
      if (attempts === 1) { await gate; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Router unavailable. Check the saved connection." }) }); }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ report }) });
    });
    await page.goto(`${admin}/dashboard#more`);
    await openAdminMore(page, "Network setup");
    const button = page.getByRole("button", { name: "Check purchase access", exact: true });
    await button.click();
    assert.equal(await page.locator("#networkPurchaseCheck").isDisabled(), true);
    release();
    await page.getByText("Router unavailable. Check the saved connection.", { exact: true }).waitFor();
    await button.click();
    await page.locator("#networkPurchaseReportText").waitFor();
    assert.deepEqual(JSON.parse(await page.locator("#networkPurchaseReportText").inputValue()), report);
    assert.equal(await page.locator("#networkPurchaseReport script").count(), 0);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { window.ndahiCopiedDiagnostics = value; } } }));
    await page.getByRole("button", { name: "Copy diagnostic report", exact: true }).click();
    assert.deepEqual(JSON.parse(await page.evaluate(() => window.ndahiCopiedDiagnostics)), report);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/purchase-diagnostics-320.png`, fullPage: true });
    await page.getByRole("button", { name: "Close report", exact: true }).click();
    assert.equal(await page.locator("#networkPurchaseReport[data-review-output]").count(), 0);
    assert.equal(await page.locator("#networkPurchaseReport").textContent(), "");
    assert.equal((await store.snapshot()).networkSetupJobs.length, 0);
    assert.equal(attempts, 2);
  }, { width: 320 });
  for (const width of [320, 390, 1280]) await scenario(`admin navigation, live count, Back and reload at ${width}px`, async (page) => {
    await page.goto(`${admin}/dashboard`);
    await page.locator("#activeSessionsMetric").waitFor();
    assert.equal(await page.locator("#activeSessionsMetric").textContent(), "2");
    for (const [id, label] of [["store", "Store"], ["customers", "Customers"], ["bundles", "Bundles"], ["connections", "Connections"]]) {
      await page.getByRole("link", { name: adminLinkName(label), exact: true }).click();
      await page.locator(`[data-tab-panel="${id}"]:visible`).waitFor();
      assert.equal(await page.locator(`[data-admin-nav="${id}"]`).getAttribute("aria-current"), "page");
      assert.equal(await page.locator("[data-admin-more]").isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    for (const tab of ["Network setup", "Generate voucher", "Audit"]) assert.equal(await adminMoreCount(page, tab), 1, tab);
    if (!uiV2) assert.deepEqual(await page.locator('[data-admin-more] [role="tab"]').allTextContents(), ["Network setup", "Generate voucher", "Audit"]);
    await page.getByRole("link", { name: adminLinkName("Devices"), exact: true }).click();
    if (uiV2) {
      await page.locator("#liveDeviceRows tr").filter({ hasText: "Fixture customer" }).waitFor();
      assert.equal(await page.locator("#liveDeviceRows tr").count(), 1, "one row per customer");
    } else {
      await page.locator("#wifiRecords tbody tr").filter({ hasText: observed[1].mac }).waitFor();
      assert.equal(await page.locator("#wifiRecords tbody tr").count(), 2);
    }
    await page.reload(); await page.getByRole("heading", { name: "Live Wi-Fi devices.", exact: true }).waitFor();
    await page.getByRole("link", { name: adminLinkName("Payments"), exact: true }).click();
    await page.goBack(); assert.equal(new URL(page.url()).hash, "#devices");
    assert.equal(await page.locator('[data-admin-nav="devices"]').getAttribute("aria-current"), "page");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/devices-${width}.png`, fullPage: true });
  }, { width });
  await scenario("obsolete disconnects have no Replay and can be resolved without disconnecting a device", async (page) => {
    await page.goto(`${admin}/dashboard#connections`);
    const row = page.getByRole("row").filter({ hasText: "legacy-uuid" });
    await row.waitFor(); assert.equal(await row.getByRole("button", { name: "Replay", exact: true }).count(), 0);
    await row.getByRole("button", { name: "Mark obsolete" }).click();
    await row.waitFor({ state: "detached" });
    const s = await store.snapshot();
    assert.equal(s.routerCommands[0].status, "resolved"); assert.equal(s.routerCommands[0].totalAttempts, 49);
    assert.equal(s.vouchers[0].wifiDevices.length, 2);
    assert.equal(s.auditLogs.filter((a) => a.action === "network.command_resolved").length, 1);
  });
  await scenario("refresh waits for a successful router reading and clears departed devices", async (page) => {
    let release; readGate = new Promise((r) => { release = r; });
    await page.goto(`${admin}/dashboard#devices`);
    if (uiV2) {
      await page.locator("#liveDeviceRows tr").filter({ hasText: "Fixture customer" }).waitFor();
      assert.equal(await requestReading(page), 202);
    } else {
      await page.locator("#wifiRecords tbody tr").filter({ hasText: observed[0].mac }).waitFor();
      await page.getByRole("button", { name: "Refresh devices", exact: true }).click();
      await page.getByText("A router reading was requested.", { exact: false }).waitFor();
    }
    assert.equal(readCalls, 1); assert.equal((await store.snapshot()).vouchers[0].wifiDevices.length, 2);
    devices = []; release();
    // v2 updates in place, without a reload (#381).
    await page.locator("#wifiSummary").filter({ hasText: uiV2 ? "0 devices · 0 customers online" : "0 confirmed connected" }).waitFor();
    await page.locator(uiV2 ? "#liveDeviceRows" : "#wifiRecords tbody").getByText(uiV2 ? "No Wi-Fi devices right now." : "No records found.").waitFor();
  });
  await scenario("failed router readings preserve stale devices and expose a bounded retry action", async (page) => {
    now = new Date(+now + 180000); failRead = true;
    await page.goto(`${admin}/dashboard#devices`);
    if (uiV2) { await page.locator("#liveDeviceRows .admin-devices__view").first().waitFor(); await requestReading(page); }
    else await page.getByRole("button", { name: "Refresh devices", exact: true }).click();
    await page.getByRole("button", { name: "Retry router reading" }).waitFor();
    assert.equal((await store.snapshot()).vouchers[0].wifiDevices.length, 2);
    if (uiV2) {
      await openLiveDevices(page);
      assert.equal(await page.locator(".admin-devices__kick:enabled").count(), 0, "an old reading can't be acted on");
      await page.keyboard.press("Escape");
    } else assert.equal(await page.locator("#wifiRecords [data-wifi-mac]:enabled").count(), 0);
    failRead = false; await page.getByRole("button", { name: "Retry router reading" }).click();
    await page.locator("#wifiSummary").filter({ hasText: uiV2 ? "1 customer online" : "Router reading current" }).waitFor();
  });
  await scenario("a device slot remains occupied until the scoped disconnect is confirmed", async (page) => {
    let release; disconnectGate = new Promise((r) => { release = r; });
    await page.goto(`${admin}/dashboard#devices`);
    if (uiV2) { await page.locator("#liveDeviceRows .admin-devices__view").first().waitFor(); await openLiveDevices(page); await page.locator(".admin-devices__kick").first().click(); }
    else await page.locator(`[data-wifi-mac="${observed[0].mac}"]`).click();
    await page.getByRole("button", { name: uiV2 ? /^Disconnect .* of Fixture customer$/ : "Disconnecting…", exact: !uiV2 }).filter({ hasText: "Disconnecting…" }).waitFor();
    assert.equal((await store.snapshot()).vouchers[0].wifiDevices.length, 2);
    release();
    await page.locator("#wifiSummary").filter({ hasText: uiV2 ? "1 device · 1 customer online" : "1 confirmed connected" }).waitFor();
    assert.equal((await store.snapshot()).vouchers[0].wifiDevices[0].sessionId, "*B");
  });
  for (const role of ["operator", "auditor", "reseller"]) await scenario(`navigation preserves ${role} access and hides owner setup`, async (page) => {
    // v2 on a phone: a reseller's Home is the reseller screen (#261, canvas:
    // ResellerHome), which has no admin menu; Print my codes opens the shell.
    const resellerHome = uiV2 && role === "reseller";
    const atHome = () => resellerHome ? page.locator("#resellerHome .reseller-home__title").waitFor() : page.locator('[data-admin-nav="home"][aria-current]').waitFor();
    await page.goto(`${admin}/dashboard#network-setup`);
    await atHome();
    assert.equal(await page.locator('[data-admin-nav="store"]').count(), role === "operator" ? 1 : 0);
    await page.goto(`${admin}/dashboard#store`);
    if (role === "operator") await page.locator('[data-admin-nav="store"][aria-current]').waitFor();
    else await atHome();
    if (uiV2 && role === "auditor") {
      await page.goto(`${admin}/dashboard#voucher-print`);
      await page.locator('[data-admin-nav="home"][aria-current]').waitFor();
    }
    if (resellerHome) {
      await page.locator("#resellerHome").getByRole("link", { name: "Print my codes", exact: true }).click();
      await page.locator(".nd-admin-shell").waitFor();
    }
    assert.equal(await adminMoreCount(page, "Network setup"), 0);
    await page.getByRole("link", { name: adminLinkName("Devices"), exact: true }).click();
    if (uiV2) {
      await page.locator("#liveDeviceRows tr").filter({ hasText: "2 devices" }).waitFor();
      assert.equal(await page.locator("#refreshWifi").count(), 0);
      await openLiveDevices(page);
      assert.equal(await page.locator(".admin-devices__kick").count(), role === "operator" ? 2 : 0);
    } else {
      await page.locator("#wifiRecords tbody tr").filter({ hasText: observed[0].mac }).waitFor();
      assert.equal(await page.locator("#refreshWifi").isVisible(), role === "operator");
      assert.equal(await page.getByRole("button", { name: "Disconnect", exact: true }).count(), role === "operator" ? 2 : 0);
    }
  }, { role });
  await scenario("admin installation assets, service worker and offline launch do not cache records", async (page, context) => {
    const response = await fetch(`${admin}/manifest.webmanifest`), manifest = await response.json();
    assert.match(response.headers.get("content-type"), /manifest\+json/); assert.equal(manifest.name, "NDAHI Admin");
    for (const icon of manifest.icons) { const r = await fetch(admin + icon.src); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /image\/png/); }
    await page.goto(`${admin}/dashboard#more`);
    await page.getByRole("heading", { name: "Install NDAHI Admin" }).waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    assert.deepEqual(await page.evaluate(() => caches.keys()), []);
    await context.setOffline(true); await page.reload(); await page.getByRole("heading", { name: "You're offline" }).waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("670042001"));
    await context.setOffline(false); await page.getByRole("link", { name: "Try again" }).click();
    await page.getByRole("link", { name: adminLinkName("Devices"), exact: true }).click(); await page.locator(uiV2 ? "#liveDevices" : "#wifiRecords").waitFor();
  });
  await scenario("the admin install button invokes the available browser prompt and hides after installation", async (page) => {
    await page.goto(`${admin}/dashboard#more`);
    await page.locator("#adminInstall").waitFor();
    await page.evaluate(() => {
      window.installPrompts = 0;
      const event = new Event("beforeinstallprompt", { cancelable: true });
      event.prompt = async () => { window.installPrompts++; };
      event.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(event);
    });
    await page.getByRole("button", { name: "Install app", exact: true }).click();
    assert.equal(await page.evaluate(() => window.installPrompts), 1);
    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    await page.locator("#adminInstall").waitFor({ state: "hidden" });
  });
  await scenario("Apple installation gives manual Home Screen instructions", async (page) => {
    await page.goto(`${admin}/dashboard#more`); await page.getByText(/tap Share, then Add to Home Screen/).waitFor();
  }, { apple: true });
  await scenario("admin updates preserve edits and pending network setup, then refresh when idle", async (page) => {
    await page.clock.install();
    // An unsaved form: v1's new-bundle form; in v2 (where Bundles is the catalogue, #338) the profile email.
    const draft = uiV2 ? { view: "profile", form: "#adminEmailForm", field: '#adminEmailForm [name="email"]' } : { view: "bundles", form: "#bundle", field: '#bundle [name="name"]' };
    await page.goto(`${admin}/dashboard#${draft.view}`); await page.locator(draft.field).waitFor();
    const baseline = await page.locator('meta[name="ndahi-release"]').getAttribute("content");
    let available = true, reloads = 0;
    page.on("load", () => { reloads++; });
    await page.route("**/version.json", (route) => route.fulfill({ json: { revision: available ? "fixture-new-release" : baseline } }));
    await page.locator(draft.field).fill("unsaved@example.test");
    await page.clock.fastForward(61000); await page.getByText("A new version is ready.", { exact: false }).waitFor();
    assert.equal(reloads, 0); assert.equal(await page.locator(draft.field).inputValue(), "unsaved@example.test");
    await page.evaluate((form) => { document.querySelector("#networkSetup").dataset.setupPending = "true"; document.querySelector(form).reset(); }, draft.form);
    await page.clock.fastForward(61000); assert.equal(reloads, 0);
    await openAdminMore(page, "Generate voucher");
    await page.getByRole("button", { name: adminGenerateName("resale") }).click();
    await page.getByText("1 voucher generated").waitFor();
    await page.evaluate(() => { document.querySelector("#networkSetup").dataset.setupPending = "false"; });
    await page.clock.fastForward(61000); assert.equal(reloads, 0, "generated codes must not disappear on an automatic update");
    available = false;
    await page.getByRole("button", { name: "Close codes", exact: true }).click();
    await page.clock.fastForward(61000);
    await page.waitForFunction(() => !document.querySelector(".update-notice:not([hidden])"));
    await page.waitForLoadState("load");
    assert.equal(reloads, 1);
  });
  console.log(`${checks} admin app browser journeys passed. Screenshots: ${screenshots}`);
} finally { await browser?.close(); await close(website); await close(server); }
