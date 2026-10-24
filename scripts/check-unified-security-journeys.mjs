import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { setDefaultResultOrder } from "node:dns";
import argon2 from "argon2";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture } from "../test/helpers/wifi-pairing-fixture.mjs";
import { securityKey } from "../test/helpers/customer-security-key.mjs";
setDefaultResultOrder("ipv4first");
const staticServer = http.createServer(); await new Promise(r => staticServer.listen(0, "127.0.0.1", r));
const portal = `http://localhost:${staticServer.address().port}`, f = await pairingFixture({ origin: portal, liveClock: true, now: new Date() });
const api = f.api.replace("127.0.0.1", "localhost"), assets = createStaticServer("customer", { apiUrl: api });
staticServer.on("request", (req, res) => assets.emit("request", req, res));
const baseline = await f.store.snapshot(), screenshots = "/tmp/ndahi-unified-security-checks";
let browser, checks = 0;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  await mkdir(screenshots, { recursive: true });
  async function scenario(name, work, { width = 390, unsupported = false, blockedStorage = false } = {}) {
    await f.store.transaction(s => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width, height: 950 } }), errors = [], page = await context.newPage();
    page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await context.addInitScript(({ unsupported, blockedStorage }) => {
      if (unsupported) Object.defineProperty(window, "PublicKeyCredential", { value: undefined });
      if (blockedStorage) for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(window, key, { get() { throw new DOMException("Storage denied", "SecurityError"); } });
    }, { unsupported, blockedStorage });
    await context.route("**/*", route => [portal, api].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    await context.addCookies([{ name: "customer_session", value: "main", domain: "localhost", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    try { await work({ page, context }); assert.deepEqual(errors, []); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); console.log(`PASS ${name}`); checks++; }
    catch (error) { await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  async function open(page, panel = "pin") {
    await page.goto(portal + "/dashboard#account"); await page.locator("#securityManager>summary").click();
    await page.locator(`[data-security-panel="${panel}"]`).click();
  }
  async function virtualKey(page, context, { seed = false, noPin = false } = {}) {
    const cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    if (seed) {
      const key = securityKey();
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { credentialId: Buffer.from(key.record.id, "base64url").toString("base64"), isResidentCredential: false, rpId: "localhost", privateKey: key.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), signCount: 0 } });
      await f.store.transaction(s => { if (noPin) delete s.customers[0].pinHash; s.customers[0].passkeys = [key.record]; });
    }
    return { cdp, authenticatorId };
  }
  async function pinChange(page, current = "2468") {
    await page.locator('#changePin [name="currentPin"]').fill(current);
    await page.locator('#changePin [name="newPin"]').fill("5830"); await page.locator('#changePin [name="confirmPin"]').fill("5830");
  }
  const success = (page, text) => page.locator("#securityMessage").getByText(text, { exact: true }).waitFor();
  for (const width of [320,390,768,1280]) await scenario(`one security entry and no duplicate recovery card at ${width}px`, async ({ page }) => {
    await page.goto(portal + "/dashboard#account"); await page.getByRole("heading", { name: "PIN & passkeys", exact: true }).waitFor();
    assert.equal(await page.locator("#accountRecovery").count(), 0); assert.equal(await page.locator("#securityManager").evaluate(node => node.open), false);
    assert.equal(await page.locator("#addCustomerPasskey").isVisible(), false);
    await page.getByText("Manage PIN / Passkey", { exact: true }).click();
    for (const panel of ["pin", "passkeys", "recovery"]) { await page.locator(`[data-security-panel="${panel}"]`).click(); assert.equal(await page.locator(`[data-security-content="${panel}"]`).isVisible(), true); }
    assert.equal(await page.getByRole("link", { name: "Recover a forgotten PIN", exact: true }).getAttribute("href"), "/forgot-pin");
    assert.doesNotMatch(await page.locator("#accountSecurity").textContent(), /TOTP|MFA|authenticator|Wi-Fi approval code/i);
    await page.screenshot({ path: `${screenshots}/security-${width}.png`, fullPage: true });
  }, { width });
  await scenario("PIN failure keeps fields, success rotates sessions and preserves manager/focus", async ({ page }) => {
    await open(page); await pinChange(page, "1111"); await page.getByRole("button", { name: "Change PIN with PIN", exact: true }).click();
    await page.locator("#changePin [data-proof-message]").getByText("Unable to continue", { exact: true }).waitFor();
    assert.equal(await page.locator('#changePin [name="newPin"]').inputValue(), "5830"); f.advance(2);
    await page.locator('#changePin [name="currentPin"]').fill("2468"); await page.getByRole("button", { name: "Change PIN with PIN", exact: true }).click();
    await success(page, "PIN changed. Other portal sessions and previous account backup codes were revoked.");
    assert.equal(await page.locator("#securityManager").evaluate(node => node.open), true);
    assert.equal(await page.locator("#securityMessage").evaluate(node => node === document.activeElement), true);
    assert.equal(await argon2.verify((await f.store.snapshot()).customers[0].pinHash, "5830"), true);
  });
  await scenario("real passkey enrollment, rename and removal use the same confirmation/status experience", async ({ page, context }) => {
    await virtualKey(page, context); await open(page, "passkeys"); await page.locator("#addCustomerPasskey").click();
    await page.locator('[data-passkey-owner-proof] [name="pin"]').fill("2468"); await page.getByRole("button", { name: "Confirm with PIN", exact: true }).click(); await success(page, "Passkey added.");
    await page.locator(".rename-passkey>summary").click(); await page.locator('[data-rename-passkey] [name="label"]').fill("My phone"); await page.getByRole("button", { name: "Save name", exact: true }).click(); await success(page, "Passkey renamed.");
    await page.locator("[data-remove-passkey]").click(); await page.locator('[data-passkey-owner-proof] [name="pin"]').fill("2468"); await page.getByRole("button", { name: "Confirm with PIN", exact: true }).click(); await success(page, "Passkey removed.");
    assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 0);
  });
  await scenario("passkey changes a PIN despite invalid leftover PIN input", async ({ page, context }) => {
    await virtualKey(page, context, { seed: true }); await open(page); await pinChange(page, "bad");
    await page.getByRole("button", { name: "Change PIN with passkey", exact: true }).click(); await success(page, "PIN changed. Other portal sessions and previous account backup codes were revoked.");
  });
  await scenario("cancelled passkey keeps PIN fallback and explicit Cancel clears proof and restores focus", async ({ page, context }) => {
    await virtualKey(page, context, { seed: true }); await open(page); await pinChange(page);
    await page.addScriptTag({ url: portal + "/vendor/webauthn.js" });
    await page.evaluate(() => { window.SimpleWebAuthnBrowser.startAuthentication = async () => { throw new DOMException("Cancelled", "NotAllowedError"); }; });
    await page.getByRole("button", { name: "Change PIN with passkey", exact: true }).click(); await page.getByText("Passkey not completed. Use your PIN or try your passkey again.", { exact: true }).waitFor();
    assert.equal((await f.store.snapshot()).customers[0].pinFailedAttempts || 0, 0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal(await page.locator("#securityManager").evaluate(node => node.open), false);
    assert.equal(await page.locator('#changePin [name="newPin"]').inputValue(), "");
    await page.locator("#securityManager>summary").click(); await pinChange(page); await page.getByRole("button", { name: "Change PIN with PIN", exact: true }).click(); await success(page, "PIN changed. Other portal sessions and previous account backup codes were revoked.");
  });
  await scenario("last passkey remains usable and recovery is reachable after rejection", async ({ page, context }) => {
    await virtualKey(page, context, { seed: true, noPin: true }); await open(page, "passkeys"); await page.locator("[data-remove-passkey]").click();
    await page.getByRole("button", { name: "Confirm with passkey", exact: true }).click(); await page.locator("[data-proof-message]").filter({ hasText: "replacement" }).waitFor();
    assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 1);
    await page.locator('[data-security-panel="recovery"]').click(); await page.getByRole("link", { name: "Recover a forgotten PIN", exact: true }).click(); await page.waitForURL("**/forgot-pin");
  });
  await scenario("unsupported passkey and blocked storage leave PIN and recovery usable", async ({ page }) => {
    await open(page); await page.getByText(/Passkeys are unavailable in this browser/).waitFor(); assert.equal(await page.locator("#addCustomerPasskey").isVisible(), false);
    await pinChange(page); await page.getByRole("button", { name: "Change PIN with PIN", exact: true }).click(); await success(page, "PIN changed. Other portal sessions and previous account backup codes were revoked.");
    await page.locator('[data-security-panel="recovery"]').click(); await page.getByRole("link", { name: "Recover a forgotten PIN", exact: true }).waitFor();
  }, { unsupported: true, blockedStorage: true });
  for (const action of ["passkey", "pin", "backup"]) await scenario(`lost ${action} reply is reconciled through a receipt without repeating its mutation`, async ({ page, context }) => {
    let requests = 0;
    const path = action === "passkey" ? "/api/account/passkeys/verify" : action === "pin" ? "/api/account/security/pin" : "/api/account/security/account-backup/generate";
    await page.route("**" + path, async route => { requests++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.fulfill({ response, body: "{lost JSON" }); });
    if (action === "passkey") {
      await virtualKey(page, context); await open(page, "passkeys"); await page.locator("#addCustomerPasskey").click(); await page.locator('[data-passkey-owner-proof] [name="pin"]').fill("2468"); await page.getByRole("button", { name: "Confirm with PIN", exact: true }).click(); await success(page, "Passkey added.");
    } else if (action === "pin") {
      await open(page); await pinChange(page); await page.getByRole("button", { name: "Change PIN with PIN", exact: true }).click(); await success(page, "PIN changed. Other portal sessions and previous account backup codes were revoked.");
    } else {
      await open(page, "recovery"); await page.locator("#backupCodeSettings>summary").click(); await page.locator('#accountBackup [name="currentPin"]').fill("2468"); await page.getByRole("button", { name: "Generate codes with PIN", exact: true }).click(); await page.locator("#securityMessage").getByText(/response was lost/).waitFor(); assert.equal(await page.locator("#accountBackupOutput code").count(), 0);
    }
    assert.equal(requests, 1);
  });
  await scenario("an unknown lost response offers refresh and sign-in without repeating the mutation", async ({ page, context }) => {
    let requests = 0;
    await page.route("**/api/account/passkeys/verify", async route => { requests++; const response = await route.fetch(); await route.fulfill({ response, body: "{lost JSON" }); });
    await page.route("**/api/account/security/actions/*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic status unavailable" }) }));
    await virtualKey(page, context); await open(page, "passkeys"); await page.locator("#addCustomerPasskey").click();
    await page.locator('[data-passkey-owner-proof] [name="pin"]').fill("2468"); await page.getByRole("button", { name: "Confirm with PIN", exact: true }).click();
    await page.getByText(/We could not confirm this change/).waitFor();
    assert.equal(await page.locator("#securityMessage").textContent(), "");
    await page.getByRole("link", { name: "Sign in with your current PIN or passkey", exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh security", exact: true }).click();
    await success(page, "Security refreshed. Review your current settings before trying again.");
    assert.equal(await page.locator("[data-remove-passkey]").count(), 1); assert.equal(requests, 1);
  });
  await scenario("backup codes stay private, download once and disappear on Escape with restored focus", async ({ page }) => {
    await open(page, "recovery"); await page.locator("#backupCodeSettings>summary").click(); await page.locator('#accountBackup [name="currentPin"]').fill("2468"); await page.getByRole("button", { name: "Generate codes with PIN", exact: true }).click();
    await page.getByRole("heading", { name: "Save your account backup codes", exact: true }).waitFor(); assert.equal(await page.locator("#accountBackupOutput code").count(), 5);
    const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Download codes", exact: true }).click(); assert.equal((await download).suggestedFilename(), "ndahi-account-backup-codes.txt");
    await page.keyboard.press("Escape"); assert.equal(await page.locator("#accountBackupOutput code").count(), 0); assert.equal(await page.locator("#securityManager>summary").evaluate(node => node === document.activeElement), true);
  });
  console.log(`PASS ${checks} unified security browser journeys`);
} finally {
  await browser?.close(); await f.close(); await new Promise(r => { staticServer.close(r); staticServer.closeAllConnections(); });
}
