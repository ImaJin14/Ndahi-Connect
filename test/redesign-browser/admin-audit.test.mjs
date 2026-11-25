import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Audit log (AdminAudit, #378; owner decisions, 25 Nov):
// - the six drawn chips (Everything, Money, Store, Vouchers, Customers, Sign-ins);
// - a staff sign-in is one row, "Signed in with PIN + passkey", on "Admin";
// - the chip, search and page live in the address and survive a reload;
// - search and Security events sit in a closed section below the log.
// Local servers only, synthetic data, 390 and 1280 px.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const at = (hhmm, seconds = 0) => new Date(Date.parse(`2026-11-10T${hhmm}:00+01:00`) + seconds * 1000).toISOString();

test("the audit log has the drawn chips and keeps its filter in the address", { timeout: 300000 }, async (t) => {
  const secret = "redesign-admin-audit", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Patrick", role: "owner", active: true, passkeys: [] },
      { id: "u-op", username: "brenda", displayName: "Brenda", role: "operator", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    (s.storeProducts ||= []).push({ id: "prod-1", name: "Wavlink AC1200", stock: 2, version: 1 });
    s.auditLogs.unshift(
      { id: "a1", at: at("17:25"), actor: "brenda", action: "store.stock.adjust", meta: { id: "prod-1", from: 3, to: 2 } },
      { id: "a2", at: at("17:22"), actor: "owner", action: "payment.refund_requested", meta: {} },
      { id: "a3", at: at("16:10"), actor: "owner", action: "network.command_resolved", meta: {} },
      { id: "a4", at: at("08:15", 20), actor: "owner", action: "admin.login.succeeded", meta: {} },
      { id: "a5", at: at("08:15"), actor: "owner", action: "admin.login.pin_verified", meta: {} });
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
  const screenshots = process.env.POLISH_SCREENSHOTS || "/tmp/ndahi-admin-audit";
  await mkdir(screenshots, { recursive: true });

  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const rows = page.locator("#auditRecords tbody tr");
    const actions = () => rows.evaluateAll((trs) => trs.map((tr) => tr.children[2]?.innerText.trim()));

    await page.goto(`${admin}/dashboard#audit`);
    await rows.nth(3).waitFor();
    const chips = page.locator("#auditRecords [data-status-chip]");
    assert.deepEqual(await chips.allInnerTexts(), ["Everything", "Money", "Store", "Vouchers", "Customers", "Sign-ins"]);
    assert.deepEqual(await actions(), ["Changed stock 3 → 2", "Approved a full refund", "Marked a router command obsolete", "Signed in with PIN + passkey"]);
    assert.match(await rows.nth(3).innerText(), /Owner[\s\S]*Admin/);
    assert.equal(await page.locator("#auditRecords .records-pager").isVisible(), false, "one page: no pager");
    assert.equal(await page.locator(".admin-audit__tools").evaluate((d) => d.open), false, "search and security events start closed");
    assert.deepEqual(await page.evaluate(() => getComputedStyle(document.querySelector("#auditRecords .nd-chip")).fontWeight), "600");
    assert.deepEqual(await lowContrastText(page), [], "contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
    await page.screenshot({ path: `${screenshots}/audit-${width}.png`, fullPage: true });

    // Sign-ins: the address keeps it, and a reload starts on it.
    await page.getByRole("button", { name: "Sign-ins", exact: true }).click();
    await page.waitForFunction(() => location.hash === "#audit?type=signins");
    assert.deepEqual(await actions(), ["Signed in with PIN + passkey"]);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#auditRecords tbody tr").length === 1 && document.querySelector('[data-status-chip="signins"]').getAttribute("aria-pressed") === "true");
    // Leaving and coming back through the menu keeps the chip in the address.
    await page.goto(`${admin}/dashboard#home`);
    await page.evaluate(() => { location.hash = "#audit"; });
    await page.waitForFunction(() => location.hash === "#audit?type=signins");

    // Search, in the closed section: the address carries it too.
    await page.getByRole("button", { name: "Everything", exact: true }).click();
    await page.waitForFunction(() => location.hash === "#audit");
    await page.locator(".admin-audit__tools > summary").click();
    await page.getByRole("searchbox", { name: "Search the audit log" }).fill("refund");
    await page.waitForFunction(() => location.hash === "#audit?q=refund" && document.querySelectorAll("#auditRecords tbody tr").length === 1);
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".admin-audit__tools")?.open === true && document.querySelectorAll("#auditRecords tbody tr").length === 1);
    assert.equal(await page.getByRole("searchbox", { name: "Search the audit log" }).inputValue(), "refund");
    assert.deepEqual(errors, []);
    await context.close();
  }
});
