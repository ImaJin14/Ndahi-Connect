import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { balanceOf } from "../../lib/rewards.mjs";

// Invited by a friend (#529, canvas: PhoneInvite), at /r/<code>: who invited
// you and the bonus, the code saved for this number's first checkout (Buy a
// bundle sends it; the friend's first payment pays both), "this number already
// has an account" when signed in, and an unknown code. English and French.
// Local servers only, synthetic data, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("an invitation shows who invited you and saves the code for the first checkout, which pays both; an account or an unknown code says so", { timeout: 180000 }, async (t) => {
  const secret = "redesign-invite", store = createStore({ persistent: false }), now = new Date();
  await store.transaction((s) => {
    seedCatalogue(s, now); s.catalogue.mode = "unlimited";
    s.rewardsSettings = { points: { enabled: true, enabledAt: "2025-09-01T00:00:00.000Z" }, referrals: { enabled: true, enabledAt: "2025-09-01T00:00:00.000Z" } };
    s.customers.push({ id: "amina", name: "Amina Ndi", phone: "+237670001245", referralCode: "AMINA-7K2", createdAt: "2026-09-01T08:00:00.000Z" });
    s.dashboardSessions.push({ id: "amina-session", customerId: "amina", tokenHash: hashSecret("amina-token", secret), csrfToken: "amina-csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const open = async (path, { signedIn = false, lang = "en" } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    if (signedIn) await context.addCookies([{ name: "customer_session", value: "amina-token", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => { try { localStorage.setItem("ndahi-lang", "fr"); } catch {} });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) errors.push(message.text()); });
    await page.goto(portal + path);
    await page.waitForSelector("body[data-invite-state]");
    return { page, errors, context };
  };
  const text = (page, selector) => page.locator(selector).innerText().then((x) => x.replace(/\s+/g, " ").trim());

  // A new visitor: who invited them, the bonus and the steps; the code is saved.
  const { page, errors } = await open("/r/AMINA-7K2");
  assert.equal(await page.evaluate(() => document.body.dataset.inviteState), "valid");
  assert.equal(await text(page, "#inviteTitle"), "Amina invited you to NDAHI Connect");
  assert.equal(await text(page, "#inviteLead"), "Get 100 bonus points after your first bundle — enough for a free 24-hour bundle.");
  assert.equal(await text(page, ".invite__code"), "Referral code AMINA-7K2 +100 points");
  assert.deepEqual((await page.locator(".invite__steps li").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim()), [
    "1 Connect to NDAHI Wi-Fi and choose a bundle.", "2 Pay with MTN MoMo or Orange Money from your own number. We set up your account with it.",
    "3 When the payment is confirmed, your 100 bonus points land in Rewards, ready to swap for bundles."]);
  assert.equal(await page.evaluate(() => localStorage.getItem("ndahi-referral")), "AMINA-7K2");
  assert.deepEqual([await text(page, "#inviteBuy"), await page.locator("#inviteBuy").getAttribute("href"), await text(page, "#inviteLogin"), await page.locator("#inviteLogin").getAttribute("href")],
    ["Choose my first bundle", "/onboarding.html", "I already have an account", "/login"]);
  const amina = await store.snapshot();
  assert.equal(JSON.stringify(await page.content()).includes("670001245"), false, "never the referrer's number");

  assert.deepEqual(errors, [], "the invitation itself logs nothing");
  // Choose my first bundle: the first checkout carries the code; the payment pays both.
  // (Buy a bundle's own signed-out requests are its own; only page errors count from here.)
  errors.length = 0;
  page.removeAllListeners("console");
  await page.locator("#inviteBuy").click();
  await page.waitForURL(/\/onboarding\.html$/);
  await page.locator("#phoneContinue:not([disabled])").waitFor();
  await page.getByRole("button", { name: "7 days" }).click();
  await page.getByRole("button", { name: "1 device, 2,500 XAF" }).click();
  await page.locator("#phoneContinue:not([disabled])").click();
  await page.getByRole("heading", { name: "Review and pay" }).waitFor();
  await page.getByRole("textbox", { name: "Mobile Money number", exact: true }).fill("690008821");
  const [sent] = await Promise.all([page.waitForRequest((request) => request.url() === `${api}/api/purchase` && request.method() === "POST"), page.locator("#requestPayment").click()]);
  assert.equal(sent.postDataJSON().referralCode, "AMINA-7K2");
  await page.getByRole("heading", { name: "Approve on your phone" }).waitFor();
  await page.getByRole("button", { name: "Simulate payment approval" }).click();
  let s;
  for (let i = 0; i < 40; i++) { s = await store.snapshot(); if (s.referrals?.[0]?.status === "paid") break; await page.waitForTimeout(250); }
  const kofi = s.customers.find((c) => c.phone.endsWith("690008821"));
  assert.equal(s.referrals[0].status, "paid");
  assert.deepEqual([balanceOf(s, "amina"), balanceOf(s, kofi.id)], [200, 100 + 25]);
  assert.equal(amina.customers.find((c) => c.id === "amina").referralCode, "AMINA-7K2");
  assert.deepEqual(errors, []);

  // Signed in: this number already has an account.
  const member = await open("/r/AMINA-7K2", { signedIn: true });
  assert.equal(await member.page.evaluate(() => document.body.dataset.inviteState), "notNew");
  assert.equal(await text(member.page, "#inviteLead"), "Prepaid community Wi-Fi. Unlimited data, paid with Mobile Money.");
  assert.equal(await text(member.page, ".invite__note"), "This number already has an NDAHI account, so the referral code can't be used. You still earn points on every bundle you buy.");
  assert.equal(await text(member.page, "#inviteBuy"), "Choose a bundle");
  assert.deepEqual(member.errors, []);

  // An unknown code.
  const unknown = await open("/r/NOBODY-2X9");
  assert.equal(await text(unknown.page, "#inviteTitle"), "Welcome to NDAHI Connect");
  assert.equal(await text(unknown.page, ".invite__note"), "We couldn't find this referral code. Check it with the friend who sent it, or continue without it.");
  assert.equal(await unknown.page.evaluate(() => localStorage.getItem("ndahi-referral")), null);
  assert.deepEqual(unknown.errors, []);

  // French.
  const fr = await open("/r/AMINA-7K2", { lang: "fr" });
  assert.equal(await text(fr.page, "#inviteTitle"), "Amina vous invite sur NDAHI Connect");
  assert.equal(await text(fr.page, "#inviteBuy"), "Choisir mon premier forfait");
  assert.deepEqual(fr.errors, []);
});
