import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Forgot PIN (canvas: PhoneForgotPin, #399; owner 26 Nov): the request with the
// number typed on Sign in, "No email on your account? Visit <the shop> with your
// ID, or contact support.", "Check your email" with Send again, "Reset your PIN"
// from the emailed link (4 to 6 digits) and "PIN changed". A support code (from
// Admin's PIN recovery) still resets the PIN; account backup codes are gone.
// Local servers only, synthetic data, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

// A reset challenge as the server stores one (a new request or a reset clears the earlier ones).
const challengeFor = (secret, now) => (id, value, extra = {}) => ({ id, customerId: "amina", tokenHash: hashSecret(value, secret), used: false, attempts: 0,
  createdAt: now.toISOString(), expiresAt: new Date(+now + 900000).toISOString(), ...extra });
test("Forgot PIN walks the drawn steps, takes 4 to 6 digits, and keeps the support code", { timeout: 150000 }, async (t) => {
  const secret = "redesign-forgot-pin", store = createStore({ persistent: false }), now = new Date();
  const token = "reset-token-0123456789abcdef", support = "support-code-0123456789abcdef", challenge = challengeFor(secret, now);
  await store.transaction(async (s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, pickup: "Bandja Street" };
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", emailVerifiedAt: now.toISOString(), pinHash: await argon2.hash("2468") });
    s.pinResetChallenges.push(challenge("link", token));
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
  const screenshots = process.env.PHONE_FORGOT_PIN_SCREENSHOTS || "/tmp/ndahi-phone-forgot-pin";
  await mkdir(screenshots, { recursive: true });
  const open = async (path, { lang = "en", forgotPhone } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    if (forgotPhone) await context.addInitScript((phone) => { try { sessionStorage.setItem("ndahi-forgot-phone", phone); } catch {} }, forgotPhone);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + path);
    return { page, errors, context };
  };
  const pinHash = async () => (await store.snapshot()).customers[0].pinHash;

  // The emailed link: the token leaves the address bar; 4 to 6 digits.
  const link = await open(`/forgot-pin?token=${token}`);
  await link.page.locator("#confirmReset:not([hidden])").waitFor();
  assert.equal(new URL(link.page.url()).search, "");
  assert.equal(await link.page.locator(".forgot-hint").innerText(), "4 to 6 digits. Avoid your birth year or 1234.");
  assert.equal(await link.page.locator("#newPin").getAttribute("maxlength"), "6");
  await link.page.locator("#newPin").fill("135790");
  await link.page.locator('#resetConfirm [name="confirmPin"]').fill("135791");
  await link.page.locator("#resetConfirm button").click();
  await link.page.getByText("The two PINs don't match.").waitFor();
  await link.page.locator('#resetConfirm [name="confirmPin"]').fill("135790");
  await link.page.locator("#resetConfirm button").click();
  await link.page.locator("#resetDone:not([hidden]) h1", { hasText: "PIN changed" }).waitFor();
  assert.equal(await link.page.locator("#resetDone p").innerText(), "For safety, we signed you out on every other device.");
  assert.equal(await link.page.locator("#resetDone a").getAttribute("href"), "/login");
  assert.equal(await argon2.verify(await pinHash(), "135790"), true);
  await link.page.screenshot({ path: `${screenshots}/done.png` });
  assert.deepEqual(link.errors, []);
  await link.context.close();

  // The support code (Admin's PIN recovery) resets the PIN and moves to "PIN changed".
  await store.transaction((s) => { s.pinResetChallenges.push(challenge("support", support, { source: "support" })); });
  const code = await open("/forgot-pin");
  await code.page.locator("#forgotNote:not(:empty)").waitFor();
  await code.page.getByText("Use a support recovery code", { exact: true }).click();
  await code.page.locator('#supportReset [name="token"]').fill(support);
  await code.page.locator('#supportReset [name="pin"]').fill("97531");
  await code.page.locator('#supportReset [name="confirmPin"]').fill("97531");
  await code.page.locator('#supportReset [type="submit"]').click();
  await code.page.locator("#resetDone:not([hidden]) h1", { hasText: "PIN changed" }).waitFor();
  assert.equal(await argon2.verify(await pinHash(), "97531"), true, "5 digits are fine");

  assert.deepEqual(code.errors, []);
  await code.context.close();

  // The request, with the number typed on Sign in and the shop's place.
  const { page, errors, context } = await open("/forgot-pin", { forgotPhone: "670001245" });
  await page.locator("#forgotNote", { hasText: "Bandja Street" }).waitFor();
  assert.equal(await page.locator("#recoveryTitle").innerText(), "Forgot your PIN?");
  assert.equal(await page.locator(".forgot-lede").innerText(), "We'll email a reset link to the address saved on your account.");
  assert.equal(await page.locator('#resetRequest [name="phone"]').inputValue(), "670001245");
  assert.equal(await page.locator("#forgotNote").innerText(), "No email on your account? Visit Bandja Street with your ID, or contact support.");
  assert.equal(await page.locator("#forgotNote a").getAttribute("href"), "/help#support");
  assert.equal(await page.getByText("Use an account backup code").count(), 0, "backup codes are retired");
  assert.equal(await page.getByText("Use a support recovery code", { exact: true }).count(), 1);
  assert.equal(await page.locator("footer, .help-link").count(), 0, "no footer note or help link");
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/ask.png` });
  // Send → Check your email → Send again.
  await page.locator("#resetRequest button").click();
  await page.locator("#resetSent:not([hidden]) h1", { hasText: "Check your email" }).waitFor();
  assert.equal(await page.locator("#resetSent p").innerText(), "If this number has an email saved, a reset link is on its way. It works once and expires in 15 minutes.");
  assert.equal(await page.getByText("I opened the link").count(), 0);
  await page.screenshot({ path: `${screenshots}/sent.png` });
  await page.locator("#sendAgain").click();
  await page.locator("#requestReset:not([hidden])").waitFor();
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  const fr = await open("/forgot-pin", { lang: "fr" });
  await fr.page.locator("#forgotNote:not(:empty)").waitFor();
  assert.equal(await fr.page.locator("#recoveryTitle").innerText(), "PIN oublié ?");
  assert.equal(await fr.page.locator("#resetRequest button").innerText(), "Envoyer le lien");
  await fr.context.close();
});
