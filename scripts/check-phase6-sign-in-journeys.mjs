// Phase 6 sign-in in the redesigned apps (canvas: AdminLogin, PhoneLogin).
// Admin: email + PIN, then the passkey; after the cutover an administrator
// without one adds it to finish. Customer: phone + PIN first, the voucher
// code as the second path. A synthetic store with a virtual authenticator;
// not rollout evidence.
import assert from "node:assert/strict";
import http from "node:http";
import { setDefaultResultOrder } from "node:dns";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture } from "../test/helpers/wifi-pairing-fixture.mjs";
import { lowContrastText } from "./ui-checks.mjs";

setDefaultResultOrder("ipv4first");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const customerServer = http.createServer(), adminServer = http.createServer();
await listen(customerServer); await listen(adminServer);
const portal = `http://localhost:${customerServer.address().port}`, admin = `http://localhost:${adminServer.address().port}`;
const pin = "482913", secret = "pairing-tests";
const f = await pairingFixture({ origin: portal, liveClock: true, now: new Date(), env: { ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, ADMIN_SESSION_SECRET: secret } });
const api = f.api.replace("127.0.0.1", "localhost"), origins = new Set([portal, admin, api]);
const customerAssets = createStaticServer("customer", { apiUrl: api }), adminAssets = createStaticServer("admin", { apiUrl: api });
customerServer.on("request", (req, res) => customerAssets.emit("request", req, res));
adminServer.on("request", (req, res) => adminAssets.emit("request", req, res));
await f.store.transaction(async (s) => {
  s.adminUsers.push({ id: "owner-p6", username: "owner", email: "owner@ndahi.test", displayName: "Owner", role: "owner", active: true, passwordHash: await argon2.hash(pin), passkeys: [] });
  // After the cutover every administrator signs in with a passkey.
  s.zone = { ...(s.zone || {}), authenticatorRetirement: { version: 1, retiredAt: new Date().toISOString() } };
});
const screenshots = "/tmp/ndahi-phase6-sign-in";
let browser, page, checks = 0;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  await mkdir(screenshots, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } }), errors = [];
  await context.addCookies([{ name: "ndahi_ui", value: "v2", domain: "localhost", path: "/" }]);
  await context.route("**/*", (route) => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const signIn = async (email, value) => {
    await page.goto(admin + "/login");
    await page.getByText("Step 1 of 2", { exact: true }).waitFor();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("PIN", { exact: true }).fill(value);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  };

  // A wrong PIN never reaches step 2.
  await signIn("owner@ndahi.test", "000000");
  await page.getByText("Invalid admin credentials.", { exact: true }).waitFor();
  assert.equal(await page.locator("#passkeyStep").isVisible(), false);
  console.log("PASS a wrong PIN stays on step 1"); checks++;

  // No passkey yet, after the cutover: add one to finish signing in.
  await signIn("owner@ndahi.test", pin);
  await page.getByRole("heading", { name: "Add a passkey to finish.", exact: true }).waitFor();
  await page.getByText("Step 2 of 2", { exact: true }).waitFor();
  assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
  await page.screenshot({ path: `${screenshots}/admin-passkey-setup-390.png`, fullPage: true });
  await page.getByRole("button", { name: "Add a passkey", exact: true }).click();
  await page.waitForURL(/\/dashboard/);
  assert.equal((await f.store.snapshot()).adminUsers.find((user) => user.id === "owner-p6").passkeys.length, 1);
  console.log("PASS an administrator without a passkey adds one to finish signing in"); checks++;

  // Next time: email + PIN, then confirm with that passkey.
  await context.clearCookies({ name: "admin_session" });
  await signIn("owner@ndahi.test", pin);
  await page.getByRole("heading", { name: "Confirm with your passkey.", exact: true }).waitFor();
  await page.getByText("Use your fingerprint, face or screen lock on this device or your phone.", { exact: true }).waitFor();
  await page.screenshot({ path: `${screenshots}/admin-passkey-step-390.png`, fullPage: true });
  await page.getByRole("button", { name: "Use a different account", exact: true }).click();
  await page.getByText("Step 1 of 2", { exact: true }).waitFor();
  await signIn("owner", pin); // The username still works in the email field.
  await page.getByRole("button", { name: "Use passkey", exact: true }).click();
  await page.waitForURL(/\/dashboard/);
  console.log("PASS email + PIN, then the passkey, opens the admin"); checks++;

  // Both sign-in steps at desktop width too (#245).
  await page.setViewportSize({ width: 1280, height: 900 });
  await context.clearCookies({ name: "admin_session" });
  await signIn("owner@ndahi.test", pin);
  await page.getByRole("heading", { name: "Confirm with your passkey.", exact: true }).waitFor();
  assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${screenshots}/admin-passkey-step-1280.png`, fullPage: true });
  await page.getByRole("button", { name: "Use passkey", exact: true }).click();
  await page.waitForURL(/\/dashboard/);
  console.log("PASS both sign-in steps at 390 and 1280"); checks++;

  // Support removes a customer's lost passkeys (canvas: AdminCustomerDetail):
  // the audited form, then fresh proof: the PIN at 390, the passkey at 1280.
  const customerId = (await f.store.snapshot()).customers[0].id;
  for (const [width, proof] of [[390, "pin"], [1280, "passkey"]]) {
    await f.store.transaction((s) => { s.customers[0].passkeys = [{ id: `lost-${width}`, publicKey: "lost-key", counter: 0, label: "Lost phone", createdAt: new Date().toISOString() }]; });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${admin}/dashboard#customer/${encodeURIComponent(customerId)}`);
    await page.getByRole("button", { name: "Remove lost passkeys", exact: true }).click();
    const form = page.locator("[data-authenticator-recovery]");
    await form.getByRole("heading", { name: "Remove lost passkeys", exact: true }).waitFor();
    await form.getByLabel("Support case reference").fill(`CASE-P6-${width}`);
    await form.getByLabel("Reason and verification notes").fill("Phone lost; identity checked at the office.");
    await form.getByLabel("I verified this customer's identity.").check();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/admin-remove-passkeys-${width}.png`, fullPage: true });
    await form.getByRole("button", { name: "Verify and remove passkeys", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Verify administrator action" });
    if (proof === "pin") {
      await dialog.getByLabel("Current administrator PIN").fill(pin);
      await dialog.getByRole("button", { name: "Verify PIN", exact: true }).click();
    } else await dialog.getByRole("button", { name: "Verify with passkey", exact: true }).click();
    await form.getByRole("heading", { name: "Passkeys removed", exact: true }).waitFor();
    assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 0);
  }
  console.log("PASS support removes a customer's lost passkeys with PIN or passkey proof at 390 and 1280"); checks++;

  // Customer sign-in leads with phone + PIN; the voucher code is the second path.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(portal + "/login");
  await page.getByRole("button", { name: "Use a voucher code", exact: true }).waitFor();
  assert.equal(await page.locator('#login [name="code"]').isVisible(), false);
  await page.getByRole("button", { name: "Use a voucher code", exact: true }).click();
  await page.locator('#login [name="code"]').waitFor();
  assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).isVisible(), true);
  await page.getByRole("button", { name: "Sign in with your PIN instead", exact: true }).click();
  assert.equal(await page.locator('#login [name="code"]').isVisible(), false);
  await page.locator('#login [name="phone"]').fill("670050001");
  await page.locator("#customerPin").fill("2468");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/dashboard/);
  console.log("PASS customers sign in with phone + PIN; the voucher code is the second path"); checks++;
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    // Leave the dashboard first: its signed-out redirect must not race this visit.
    await page.goto("about:blank");
    await context.clearCookies({ name: "customer_session" });
    await page.goto(portal + "/login");
    await page.locator("#customerPin").waitFor();
    assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/customer-login-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`${checks} Phase 6 sign-in journeys passed.`);
} catch (error) {
  // CI keeps this page for the failure artifact.
  await page?.screenshot({ path: `${screenshots}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await f.close?.();
  await Promise.all([close(customerServer), close(adminServer)]);
}
