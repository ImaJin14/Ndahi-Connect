import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Bundles arranged Daily, Weekly and Monthly with filters (owner, 21 Nov 2026:
// "auto arrange bundles based on monthly, weekly and daily plans with filters
// on the bundle page"), on the customer buy page. Admin → Bundles became the
// bundle catalogue on 24 Nov (#338, canvas AdminBundles): its price grid rows
// by validity, checked in scripts/check-admin-app-journeys.mjs. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("bundles are arranged by period with filters on the buy page", { timeout: 300000 }, async (t) => {
  const secret = "redesign-bundle-periods", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.bundles.push({ id: "three-days", name: "Three Days", price: 600, quotaGb: 3, validityHours: 72, deviceLimit: 1, custom: true, createdAt: "2026-11-21T00:00:00Z" },
      { id: "six-hours", name: "Six Hours", price: 150, quotaGb: 1, validityHours: 6, deviceLimit: 1, custom: true, createdAt: "2026-11-21T00:00:00Z" });
    s.adminUsers.push({ id: "owner", username: "owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`, admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock",
    OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); await close(adminServer); });
  const screenshots = process.env.BUNDLE_PERIOD_SCREENSHOTS || "/tmp/ndahi-bundle-periods";
  await mkdir(screenshots, { recursive: true });
  const open = async (width, cookies = []) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 } });
    await context.route("**/*", (route) => [api, portal, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }, ...cookies]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { context, page, errors };
  };
  const visibleCards = (page, selector) => page.locator(selector).evaluateAll((cards) => cards.filter((card) => card.checkVisibility()).map((card) => card.dataset.card || card.dataset.bundleCard));
  const check = async (page, label, hide = "") => {
    // The buy page's choose buttons are deliberately invisible overlays (see
    // payment-fee-disclosure.test), so they are set aside for the contrast check.
    await page.evaluate((selector) => { document.activeElement?.blur(); if (selector) document.querySelectorAll(selector).forEach((el) => { el.style.display = "none"; }); }, hide);
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    await page.evaluate((selector) => { if (selector) document.querySelectorAll(selector).forEach((el) => { el.style.display = ""; }); }, hide);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };

  for (const width of [390, 1280]) {
    // The buy page: All shows Daily, Weekly and Monthly, each cheapest first.
    let { context, page, errors } = await open(width);
    await page.goto(`${portal}/onboarding.html`);
    const chips = page.getByRole("group", { name: "Show bundles" }).getByRole("button");
    await chips.first().waitFor();
    assert.deepEqual(await chips.allInnerTexts(), ["All", "Daily", "Weekly", "Monthly"]);
    assert.equal(await chips.first().getAttribute("aria-pressed"), "true");
    assert.deepEqual(await page.locator(".plan-group__title").allInnerTexts().then((t) => t.map((x) => x.toLowerCase())), ["daily", "weekly", "monthly"]);
    assert.deepEqual(await visibleCards(page, '[data-plan-group="daily"] [data-card]'), ["six-hours", "daily"]);
    assert.deepEqual(await visibleCards(page, '[data-plan-group="weekly"] [data-card]'), ["three-days", "weekly"]);
    assert.deepEqual(await visibleCards(page, '[data-plan-group="monthly"] [data-card]'), ["monthly", "connect30", "family", "connect75", "max", "unlimited"]);
    await page.waitForFunction(() => [...document.querySelectorAll("#plans [data-plan]")].every((button) => !button.disabled));
    await check(page, `buy-all-${width}`, "#plans [data-plan]");
    // Weekly only, by mouse; then Monthly, by keyboard.
    await page.getByRole("button", { name: "Weekly", exact: true }).click();
    assert.deepEqual(await visibleCards(page, "#plans [data-card]"), ["three-days", "weekly"]);
    assert.equal(await page.getByRole("button", { name: "Weekly", exact: true }).getAttribute("aria-pressed"), "true");
    await check(page, `buy-weekly-${width}`, "#plans [data-plan]");
    await page.getByRole("button", { name: "Monthly", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await visibleCards(page, "#plans [data-card]"), ["monthly", "connect30", "family", "connect75", "max", "unlimited"]);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.planPeriod), "monthly", "focus stays on the chip");
    // A filtered list still buys.
    await page.locator('#plans [data-plan="monthly"]').click();
    await page.locator("#checkout").waitFor({ state: "visible" });
    assert.match(await page.locator("#checkoutCost .buy-cost__plan").innerText(), /^Monthly/);
    assert.deepEqual(errors, []);
    await context.close();

    // A link can open one period.
    ({ context, page, errors } = await open(width));
    await page.goto(`${portal}/onboarding.html?period=daily`);
    await page.locator('#plans [data-plan-period="daily"][aria-pressed="true"]').waitFor();
    assert.deepEqual(await visibleCards(page, "#plans [data-card]"), ["six-hours", "daily"]);
    assert.deepEqual(errors, []);
    await context.close();

  }
});
