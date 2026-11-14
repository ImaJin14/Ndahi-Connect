import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Customers bulk actions (#257, canvas: AdminCustomers): tick customers, send a
// message, then give a gift voucher with fresh PIN proof. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

test("owners message and gift ticked customers from the Customers list", { timeout: 180000 }, async (t) => {
  const secret = "redesign-customer-bulk", pin = "482913", store = createStore({ persistent: false });
  await store.transaction(async (s) => {
    for (const [id, name, phone] of [["c-1", "P. Mbah", "670006452"], ["c-2", "S. Tabe", "670001877"], ["c-3", "B. Achu", "670009230"]])
      s.customers.push({ id, name, phone, createdAt: daysAgo(80) });
    s.adminUsers.push({ id: "bulk-owner", username: "owner", role: "owner", active: true, passwordHash: await argon2.hash(pin), passkeys: [] });
    s.adminSessions.push({ userId: "bulk-owner", role: "owner", tokenHash: hashSecret("bulk-owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
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
  const screenshots = "/tmp/ndahi-customer-bulk";
  await mkdir(screenshots, { recursive: true });

  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "bulk-owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${admin}/dashboard#customers`);
      await page.getByRole("link", { name: "P. Mbah", exact: true }).waitFor();
      const bar = page.getByRole("region", { name: "Bulk actions" });
      assert.equal(await bar.isVisible(), false, "no bar until a row is ticked");
      await page.getByRole("checkbox", { name: "Select P. Mbah", exact: true }).check();
      await page.getByRole("checkbox", { name: "Select S. Tabe", exact: true }).check();
      await bar.getByText("2 selected", { exact: true }).waitFor();
      if (width === 1280) {
        await bar.getByRole("button", { name: "Send a message", exact: true }).click();
        await bar.getByLabel("Message — sent as an in-app notification and email").fill("We miss you! Weekly is back on sale.");
        await bar.getByRole("button", { name: "Send to 2", exact: true }).click();
        await page.getByText("Message sent to 2 customers", { exact: true }).waitFor();
        assert.equal(await bar.isVisible(), false, "the selection clears after sending");
        assert.equal((await store.snapshot()).customerMessages.length, 2);
        // Select all shown, then a gift with fresh PIN proof.
        await page.getByRole("checkbox", { name: "Select all shown", exact: true }).check();
        await bar.getByText("3 selected", { exact: true }).waitFor();
        await bar.getByRole("button", { name: "Give a gift voucher", exact: true }).click();
        await bar.getByText("Saved in each account, starts when they use it. Recorded as gifts, no revenue.", { exact: true }).waitFor();
        assert.deepEqual(await lowContrastText(page), [], "contrast with the gift panel open");
        await page.screenshot({ path: `${screenshots}/gift-panel-${width}.png` });
        await bar.getByRole("button", { name: "Give to 3", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Verify administrator action" });
        await dialog.getByLabel("Current administrator PIN").fill(pin);
        await dialog.getByRole("button", { name: "Verify PIN", exact: true }).click();
        await page.getByText("Gift voucher given to 3 customers · logged in the audit trail", { exact: true }).waitFor();
        const gifts = (await store.snapshot()).vouchers.filter((v) => v.saleType === "gift");
        assert.ok(gifts.length === 3 && gifts.every((v) => v.status === "available" && v.saleAmount === 0));
      } else {
        await bar.getByRole("button", { name: "Give a gift voucher", exact: true }).click();
        assert.deepEqual(await lowContrastText(page), [], "contrast at 390");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no overflow at 390");
        await page.screenshot({ path: `${screenshots}/gift-panel-${width}.png`, fullPage: true });
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});
