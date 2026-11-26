import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Sign in (canvas: PhoneLogin, #405; owner 26 Nov): the back arrow to the
// hotspot page, phone with the +237 chip, PIN (4 to 6 digits) with Show and
// Forgot PIN? (which takes the typed number along), Sign in, "or", the passkey
// and voucher-code buttons, the Claim link, and "New to NDAHI? Buy your first
// bundle" at the foot. No Wi-Fi line, help link or footer note. Local servers
// only, synthetic data, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("Sign in is drawn as the board and signs in with a 6-digit PIN", { timeout: 150000 }, async (t) => {
  const secret = "redesign-sign-in", store = createStore({ persistent: false });
  await store.transaction(async (s) => {
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", pinHash: await argon2.hash("135790") });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = process.env.PHONE_SIGN_IN_SCREENSHOTS || "/tmp/ndahi-phone-sign-in";
  await mkdir(screenshots, { recursive: true });
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), bottom: Math.round(r.bottom), right: Math.round(r.right) }; });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(portal + "/login");
  await page.locator("#login").waitFor();
  // The drawn page and nothing more.
  assert.equal(await page.locator(".login-back").getAttribute("href"), "/hotspot");
  assert.deepEqual(await box(page.locator(".login-back")), { x: 10, y: 10, bottom: 54, right: 54 });
  assert.equal(await page.locator("#entryConnectivity, .help-link, footer").count(), 0, "no Wi-Fi line, help link or footer note");
  assert.equal(await page.locator("#loginTitle").innerText(), "Welcome back");
  assert.equal(await page.locator("#customerPin").getAttribute("maxlength"), "6");
  assert.equal(await page.locator("#useVoucherCode").evaluate((el) => getComputedStyle(el).borderTopWidth), "1px", "an outlined button");
  assert.equal(await page.locator("#claimLink").getAttribute("href"), "/claim.html");
  assert.equal((await box(page.locator(".new-customer"))).bottom, 844 - 22, "New to NDAHI at the foot");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${screenshots}/sign-in.png` });
  // "Use a voucher code" switches to the code path and back.
  await page.locator("#useVoucherCode").click();
  await page.locator("#codeLabel").waitFor({ state: "visible" });
  await page.locator("#usePinSignIn").click();
  await page.locator("#customerPin").waitFor({ state: "visible" });
  // Forgot PIN? takes the typed number along.
  await page.locator('#login [name="phone"]').fill("670001245");
  await page.locator("#forgotPin").click();
  await page.waitForURL(/\/forgot-pin$/);
  assert.equal(await page.locator('#resetRequest [name="phone"]').inputValue(), "670001245");
  // A 6-digit PIN signs in.
  await page.goto(portal + "/login");
  await page.locator('#login [name="phone"]').fill("670001245");
  await page.locator("#customerPin").fill("135790");
  await page.locator("#loginSubmit").click();
  await page.waitForURL(/\/dashboard/);
  assert.deepEqual(errors, []);
  await context.close();
});
