import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { recordVerifiedMethod } from "../lib/authentication-migration.mjs";
import { hashSecret, totpCode, totpSecret } from "../lib/security.mjs";

// Real HTTP APIs and static apps, isolated in-memory accounts, local WebAuthn.
// These checks never read production credentials, contact providers or routers.
setDefaultResultOrder("ipv4first");
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const customerServer = http.createServer(), adminServer = http.createServer();
await listen(customerServer); await listen(adminServer);
const portal = `http://localhost:${customerServer.address().port}`, admin = `http://localhost:${adminServer.address().port}`;
const secret = "authentication-migration-browser-tests", password = "Synthetic admin password 81!", pin = "2468", newPin = "8176", factorSecret = totpSecret();
const store = createStore({ persistent: false });
let now = new Date(), started = Date.now();
const clock = () => new Date(+now + Date.now() - started);
const apiServer = createServer({ store, validateConfig: false, now: clock, env: {
  NODE_ENV: "production", CUSTOMER_APP_URL: portal, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin,
  CUSTOMER_SESSION_SECRET: secret, ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret,
  SESSION_COOKIE_SECURE: "false", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "warn",
} });
await listen(apiServer);
const api = `http://localhost:${apiServer.address().port}`, origins = new Set([api, portal, admin]);
const customerAssets = createStaticServer("customer", { apiUrl: api }), adminAssets = createStaticServer("admin", { apiUrl: api });
customerServer.on("request", (req, res) => customerAssets.emit("request", req, res));
adminServer.on("request", (req, res) => adminAssets.emit("request", req, res));
await store.transaction(async (s) => {
  s.customers = [{ id: "customer-81", name: "Migration Customer", phone: "670050181", pinHash: await argon2.hash(pin), totpSecret: factorSecret, passkeys: [], createdAt: clock().toISOString() }];
  s.dashboardSessions.push({ id: "migration-browser", customerId: "customer-81", tokenHash: hashSecret("migration-browser", secret), csrfToken: "csrf", expiresAt: new Date(+clock() + 86400000).toISOString(), createdAt: clock().toISOString() });
  s.vouchers.push({ id: "voucher-81", customerId: "customer-81", code: "NC-MIGR-8181", status: "active", planId: "family", quotaBytes: 1e9, usedBytes: 100, deviceLimit: 3, routerSyncStatus: "synchronized", activatedAt: clock().toISOString(), expiresAt: new Date(+clock() + 86400000).toISOString() });
  s.adminUsers.push({ id: "owner-81", username: "owner", displayName: "Migration Owner", passwordHash: await argon2.hash(password), role: "owner", active: true, passkeys: [], createdAt: clock().toISOString() });
  s.adminSessions.push({ userId: "owner-81", role: "owner", tokenHash: hashSecret("migration-owner", secret), csrfToken: "admin-csrf", expiresAt: new Date(+clock() + 86400000).toISOString(), createdAt: clock().toISOString() });
});
const baseline = await store.snapshot(), screenshots = "/tmp/ndahi-authentication-migration-checks";
let browser, checks = 0;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  await mkdir(screenshots, { recursive: true });
  async function scenario(name, work, { noPin = false, deniedStorage = false, unsupportedPasskeys = false, adminUser = false } = {}) {
    now = new Date(); started = Date.now();
    await store.transaction((s) => { Object.assign(s, structuredClone(baseline)); if (noPin) delete s.customers[0].pinHash; });
    const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
    const urls = [], errors = [];
    await context.addInitScript(({ deniedStorage, unsupportedPasskeys }) => {
      window.migrationStorageWrites = [];
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) { window.migrationStorageWrites.push([key, String(value)]); return original.call(this, key, value); };
      if (deniedStorage) for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(window, name, { get() { throw new DOMException("Storage denied", "SecurityError"); } });
      if (unsupportedPasskeys) Object.defineProperty(window, "PublicKeyCredential", { value: undefined });
    }, { deniedStorage, unsupportedPasskeys });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url()); urls.push(url);
      return origins.has(url.origin) ? route.continue() : route.abort("blockedbyclient");
    });
    await context.addCookies([{ name: adminUser ? "admin_session" : "customer_session", value: adminUser ? "migration-owner" : "migration-browser", domain: "localhost", path: adminUser ? "/api/admin" : "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", (error) => errors.push(error.message));
    try {
      await work({ page, context, urls });
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const writes = JSON.stringify(await page.evaluate(() => window.migrationStorageWrites || []));
      for (const sensitive of [newPin, password, factorSecret]) { assert.equal(writes.includes(sensitive), false); for (const url of urls) assert.equal((url.search + url.hash).includes(sensitive), false); }
      console.log(`PASS ${name}`); checks++;
    } catch (error) { await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  const migration = (page) => page.locator("[data-authentication-migration]");
  async function openCustomer(page) { await page.goto(portal + "/dashboard#account"); await migration(page).getByRole("heading", { name: "Prepare PIN & passkey access" }).waitFor(); await migration(page).locator("form").waitFor(); }
  async function preparePin(page) {
    const area = migration(page);
    await area.getByLabel("New four-digit PIN", { exact: true }).fill(newPin);
    await area.getByLabel("Confirm new PIN", { exact: true }).fill(newPin);
    await area.getByLabel("Current authenticator code", { exact: true }).fill(totpCode(factorSecret, +clock()));
    await area.getByRole("button", { name: "Verify existing access and prepare PIN" }).click();
    await area.getByLabel("Re-enter new four-digit PIN", { exact: true }).waitFor();
    assert.equal(await area.locator('input[name="newPin"]').count(), 0);
  }
  async function virtualKey(page, context, adminUser = false) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = publicKey.export({ format: "jwk" });
    const cose = Buffer.concat([Buffer.from("a5010203262001215820", "hex"), Buffer.from(jwk.x, "base64url"), Buffer.from("225820", "hex"), Buffer.from(jwk.y, "base64url")]);
    const id = randomBytes(32);
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { credentialId: id.toString("base64"), isResidentCredential: false, rpId: "localhost", privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), signCount: 0 } });
    await store.transaction((s) => { (adminUser ? s.adminUsers[0] : s.customers[0]).passkeys = [{ id: id.toString("base64url"), publicKey: cose.toString("base64url"), counter: 0, transports: ["internal"], createdAt: clock().toISOString() }]; });
    return { cdp, authenticatorId };
  }
  await scenario("PIN-less authenticator account verifies a new PIN, keeps the old factor and actually signs in with the new PIN at 320px with storage denied", async ({ page, context }) => {
    await openCustomer(page); await preparePin(page);
    assert.equal((await store.snapshot()).customers[0].pinHash, undefined);
    await migration(page).getByLabel("Re-enter new four-digit PIN", { exact: true }).fill(newPin);
    await migration(page).getByRole("button", { name: "Confirm and verify new PIN" }).click();
    await migration(page).getByText("Your new PIN is verified and ready for sign-in. Your authenticator remains available during preparation.", { exact: true }).waitFor();
    const state = await store.snapshot();
    assert.equal(state.customers[0].totpSecret, factorSecret);
    assert.equal(await argon2.verify(state.customers[0].pinHash, newPin), true);
    assert.ok(state.customers[0].authMigration.methods.pin);
    assert.equal(await migration(page).locator('input[type="password"]').first().inputValue(), "");
    await page.goto("about:blank"); await context.clearCookies();
    await page.goto(portal + "/login?account=1");
    await page.locator('#login [name="phone"]').fill("670050181"); await page.locator('#login [name="code"]').fill("NC-MIGR-8181");
    await page.locator("#loginSubmit").click(); await page.locator("#customerPin").waitFor({ state: "visible" }); await page.locator("#customerPin").fill(newPin); await page.locator("#loginSubmit").click();
    await page.waitForURL(/\/dashboard#account$/); await migration(page).getByText(/Verified replacement: PIN/).waitFor();
    assert.ok((await store.snapshot()).securityEvents.some((e) => e.type === "customer.access.succeeded"));
  }, { noPin: true, deniedStorage: true });
  await scenario("cancelled and expired PIN migration intents never establish a credential and leave support recovery discoverable", async ({ page }) => {
    await openCustomer(page); await preparePin(page);
    await migration(page).getByRole("button", { name: "Cancel PIN setup", exact: true }).click();
    await migration(page).getByText("PIN setup cancelled. Your existing sign-in methods remain available.", { exact: true }).waitFor();
    assert.equal((await store.snapshot()).customers[0].pinHash, undefined);
    now = new Date(+clock() + 95000); started = Date.now();
    await preparePin(page); now = new Date(+clock() + 601000); started = Date.now();
    await migration(page).getByLabel("Re-enter new four-digit PIN", { exact: true }).fill(newPin);
    await migration(page).getByRole("button", { name: "Confirm and verify new PIN" }).click();
    await migration(page).getByText("PIN setup expired or your credentials changed. Cancel the pending setup, then verify existing access again.", { exact: true }).waitFor();
    assert.equal((await store.snapshot()).customers[0].pinHash, undefined);
    await migration(page).getByRole("link", { name: /audited support recovery/ }).waitFor();
  }, { noPin: true });
  await scenario("lost confirmation response recovers the committed verified PIN without resending credentials", async ({ page }) => {
    await openCustomer(page); await preparePin(page);
    let confirmations = 0;
    await page.route("**/api/account/authentication-migration/pin/confirm", async (route) => {
      confirmations++;
      const result = await route.fetch(); assert.equal(result.status(), 200);
      await route.abort("failed");
    }, { times: 1 });
    await migration(page).getByLabel("Re-enter new four-digit PIN", { exact: true }).fill(newPin);
    await migration(page).getByRole("button", { name: "Confirm and verify new PIN" }).click();
    await migration(page).getByText("A verified PIN is now configured. Existing methods remain available. Sign in with your current PIN to check access.", { exact: true }).waitFor();
    assert.equal(confirmations, 1);
    assert.equal(await argon2.verify((await store.snapshot()).customers[0].pinHash, newPin), true);
  }, { noPin: true });
  await scenario("existing PIN verification recovers from an invalid proof and temporary status failure without passkeys", async ({ page }) => {
    await page.route("**/api/account/authentication-migration/status", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic unavailable readiness" }) }), { times: 1 });
    await page.goto(portal + "/dashboard#account"); await migration(page).getByText("Service temporarily unavailable", { exact: true }).waitFor();
    await migration(page).getByRole("button", { name: "Refresh sign-in readiness" }).click();
    await migration(page).getByLabel("Current four-digit PIN", { exact: true }).fill("1111");
    await migration(page).getByRole("button", { name: "Verify PIN for future sign-in" }).click();
    await migration(page).getByText("Unable to continue", { exact: true }).waitFor();
    await migration(page).getByLabel("Current four-digit PIN", { exact: true }).fill(pin);
    // The real account PIN throttle enforces a minimum delay after failure.
    now = new Date(+clock() + 2000); started = Date.now();
    await migration(page).getByRole("button", { name: "Verify PIN for future sign-in" }).click();
    await migration(page).getByText("Your PIN was verified for future sign-in. Existing methods remain available.", { exact: true }).waitFor();
    assert.equal(await migration(page).getByRole("button", { name: "Verify passkey for future sign-in" }).count(), 0);
    assert.equal(await migration(page).locator("[data-migration-message]").evaluate((el) => el === document.activeElement), true);
  }, { unsupportedPasskeys: true });
  await scenario("real browser user-verified passkey assertion verifies access and a cancelled prompt offers PIN fallback", async ({ page, context }) => {
    await virtualKey(page, context); await openCustomer(page);
    await migration(page).getByRole("button", { name: "Verify passkey for future sign-in" }).click();
    await migration(page).getByText("Your passkey was verified for future sign-in. Existing methods remain available.", { exact: true }).waitFor();
    assert.ok(Object.values((await store.snapshot()).customers[0].authMigration.methods).some((m) => m.method === "passkey"));
    await page.evaluate(() => { window.SimpleWebAuthnBrowser.startAuthentication = async () => { throw new DOMException("Cancelled synthetic prompt", "NotAllowedError"); }; });
    await migration(page).getByRole("button", { name: "Verify passkey for future sign-in" }).click();
    await migration(page).getByText("Passkey verification was not completed. Try again or use your PIN, current authenticator, or audited support recovery.", { exact: true }).waitFor();
    await migration(page).getByLabel("Current four-digit PIN", { exact: true }).fill(pin);
    await migration(page).getByRole("button", { name: "Verify PIN for future sign-in" }).click();
    await migration(page).getByText("Your PIN was verified for future sign-in. Existing methods remain available.", { exact: true }).waitFor();
  });
  await scenario("PIN-less account uses a real existing passkey to establish and verify a new PIN without an authenticator code", async ({ page, context }) => {
    await virtualKey(page, context); await openCustomer(page);
    await migration(page).getByLabel("New four-digit PIN", { exact: true }).fill(newPin); await migration(page).getByLabel("Confirm new PIN", { exact: true }).fill(newPin);
    await migration(page).getByRole("button", { name: "Prepare PIN with passkey" }).click();
    await migration(page).getByLabel("Re-enter new four-digit PIN", { exact: true }).fill(newPin);
    await migration(page).getByRole("button", { name: "Confirm and verify new PIN" }).click();
    await migration(page).getByText("Your new PIN is verified and ready for sign-in. Your authenticator remains available during preparation.", { exact: true }).waitFor();
    assert.equal(await argon2.verify((await store.snapshot()).customers[0].pinHash, newPin), true);
  }, { noPin: true });
  await scenario("administrator verifies password and real passkey while owner report exposes only aggregate readiness", async ({ page, context }) => {
    await virtualKey(page, context, true); await page.goto(admin + "/dashboard#connections");
    const area = page.locator("[data-admin-authentication-migration]");
    await area.getByLabel("Current administrator password", { exact: true }).fill("wrong password");
    await area.getByRole("button", { name: "Verify administrator password" }).click();
    await area.getByText("Verify your current admin password or passkey.", { exact: true }).waitFor();
    assert.ok(page.url().includes("dashboard"));
    await area.getByLabel("Current administrator password", { exact: true }).fill(password); await area.getByRole("button", { name: "Verify administrator password" }).click();
    await area.getByText("Your administrator password was verified. Existing methods remain available.", { exact: true }).waitFor();
    await area.getByRole("button", { name: "Verify administrator passkey" }).click();
    await area.getByText("Your administrator passkey was verified. Existing methods remain available.", { exact: true }).waitFor();
    await area.getByText("Authentication readiness report", { exact: true }).click();
    await area.getByText("Authenticator retirement is not ready.", { exact: true }).waitFor();
    const report = await area.locator("[data-admin-migration-counts]").textContent();
    for (const value of ["670050181", "Migration Customer", factorSecret, "customer-81", "owner-81"]) assert.equal(report.includes(value), false);
    assert.ok((await store.snapshot()).adminUsers[0].authMigration.methods.password);
    assert.equal(await area.locator('input[name="password"]').inputValue(), "");
  }, { adminUser: true });
  await scenario("owner records completed synthetic evidence only after method verification; review does not activate retirement", async ({ page }) => {
    await store.transaction((s) => recordVerifiedMethod(s.customers[0], "pin", null, secret, clock()));
    await page.goto(admin + "/dashboard#connections");
    const area = page.locator("[data-admin-authentication-migration]");
    await area.getByText("Authentication readiness report", { exact: true }).click();
    const review = area.locator("[data-readiness-review]");
    await review.waitFor();
    assert.equal(await review.getByRole("button", { name: "Record completed checks with password" }).isDisabled(), true);
    await area.getByLabel("Current administrator password", { exact: true }).fill(password);
    await area.getByRole("button", { name: "Verify administrator password" }).click();
    await area.getByText("Your administrator password was verified. Existing methods remain available.", { exact: true }).waitFor();
    assert.equal(await review.locator('[type="checkbox"]:checked').count(), 0);
    await review.getByLabel("Tested compatible rollback commit", { exact: true }).fill("b".repeat(40));
    await review.getByLabel("Private operations evidence reference", { exact: true }).fill("SYNTHETIC-LOCAL-PILOT-82");
    await review.getByLabel("Owner password for this review", { exact: true }).fill(password);
    await review.getByRole("button", { name: "Record completed checks with password" }).click();
    assert.equal((await store.snapshot()).zone.authenticationMigrationReview, undefined);
    await review.getByLabel("I completed real customer and administrator authentication and sensitive-action checks.", { exact: true }).check();
    await review.getByLabel("I completed recovery and compatible rollback checks.", { exact: true }).check();
    await review.getByRole("button", { name: "Record completed checks with password" }).click();
    await area.getByText("Completed checks recorded for the current inventory. Authenticator retirement still requires a separately authorized cutover.", { exact: true }).waitFor();
    assert.equal((await store.snapshot()).zone.authenticationMigrationReview.evidenceReference, "SYNTHETIC-LOCAL-PILOT-82");
    assert.equal((await store.snapshot()).zone.authenticatorRetirement, undefined);
    assert.equal(await review.locator('input[name="reviewPassword"]').inputValue(), "");
    assert.equal(await review.locator('[type="checkbox"]:checked').count(), 0);
  }, { adminUser: true });
  await scenario("stale owner report cannot attest a changed inventory and refresh clears review fields", async ({ page }) => {
    await store.transaction((s) => { recordVerifiedMethod(s.customers[0], "pin", null, secret, clock()); recordVerifiedMethod(s.adminUsers[0], "password", null, secret, clock()); });
    await page.goto(admin + "/dashboard#connections");
    const area = page.locator("[data-admin-authentication-migration]");
    await area.getByText("Authentication readiness report", { exact: true }).click();
    const review = area.locator("[data-readiness-review]"); await review.waitFor();
    await review.getByLabel("Tested compatible rollback commit", { exact: true }).fill("b".repeat(40));
    await review.getByLabel("Private operations evidence reference", { exact: true }).fill("SYNTHETIC-STALE-82");
    await review.getByLabel("Owner password for this review", { exact: true }).fill(password);
    await review.getByLabel("I completed real customer and administrator authentication and sensitive-action checks.", { exact: true }).check();
    await review.getByLabel("I completed recovery and compatible rollback checks.", { exact: true }).check();
    await store.transaction((s) => { s.customers[0].status = "suspended"; });
    await review.getByRole("button", { name: "Record completed checks with password" }).click();
    await area.getByText("The readiness report changed. Refresh and review the current report before recording evidence.", { exact: true }).waitFor();
    assert.equal((await store.snapshot()).zone.authenticationMigrationReview, undefined);
    assert.equal(await review.getByLabel("Owner password for this review", { exact: true }).inputValue(), "");
    await area.getByRole("button", { name: "Refresh readiness report" }).click();
    await area.getByText("Readiness report refreshed.", { exact: true }).waitFor();
    assert.equal(await review.getByLabel("Private operations evidence reference", { exact: true }).inputValue(), "");
    assert.equal(await review.locator('[type="checkbox"]:checked').count(), 0);
  }, { adminUser: true });
  await scenario("owner review uses a real signed passkey, cancellation preserves evidence and offers password fallback", async ({ page, context }) => {
    await virtualKey(page, context, true);
    await store.transaction((s) => { recordVerifiedMethod(s.customers[0], "pin", null, secret, clock()); recordVerifiedMethod(s.adminUsers[0], "password", null, secret, clock()); });
    await page.goto(admin + "/dashboard#connections");
    const area = page.locator("[data-admin-authentication-migration]");
    await area.getByText("Authentication readiness report", { exact: true }).click();
    const review = area.locator("[data-readiness-review]"); await review.waitFor();
    await review.getByLabel("Tested compatible rollback commit", { exact: true }).fill("c".repeat(40));
    await review.getByLabel("Private operations evidence reference", { exact: true }).fill("SYNTHETIC-SIGNED-REVIEW-82");
    await review.getByLabel("I completed real customer and administrator authentication and sensitive-action checks.", { exact: true }).check();
    await review.getByLabel("I completed recovery and compatible rollback checks.", { exact: true }).check();
    await page.evaluate(() => { window.originalReviewAuthentication = window.SimpleWebAuthnBrowser.startAuthentication; window.SimpleWebAuthnBrowser.startAuthentication = async () => { throw new DOMException("Synthetic cancel", "NotAllowedError"); }; });
    await review.getByRole("button", { name: "Record completed checks with passkey" }).click();
    await area.getByText("Review passkey verification was cancelled. Try again or use your owner password.", { exact: true }).waitFor();
    assert.equal((await store.snapshot()).zone.authenticationMigrationReview, undefined);
    await page.evaluate(() => { window.SimpleWebAuthnBrowser.startAuthentication = window.originalReviewAuthentication; });
    await review.getByRole("button", { name: "Record completed checks with passkey" }).click();
    await area.getByText("Completed checks recorded for the current inventory. Authenticator retirement still requires a separately authorized cutover.", { exact: true }).waitFor();
    assert.equal((await store.snapshot()).zone.authenticationMigrationReview.evidenceReference, "SYNTHETIC-SIGNED-REVIEW-82");
    assert.equal((await store.snapshot()).zone.authenticatorRetirement, undefined);
  }, { adminUser: true });
  console.log(`PASS ${checks} authentication migration browser journeys`);
} finally {
  await browser?.close(); await Promise.all([close(apiServer), close(customerServer), close(adminServer)]);
}
