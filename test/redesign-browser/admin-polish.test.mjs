import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Admin v2 polish (#232) against the artboards:
// - Audit (AdminAudit): newest first, "10 Nov 17:25", Who as "Owner" or
//   "Operator · Brenda" (System for automatic work), On by name.
// - Home (Admin): "OWNER · FRIDAY 20 NOVEMBER", not "FRIDAY, NOVEMBER 20".
// - Lists: an empty list says so once, and one page shows no Previous/Next.
// - Connections router checks: headings, statuses and ids in plain words.
// - Network setup (AdminNetworkSetup): one column as wide as the design's panel.
// Local servers only, synthetic data, 390 and 1280 px.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();

test("admin v2 lists, Audit, Home, router checks and network setup read as designed", { timeout: 300000 }, async (t) => {
  const secret = "redesign-admin-polish", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Patrick", role: "owner", active: true, passkeys: [] },
      { id: "u-op", username: "brenda", displayName: "Brenda", role: "operator", active: true, passkeys: [] },
      { id: "u-res", username: "kiosk", displayName: "Market kiosk", role: "reseller", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.customers.push({ id: "c1", name: "Kevin Nji", phone: "670001245", status: "active", createdAt: "2026-11-01T00:00:00Z" });
    // Stored out of order on purpose: the list must still come newest first.
    s.auditLogs.push(
      { id: "a1", at: "2026-11-10T07:15:00Z", actor: "owner", action: "admin.login", meta: {} },
      { id: "a2", at: "2026-11-10T16:25:00Z", actor: "brenda", action: "store.order_handed_over", meta: { orderReference: "NS-2611-0088" } },
      { id: "a3", at: "2026-11-10T13:30:00Z", actor: "brenda", action: "reseller.remittance_recorded", meta: { resellerId: "u-res" } },
      { id: "a4", at: "2026-11-10T14:48:00Z", actor: "owner", action: "customer.suspended", meta: { customerId: "c1" } },
      { id: "a5", at: "2026-11-10T09:00:00Z", actor: "system", action: "network.incident.opened", meta: {} });
    s.routerCommands.push(
      { id: "cmd-1", kind: "router_command", action: "sync_voucher", targetId: "b4c01e63-8d9b-442a-a5f1-f7e666d7a6a0", status: "queued", attempts: 0, totalAttempts: 0, at: "2026-11-10T16:00:00Z" },
      { id: "cmd-2", kind: "router_command", action: "sync_voucher", targetId: "short-id", status: "dead_letter", attempts: 8, totalAttempts: 8, lastError: "router_unreachable", at: "2026-11-10T15:00:00Z" });
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
  const screenshots = process.env.POLISH_SCREENSHOTS || "/tmp/ndahi-admin-polish";
  await mkdir(screenshots, { recursive: true });

  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const check = async (label) => {
      assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
      await page.screenshot({ path: `${screenshots}/${label}-${width}.png`, fullPage: true });
    };

    // Home: the date as "Friday 20 November" on the network's clock.
    await page.goto(`${admin}/dashboard#home`);
    const eyebrow = page.locator("#adminEyebrow");
    await eyebrow.waitFor();
    const expected = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Douala" });
    assert.equal((await text(eyebrow)).toLowerCase(), `owner · ${expected}`.toLowerCase());
    assert.doesNotMatch(await text(eyebrow), /,/);

    // Audit.
    await page.goto(`${admin}/dashboard#audit`);
    const rows = page.locator("#auditRecords tbody tr");
    await rows.nth(4).waitFor();
    // When, Who and On (the action's wording is the existing translation).
    const cells = await rows.evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.innerText.replace(/\s+/g, " ").trim())).map((r) => [r[0], r[1], r[3]]));
    assert.deepEqual(cells, [
      ["10 Nov 17:25", "Operator · Brenda", "NS-2611-0088"],
      ["10 Nov 15:48", "Owner", "K. Nji"],
      ["10 Nov 14:30", "Operator · Brenda", "Market kiosk"],
      ["10 Nov 10:00", "System", "—"],
      ["10 Nov 08:15", "Owner", "—"],
    ]);
    // Five entries fit on one page: the count stays, Previous/Next go.
    const pager = page.locator("#auditRecords .records-pager");
    assert.equal(await text(pager.locator("span")), "Page 1 of 1 · 5 total");
    assert.equal(await pager.locator('[data-page="prev"]').isVisible(), false);
    assert.equal(await pager.locator('[data-page="next"]').isVisible(), false);
    await check("audit");

    // Live devices with none online: said once, no pager (one row per customer, #381).
    await page.goto(`${admin}/dashboard#devices`);
    await page.locator("#liveDeviceRows").getByText("No Wi-Fi devices right now.").waitFor();
    assert.equal(await page.locator("#liveDevices .records-pager").count(), 0);
    assert.equal(await page.getByText("No Wi-Fi devices right now.").filter({ visible: true }).count(), 1, "said once");
    await check("devices-empty");

    // Connections: router commands in plain words.
    await page.goto(`${admin}/dashboard#connections`);
    await page.locator("#routerChecks > summary").click();
    const commands = page.locator("#routerChecksTitle").locator("xpath=..").locator("table").last();
    await commands.waitFor();
    assert.deepEqual(await commands.locator("thead th").evaluateAll((ths) => ths.map((th) => th.textContent.trim())), ["Command", "On", "Status", "Tries", "Reason", "What you can do"]);
    const commandRows = await commands.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.children].slice(0, 5).map((td) => td.innerText.trim())));
    assert.deepEqual(commandRows.find((r) => r[2] === "Waiting"), ["Sync voucher", "b4c01e63…", "Waiting", "0", ""]);
    assert.deepEqual(commandRows.find((r) => r[2] === "Needs review"), ["Sync voucher", "short-id", "Needs review", "8", "Router unreachable"]);
    assert.equal(await commands.locator('span[title="b4c01e63-8d9b-442a-a5f1-f7e666d7a6a0"]').count(), 1, "the full id on hover");
    await check("connections");

    // Network setup: the step panel and the checks below share one width.
    await page.goto(`${admin}/dashboard#network-setup`);
    await page.locator(".admin-setup__step:not([hidden])").waitFor();
    const widths = await page.evaluate(() => [...document.querySelectorAll(".admin-setup__step:not([hidden]), #networkSetup > section")].map((el) => Math.round(el.getBoundingClientRect().width)).filter((w) => w > 0));
    assert.ok(widths.length >= 2 && widths.every((w) => w <= 810), `setup cards at most 810px: ${widths}`);
    if (width === 1280) assert.equal(new Set(widths).size, 1, `one column: ${widths}`);
    await check("network-setup");
    assert.deepEqual(errors, []);
    await context.close();
  }
});
