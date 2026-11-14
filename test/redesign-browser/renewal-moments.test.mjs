import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Home's renewal moments (#252, canvas: PhoneRenew): running low, ending soon
// and ended, each with its title, card, next step, tip and billing link; the
// reminder switch saves the bundle-updates preference and Buy again offers the
// same Mobile Money number at checkout. Local servers only, synthetic customers.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const ZONE = "Africa/Douala", FAR = "2099-01-01T00:00:00.000Z";
const hours = (n) => new Date(Date.now() + n * 36e5).toISOString();
const day = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: ZONE });
const time = (at) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: ZONE });

test("Home shows each renewal moment as on the canvas and acts on it", { timeout: 180000 }, async (t) => {
  const secret = "redesign-renewal-moments", store = createStore({ persistent: false });
  const soonEnds = hours(20), endedAt = hours(-1);
  await store.transaction((s) => {
    const customer = (id, phone) => {
      s.customers.push({ id, name: "Amina Nfor", phone, email: `${id}@example.test`, emailVerifiedAt: hours(-200), passkeys: [] });
      s.dashboardSessions.push({ id: `${id}-session`, customerId: id, tokenHash: hashSecret(id, secret), csrfToken: `${id}-csrf`, expiresAt: FAR });
    };
    const bundle = (id, customerId, planId, extra) => s.vouchers.push({ id, customerId, planId, code: `NC-${id.toUpperCase()}`, status: "active", deviceLimit: planId === "family" ? 3 : 1,
      quotaBytes: planId === "family" ? 50e9 : 5e9, routerSyncStatus: "synchronized", ...extra });
    customer("c-low", "670031245"); bundle("v-low", "c-low", "weekly", { usedBytes: 4e9, activatedAt: hours(-48), expiresAt: hours(120) });
    customer("c-soon", "670041245"); bundle("v-soon", "c-soon", "weekly", { usedBytes: 2.6e9, activatedAt: hours(-148), expiresAt: soonEnds });
    customer("c-plain", "670061245"); bundle("v-plain", "c-plain", "weekly", { usedBytes: 1.8e9, activatedAt: hours(-48), expiresAt: hours(120) });
    customer("c-ended", "670051245"); bundle("v-ended", "c-ended", "family", { status: "expired", usedBytes: 30e9, activatedAt: hours(-721), expiresAt: endedAt, paymentId: "pay-ended" });
    s.payments.push({ id: "pay-ended", customerId: "c-ended", status: "paid", amount: 10000, currency: "XAF", provider: "mesomb", providerReference: "pay-ended-ref", network: "mtn",
      payerPhone: "237670001245", planId: "family", planSnapshot: { id: "family", name: "Connect Family", price: 10000 }, createdAt: hours(-722), confirmedAt: hours(-721) });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const staticServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${staticServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
    PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(staticServer); });
  const screenshots = "/tmp/ndahi-renewal-moments";
  await mkdir(screenshots, { recursive: true });

  const open = async (customerId, width = 390) => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, timezoneId: ZONE });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: customerId, url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" },
      { name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/dashboard#home`);
    await page.locator("#dataBalance [data-bundle-status]").waitFor();
    return { context, page, errors };
  };
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };
  const card = (page) => page.getByRole("region", { name: "Active bundle" });

  // Running low: four fifths of 5 GB used.
  {
    const { context, page, errors } = await open("c-low");
    await page.getByRole("heading", { name: "Running low.", level: 1 }).waitFor();
    assert.match(await text(card(page)), /WEEKLY|Weekly/);
    assert.equal(await text(card(page).locator("[data-bundle-status]")), "1 GB left");
    assert.equal(await text(card(page).locator(".home-card__figure")), "1.0 GB of 5 GB left");
    assert.match(await text(card(page).locator(".home-renew__note")), /^Ends \d{1,2} [A-Z][a-z]{2}, or sooner when the data runs out\.$/);
    assert.equal(await card(page).locator("progress").getAttribute("value"), "20.0", "the meter shows the fifth that is left");
    const remind = card(page).getByRole("checkbox", { name: "Remind me the moment it ends" });
    await page.waitForFunction(() => document.querySelector("[data-renew-remind]") && !document.querySelector("[data-renew-remind]").disabled);
    assert.equal(await remind.isChecked(), true, "bundle updates are on by default");
    const tip = page.getByRole("region", { name: "Make it last" });
    assert.equal(await text(tip), "Make it last Videos and app updates use the most data. Turn off auto-updates on mobile data, or set videos to 480p.");
    assert.equal(await page.getByRole("link", { name: "Why can't I buy while a bundle is active?" }).getAttribute("href"), "/billing-terms.html");
    for (const hidden of ["Enter voucher", "Bundle details"]) assert.equal(await page.getByRole("link", { name: hidden }).isVisible(), false, `${hidden} gives way to the moment on phones`);
    await check(page, "low-data-390");
    await remind.uncheck();
    await page.waitForFunction(() => !document.querySelector("[data-renew-remind]").disabled);
    const prefs = (await store.snapshot()).notificationStates.find((row) => row.id === "preferences:customer:c-low");
    assert.equal(prefs?.subscriptionUpdates, false, "the switch saves the bundle-updates preference");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Ends soon: a Weekly bundle with 20 hours and 2.4 GB left.
  {
    const { context, page, errors } = await open("c-soon");
    const today = day(soonEnds) === day(Date.now()), word = today ? "today" : "tomorrow";
    await page.getByRole("heading", { name: today ? "Ends today." : "Ends tomorrow.", level: 1 }).waitFor();
    assert.equal(await text(card(page).locator("[data-bundle-status]")), today ? "Ends today" : "Ends tomorrow");
    assert.equal(await text(card(page).locator(".home-card__figure")), `2.4 GB left · ends ${time(soonEnds)} ${word}`);
    assert.equal(await text(card(page).locator(".home-renew__note")), `Unused data doesn't carry over. Use it before ${time(soonEnds)} ${word}.`);
    await card(page).getByRole("checkbox", { name: "Remind me the moment it ends" }).waitFor();
    assert.equal(await text(page.getByRole("region", { name: "Next bundle" })), "Next bundle When it ends we'll show a one-tap button to buy Weekly again with the same Mobile Money number.");
    await check(page, "ends-soon-390");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // An ordinary bundle: no moment.
  {
    const { context, page, errors } = await open("c-plain");
    await page.getByRole("heading", { name: "Welcome back, Amina", level: 1 }).waitFor();
    assert.equal(await page.locator("#renewTip").isVisible(), false);
    assert.equal(await page.locator("#renewActions > *").count(), 0);
    await page.getByRole("link", { name: "Bundle details" }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Ended an hour ago: buy the same bundle again with the same number, on phone and desktop.
  for (const width of [1280, 390]) {
    const { context, page, errors } = await open("c-ended", width);
    await page.getByRole("heading", { name: "Your bundle ended.", level: 1 }).waitFor();
    assert.equal(await text(card(page).locator("[data-bundle-status]")), "Ended");
    const when = day(endedAt) === day(Date.now()) ? "today" : "yesterday";
    assert.equal(await text(card(page).locator(".home-card__figure")), `0 GB ended ${when} at ${time(endedAt)}`);
    assert.equal(await text(card(page).locator(".home-renew__note")), "Buy again and you're back online straight away on this device.");
    const buy = card(page).getByRole("button", { name: "Buy Connect Family again 10,000 FCFA · MTN MoMo 6•• •• 12 45", exact: true });
    await buy.waitFor();
    await card(page).getByRole("link", { name: "Choose a different plan", exact: true }).waitFor();
    assert.equal(await text(page.getByRole("region", { name: "Buying for the family?" })), "Buying for the family? A bundle covers up to 3 devices.");
    assert.equal(await page.locator("#bundlePurchaseActions").isVisible(), false, "the card's buttons replace the purchase row");
    await check(page, `ended-${width}`);
    if (width === 390) {
      await buy.click();
      await page.waitForURL(/\/onboarding\.html\?action=renew&plan=family&quick=1&payer=pay-ended$/);
      const form = page.locator("#purchase");
      await page.waitForFunction(() => document.querySelector("#purchase [name=payerPhone]")?.value === "670001245");
      assert.equal(await form.locator("[name=network]").inputValue(), "mtn", "the same network as last time");
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
