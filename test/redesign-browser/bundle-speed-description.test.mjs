import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// A bundle with a speed limit says so in its description (owner, 21 Nov: "a
// bundle with rate limit of 2mbps should clearly state it in the bundle
// description"): on the plan card, shared when the bundle covers several
// devices, and in the checkout summary. A bundle without a limit says nothing
// about speed. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

test("plan cards and the checkout summary state a bundle's speed limit", { timeout: 240000 }, async (t) => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.bundles.push({ id: "fast-2", name: "Starter 2 Mbps", price: 1500, quotaGb: 5, validityHours: 168, deviceLimit: 1, downloadMbps: 2, uploadMbps: 1, custom: true, createdAt: "2026-11-21T00:00:00Z" },
      { id: "family-10", name: "Family 10 Mbps", price: 12000, quotaGb: 40, validityHours: 720, deviceLimit: 3, downloadMbps: 10, uploadMbps: null, custom: true, createdAt: "2026-11-21T00:00:00Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: "speed-description", SECRET_PEPPER: "speed-description",
    SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = process.env.SPEED_SCREENSHOTS || "/tmp/ndahi-bundle-speed";
  await mkdir(screenshots, { recursive: true });

  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/onboarding.html`);
    const card = (id) => page.locator(`[data-card="${id}"]`);
    await card("fast-2").waitFor();
    assert.equal(await text(card("fast-2").locator(".plan-speed")), "Up to 2 Mbps download, 1 Mbps upload");
    assert.equal(await text(card("family-10").locator(".plan-speed")), "Up to 10 Mbps download, shared by all devices");
    assert.equal(await card("weekly").locator(".plan-speed").count(), 0, "no limit, nothing said about speed");
    assert.doesNotMatch(await text(card("weekly")), /Mbps/);
    // Checked once the plans can be chosen (the buttons are disabled while access loads).
    // Each card's choose button is a deliberately invisible overlay (as
    // payment-fee-disclosure.test notes), so it is set aside for the contrast
    // check; the cards' text, the speed included, is checked.
    await page.waitForFunction(() => [...document.querySelectorAll("[data-plan]")].every((button) => !button.disabled));
    await page.evaluate(() => { document.activeElement?.blur(); document.querySelectorAll("#plans [data-plan]").forEach((button) => { button.style.display = "none"; }); });
    assert.deepEqual(await lowContrastText(page), [], `contrast at ${width}`);
    await page.evaluate(() => document.querySelectorAll("#plans [data-plan]").forEach((button) => { button.style.display = ""; }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
    await card("fast-2").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/plan-cards-speed-${width}.png`, fullPage: true });
    // Choosing it: the checkout summary repeats the speed.
    await page.locator('[data-plan="fast-2"]').click();
    const cost = page.locator("#checkoutCost");
    await cost.waitFor();
    assert.match(await text(cost.locator(".buy-cost__plan")), /^Starter 2 Mbps 5 GB data · 7 days · 1 device · Up to 2 Mbps download, 1 Mbps upload/);
    await page.screenshot({ path: `${screenshots}/checkout-speed-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
});
