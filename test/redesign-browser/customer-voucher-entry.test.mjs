import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Use a voucher (#366, canvas: PhoneVoucher), signed in: the claim link, then
// "You're connected" with the voucher's own terms and Start browsing; no
// save-to-account card or "Sign in instead" (owner). Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

test("a signed-in customer uses an Unlimited voucher and sees the drawn done screen", { timeout: 180000 }, async (t) => {
  const secret = "redesign-voucher-entry", store = createStore({ persistent: false }), now = new Date();
  const voucher = (id, code, fields) => ({ id, code, status: "available", customerId: null, usedBytes: 0, generatedByAdmin: true, saleType: "sale", createdAt: now.toISOString(), ...fields });
  await store.transaction((s) => {
    seedCatalogue(s, now);
    for (const [id, phone, token] of [["c-amina", "670001245", "amina"], ["c-paul", "670002468", "paul"], ["c-awa", "670003579", "awa"]]) {
      s.customers.push({ id, name: id.slice(2), phone, pinHash: "fixture", passkeys: [], createdAt: now.toISOString() });
      s.dashboardSessions.push({ id: `${token}-session`, customerId: id, tokenHash: hashSecret(token, secret), csrfToken: `${token}-csrf`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    s.vouchers.push(voucher("v-unlimited", "NC-K7PM-42XQ", { planId: "unlimited-7d-1", quotaBytes: null, deviceLimit: 1, accessType: "personal_unlimited", deviceSlots: 1, faceValue: 2500 }),
      voucher("v-two", "NC-M3VX-7KQD", { planId: "unlimited-24h-2", quotaBytes: null, deviceLimit: 2, accessType: "personal_unlimited", deviceSlots: 2, faceValue: 900 }),
      voucher("v-weekly", "NC-W5GB-7DAY", { planId: "weekly", quotaBytes: 5e9, deviceLimit: 1, faceValue: 1000 }));
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = "/tmp/ndahi-voucher-entry";
  await mkdir(screenshots, { recursive: true });
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png` });
  };
  const open = async (token, { lang } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: lang === "fr" ? "fr-FR" : "en-US" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: token, url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => { try { localStorage.setItem("ndahi-lang", "fr"); } catch {} });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/dashboard#redeem`);
    await page.locator("#redeem input[name=code]").waitFor();
    return { context, page, errors };
  };

  // The form: the claim link as drawn, no "Sign in instead".
  const { context, page, errors } = await open("amina");
  const claim = page.getByRole("link", { name: "Someone bought this for your number? Claim it with your number →" });
  assert.equal(await claim.getAttribute("href"), "/claim.html");
  assert.equal(await page.getByText("Have an account? Sign in instead").count(), 0);
  await check(page, "form");

  // A code works: the drawn done screen with the voucher's own terms.
  await page.locator("#redeem input[name=code]").fill("k7pm42xq");
  await page.getByRole("button", { name: "Activate and connect" }).click();
  await page.getByRole("heading", { name: "You're connected", level: 1 }).waitFor();
  assert.equal(await text(page.locator(".portal-redeem__done-line")), "Voucher K7PM-42XQ is active: unlimited data for 7 days on 1 device.");
  assert.equal(await page.getByRole("link", { name: "Start browsing" }).getAttribute("href"), "/dashboard#home");
  assert.equal(await page.getByText("Save to my account").count(), 0, "signed in: no save-to-account card (owner)");
  assert.equal(await page.locator("#differentCode").isVisible(), false);
  await check(page, "done");
  assert.equal((await store.snapshot()).vouchers.find((v) => v.id === "v-unlimited").status, "active");

  // Coming back to the page shows an empty form again.
  await page.goto(`${portal}/dashboard#home`);
  await page.goto(`${portal}/dashboard#redeem`);
  await page.locator("#redeem input[name=code]").waitFor();
  assert.equal(await page.locator("#redeemDone").isVisible(), false);
  assert.equal(await page.locator("#redeem input[name=code]").inputValue(), "");
  assert.deepEqual(errors, []);
  await context.close();

  // French, two device slots and a day.
  const fr = await open("paul", { lang: "fr" });
  await fr.page.locator("#redeem input[name=code]").fill("M3VX-7KQD");
  await fr.page.locator("#redeem > button").click();
  await fr.page.getByRole("heading", { name: "Vous êtes connecté", level: 1 }).waitFor();
  assert.equal(await text(fr.page.locator(".portal-redeem__done-line")), "Le ticket M3VX-7KQD est actif : données illimitées pendant 1 jour sur 2 appareils.");
  await check(fr.page, "done-fr");
  assert.deepEqual(fr.errors, []);
  await fr.context.close();

  // A fixed-data voucher keeps its own terms.
  const legacy = await open("awa");
  await legacy.page.locator("#redeem input[name=code]").fill("NC-W5GB-7DAY");
  await legacy.page.getByRole("button", { name: "Activate and connect" }).click();
  await legacy.page.getByRole("heading", { name: "You're connected", level: 1 }).waitFor();
  assert.equal(await text(legacy.page.locator(".portal-redeem__done-line")), "Voucher W5GB-7DAY is active: 5 GB for 7 days on 1 device.");
  assert.deepEqual(legacy.errors, []);
  await legacy.context.close();
});
