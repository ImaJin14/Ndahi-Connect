import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// A live store offer on the Wi-Fi sign-in page (#345; owner, 27 Nov: the
// Promotions preview says "and on the Wi-Fi sign-in page while it's live"):
// the portal Home's countdown banner under the lede, linking to the deal;
// nothing before the offer starts. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const secret = "redesign-wifi-offer";
const words = { en: "Router", fr: "Routeur" };

test("the Wi-Fi sign-in page shows a live offer's banner, and nothing before it starts", { timeout: 240000 }, async (t) => {
  const store = createStore({ persistent: false });
  let now = new Date("2026-12-02T09:00:00Z");
  await store.transaction((s) => {
    storeState(s);
    seedCatalogue(s, now);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", warranty: words, returns: words,
      promotions: [{ id: "cyber", enabled: true, version: 1, name: { en: "Cyber Monday", fr: "Cyber Monday" }, terms: words, productIds: ["ax1500"], salePrice: 100000, perNumberLimit: 1,
        startsAt: "2026-12-03T00:00:00.000Z", endsAt: "2026-12-06T00:00:00.000Z", bonus: { bundleId: "unlimited-30d-1", validityHours: 720, startsAt: "customer_start", givenAt: "collection", startWithinDays: 60 } }] };
    s.storeProducts.push({ id: "ax1500", version: 1, stock: 6, sku: "AX1500", name: { en: "TP-Link AX1500", fr: "TP-Link AX1500" }, description: words, specifications: words, compatibility: words,
      contents: words, warranty: words, setup: words, images: [], price: 120000, cost: 1, status: "published", featured: false, categoryId: "" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const staticServer = await listen(createStaticServer("customer", { apiUrl: api, hotspotLoginUrl: "https://hotspot.example.test/login", env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${staticServer.address().port}`;
  const apiServer = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false",
    SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(staticServer); });
  const visit = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/hotspot?mac=AA%3ABB%3ACC%3ADD%3AEE%3A05&address=10.20.0.50`);
    await page.getByRole("heading", { name: "Connect to the internet.", exact: true }).waitFor();
    return { context, page, errors };
  };

  // Before it starts: nothing on the Wi-Fi page.
  let { context, page, errors } = await visit();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator(".portal-hotspot__promo").count(), 0, "only while it's live");
  assert.deepEqual(errors, []);
  await context.close();

  // Live: the banner under the lede, counting down to the end, linking to the deal.
  now = new Date("2026-12-04T09:00:00Z");
  ({ context, page, errors } = await visit());
  const offer = page.locator(".portal-hotspot__promo .portal-promo");
  await offer.waitFor();
  assert.equal(await page.locator("#hotspotLede + .portal-hotspot__promo").count(), 1, "under the lede");
  assert.match((await offer.innerText()).replace(/\s+/g, " "), /^CYBER MONDAY ENDS IN 100,000 FCFA \+ a month of Unlimited free\. TP-Link AX1500 0\d days 1\d hours \d\d minutes Ends Sun 6 Dec · 1 per phone number See the offer$/);
  assert.equal(await offer.getByRole("link", { name: "See the offer" }).getAttribute("href"), "/dashboard#product/ax1500");
  assert.deepEqual(await lowContrastText(page), [], "contrast");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await page.screenshot({ path: "/tmp/ndahi-wifi-offer.png", fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});
