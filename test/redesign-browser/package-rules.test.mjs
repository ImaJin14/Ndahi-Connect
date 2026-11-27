import assert from "node:assert/strict";
import test from "node:test";
import { createStaticServer } from "../../static-server.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Package rules exactly as drawn (#360, canvas PhoneBillingTerms; owner 27 Nov):
// the bar with its line, the rows without chevrons, "Use it until it expires.
// Data is unlimited." and the PIN note at the foot of the screen.

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));

test("Package rules reads as drawn: Unlimited copy, the bar's line, the PIN note at the foot", { timeout: 120000 }, async (t) => {
  const site = await listen(createStaticServer("customer", { apiUrl: "http://127.0.0.1:9", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } }));
  const portal = `http://127.0.0.1:${site.address().port}`;
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise((r) => { site.close(r); site.closeAllConnections(); }); });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => (new URL(route.request().url()).origin === portal ? route.continue() : route.abort("blockedbyclient")));
  await page.goto(portal + "/billing-terms.html");

  assert.equal(await page.locator("h1").textContent(), "Payments and package rules");
  assert.deepEqual(await page.locator("h1").evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight]), ["26px", "600"]);
  assert.equal(await page.locator(".portal-static__bar").evaluate((el) => getComputedStyle(el).borderBottomWidth), "1px");
  await page.getByRole("heading", { name: "While a bundle is active" }).click();
  assert.deepEqual(await page.locator(".portal-rule").nth(1).locator("li").allTextContents(),
    ["Use it until it expires. Data is unlimited. You can't buy or switch packages before then.", "After that, buy any package at its full price — there's no partial credit."]);
  assert.equal(await page.locator(".portal-rule__chevron").first().isVisible(), false, "rows without chevrons, as drawn");
  assert.deepEqual(await page.locator(".portal-rule summary").allInnerTexts(), ["Buying and renewing", "While a bundle is active", "Interrupted or pending payments", "Cancellation and refunds", "Receipts and help"], "the five drawn rows, no Full rules");
  // Collapsed again, the PIN note sits 18px above the foot of the screen.
  await page.getByRole("heading", { name: "While a bundle is active" }).click();
  const pin = await page.locator(".portal-rules__pin").boundingBox();
  assert.equal(Math.round(pin.y + pin.height), 844 - 18);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
