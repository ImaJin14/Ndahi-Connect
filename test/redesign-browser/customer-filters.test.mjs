import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Customers filters (#256, canvas: AdminCustomers): Active / Stale / Suspended
// chips with counts, "Stale after", Last active, the stale state and its CSV
// export, and data used for an unlimited bundle. Local servers, synthetic data.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

test("owners filter customers by activity and export the stale list", { timeout: 180000 }, async (t) => {
  const secret = "redesign-customer-filters", store = createStore({ persistent: false });
  await store.transaction((s) => {
    const customer = (id, name, phone, joined, extra = {}) => s.customers.push({ id, name, phone, createdAt: daysAgo(joined), ...extra });
    customer("c-online", "Amina N.", "670001245", 90); customer("c-recent", "L. Ngwa", "670002108", 60);
    customer("c-stale", "P. Mbah", "670006452", 80); customer("c-never", "Grace T.", "670000366", 41);
    customer("c-suspended", "K. Nji", "670005920", 70, { status: "suspended" });
    const voucher = (id, customerId, status, extra) => s.vouchers.push({ id, customerId, status, planId: "weekly", deviceLimit: 3, usedBytes: 0, ...extra });
    voucher("v-online", "c-online", "active", { quotaBytes: null, usedBytes: 3.2e9, activatedAt: daysAgo(2), expiresAt: daysAgo(-5) });
    voucher("v-recent", "c-recent", "expired", { quotaBytes: 5e9, activatedAt: daysAgo(16), expiresAt: daysAgo(9) });
    voucher("v-stale", "c-stale", "expired", { quotaBytes: 5e9, activatedAt: daysAgo(49), expiresAt: daysAgo(42) });
    s.sessions.push({ id: "s-online", customerId: "c-online", voucherId: "v-online", status: "online", connectedAt: daysAgo(0) });
    s.adminUsers.push({ id: "filters-owner", username: "owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "filters-owner", role: "owner", tokenHash: hashSecret("filters-owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const staticServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${staticServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SESSION_COOKIE_SECURE: "false", ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin,
    PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(staticServer); });
  const screenshots = "/tmp/ndahi-customer-filters";
  await mkdir(screenshots, { recursive: true });

  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "filters-owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${admin}/dashboard#customers`);
      const chip = (name) => page.getByRole("group", { name: "Show customers" }).getByRole("button", { name: new RegExp(`^${name} \\d+$`) });
      await page.getByRole("link", { name: "Amina N.", exact: true }).waitFor();
      assert.equal(await chip("All").textContent(), "All 5");
      assert.deepEqual(await Promise.all(["Active", "Stale", "Suspended"].map((name) => chip(name).textContent())), ["Active 2", "Stale 2", "Suspended 1"]);
      const row = (name) => page.locator("#customerRecords tr", { has: page.getByRole("link", { name, exact: true }) });
      assert.match(await row("Amina N.").textContent(), /Weekly · 3\.2 GB used.*Online now.*Active/, "unlimited bundles show data used");
      assert.match(await row("L. Ngwa").textContent(), /Ended .*Active/);
      assert.match(await row("Grace T.").textContent(), /Joined .*Stale · never bought.*Give voucher/);
      assert.match(await row("K. Nji").textContent(), /Suspended.*Restore/);
      await chip("Stale").click();
      await page.getByText("2 customers", { exact: true }).waitFor();
      assert.equal(await page.locator("#customerRecords tbody tr").count(), 2);
      assert.match(await row("P. Mbah").textContent(), /Stale · 42 days/);
      assert.equal(await chip("Stale").getAttribute("aria-pressed"), "true");
      assert.deepEqual(await lowContrastText(page), [], `contrast at ${width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
      await page.screenshot({ path: `${screenshots}/stale-${width}.png`, fullPage: true });
      if (width === 1280) {
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Export list (CSV)", exact: true }).click();
        const csv = await readFile(await (await download).path(), "utf8");
        assert.equal(csv.split("\n")[0], "name,phone,state,idleDays,lastBundleEnded,joined");
        assert.deepEqual(csv.split("\n").slice(1).map((line) => line.split(",")[0]).sort(), ['"Grace T."', '"P. Mbah"']);
        // A shorter "Stale after" makes the recent customer stale too.
        await page.getByLabel("Stale after").selectOption("7");
        await page.getByText("3 customers", { exact: true }).waitFor();
        assert.equal(await chip("Active").textContent(), "Active 1");
        assert.match(await page.locator("#customerNote").textContent(), /in the last 7 days/);
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});
