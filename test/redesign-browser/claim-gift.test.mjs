import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { newReservation } from "../../lib/reservations.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Claiming a reserved voucher (#254, canvas: PhoneClaimGift, PhoneLogin,
// AdminVoucherDetail "waitingClaim"): sign-in links to the claim; a wrong
// number is refused; the right one creates an account with a PIN and starts
// the bundle; a slip's QR opens the claim with its code; staff see "Waiting
// for claim" and change the number. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();

test("a reserved bundle is claimed with its number and code, and staff can see and move it", { timeout: 180000 }, async (t) => {
  const secret = "redesign-claim-gift", store = createStore({ persistent: false });
  const voucher = (id, code, phone, by, note) => ({ id, planId: "weekly", code, status: "available", customerId: null, quotaBytes: 5e9, usedBytes: 0, deviceLimit: 1,
    generatedByAdmin: by.type === "admin", saleType: "gift", saleAmount: 0, faceValue: 1000, createdAt: ago(2), reservation: newReservation(phone, by, Date.parse(ago(2)), note) });
  await store.transaction((s) => {
    s.customers.push({ id: "c-amina", name: "Amina Nfor", phone: "670000001" });
    s.vouchers.push(voucher("v-friend", "NC-GIFT-0001", "670009910", { type: "customer", id: "c-amina" }, "For your calls with the family ❤"),
      voucher("v-ndahi", "NC-GIFT-0002", "670005703", { type: "admin", id: "claim-owner" }));
    s.auditLogs.unshift({ id: "a1", action: "voucher.generated", actor: "owner", meta: { voucherIds: ["v-ndahi"], quantity: 1, saleType: "gift", reservedFor: "6•• •• 57 03" }, at: ago(2) });
    s.adminUsers.push({ id: "claim-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "claim-owner", role: "owner", tokenHash: hashSecret("claim-owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`, admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); await close(adminServer); });
  const screenshots = "/tmp/ndahi-claim-gift";
  await mkdir(screenshots, { recursive: true });
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png` });
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Africa/Douala" });
  await context.route("**/*", (route) => [api, portal, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await context.addCookies([{ name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Sign-in links to the claim.
  await page.goto(`${portal}/login`);
  await page.getByRole("link", { name: "Someone gave you a bundle? Claim it" }).click();
  await page.waitForURL(/\/claim\.html$/);
  await page.getByRole("heading", { name: "Someone gave you a bundle?", level: 1 }).waitFor();
  assert.equal(await text(page.locator("#claimStep")), "Step 1 of 3");
  await check(page, "code");

  // A wrong number is refused with the canvas's message.
  await page.getByLabel("Your phone number").fill("670001111");
  await page.getByLabel("Code").fill("nc-gift-0001");
  await page.getByRole("button", { name: "Continue" }).click();
  const alert = page.getByRole("alert");
  await alert.filter({ hasText: "This code isn't for this number." }).waitFor();
  assert.equal(await text(alert), "This code isn't for this number. Check both with the person who gave it to you. After 5 wrong tries, wait 15 minutes.");
  await check(page, "wrong-number");
  assert.equal((await store.snapshot()).vouchers.find((v) => v.id === "v-friend").reservation.wrongAttempts, 1);

  // The right number: the friend's gift, then a new account with a PIN.
  await page.getByLabel("Your phone number").fill("670009910");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Set up your account to claim it" }).waitFor();
  assert.equal(await text(page.locator("#claimStep")), "Step 2 of 3");
  assert.equal(await text(page.getByRole("region", { name: "Your bundle" })),
    'A GIFT FROM AMINA N. Weekly is waiting for you 5 GB · 7 days · 1 device. The 7 days start when you choose. "For your calls with the family ❤"');
  await check(page, "setup");
  await page.getByLabel("Your name").fill("Mama Ngum");
  await page.getByLabel("Create a PIN").fill("1357");
  await page.getByLabel("Repeat PIN").fill("1357");
  await page.getByRole("button", { name: "Create account and claim" }).click();
  await page.getByRole("heading", { name: "It's yours, Mama Ngum" }).waitFor();
  assert.match(await text(page.locator(".claim__done-text")), /^Weekly is saved in your account\. Start it now on this phone, or keep it for later — it waits until \d{1,2} [A-Z][a-z]{2} \d{4}\.$/);
  assert.equal(await page.getByRole("link", { name: "Keep it for later" }).getAttribute("href"), "/dashboard#home");
  await check(page, "start");
  let saved = (await store.snapshot()).vouchers.find((v) => v.id === "v-friend");
  assert.deepEqual([saved.status, saved.reservation.status], ["available", "claimed"], "claimed and saved, not started");

  // Start now: the bundle starts on this phone.
  await page.getByRole("button", { name: "Start now and connect" }).click();
  await page.getByRole("heading", { name: "You're online" }).waitFor();
  assert.match(await text(page.locator(".claim__done-text")), /^Weekly started on this phone\. It ends \d{1,2} [A-Z][a-z]{2}, or when the 5 GB run out\.$/);
  assert.equal(await page.getByRole("link", { name: "Go to my home" }).getAttribute("href"), "/dashboard#home");
  await check(page, "online");
  saved = (await store.snapshot()).vouchers.find((v) => v.id === "v-friend");
  assert.equal(saved.status, "active");

  // A slip's QR opens the claim with its code filled in; NDAHI's gift says so.
  await page.goto(`${portal}/login?claim=NC-GIFT-0002`);
  await page.waitForURL(/\/claim\.html\?code=NC-GIFT-0002$/);
  assert.equal(await page.getByLabel("Code").inputValue(), "NC-GIFT-0002");
  await page.getByLabel("Your phone number").fill("670005703");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Set up your account to claim it" }).waitFor();
  assert.match(await text(page.getByRole("region", { name: "Your bundle" })), /^A GIFT FROM NDAHI Weekly is waiting for you/);
  await check(page, "setup-ndahi");
  assert.deepEqual(errors, []);
  await context.close();

  // Staff: "Waiting for claim", the number, days left and wrong tries; change the number.
  const staff = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await staff.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await staff.addCookies([{ name: "admin_session", value: "claim-owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
  const desk = await staff.newPage(), deskErrors = [];
  desk.on("pageerror", (error) => deskErrors.push(error.message));
  await desk.goto(`${admin}/dashboard#voucher/v-ndahi`);
  const reserved = desk.getByRole("region", { name: "Reserved for a number" });
  await reserved.waitFor();
  assert.match(await text(desk.locator("#voucherStatusHost")), /Waiting for claim/);
  assert.match(await text(reserved), /^Reserved for a number \+237 6•• •• 57 03 · no NDAHI account yet 88 days left to claim · until \d{1,2} [A-Z][a-z]{2} 0 wrong claim attempts Code \+ number both needed to claim Claimed automatically if this number pays/);
  assert.match(await text(desk.getByRole("region", { name: "History" })), /Created for \+237 6•• •• 57 03 by Owner.*Expires \d{1,2} [A-Z][a-z]{2} \d{4} if not claimed/);
  assert.match(await text(desk.getByRole("region", { name: "Details" })), /Customer 6•• •• 57 03 · no account yet.*Reserved for Phone number · given in person.*Router Waiting for redemption/);
  assert.deepEqual(await lowContrastText(desk), [], "contrast: staff");
  await desk.screenshot({ path: `${screenshots}/staff-waiting.png`, fullPage: true });
  await desk.getByRole("button", { name: "Change number" }).click();
  await desk.getByLabel("New phone number").fill("670005730");
  await desk.getByRole("button", { name: "Save number" }).click();
  await desk.getByText("Number changed to 6•• •• 57 30. The old number can no longer claim it. Logged in the audit trail.").waitFor();
  assert.equal((await store.snapshot()).vouchers.find((v) => v.id === "v-ndahi").reservation.phone, "670005730");
  await desk.screenshot({ path: `${screenshots}/staff-number-changed.png`, fullPage: true });
  assert.deepEqual(deskErrors, []);
  await staff.close();
});
