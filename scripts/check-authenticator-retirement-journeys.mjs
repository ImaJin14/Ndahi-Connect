import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture, mainMac } from "../test/helpers/wifi-pairing-fixture.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";
import { hashSecret, totpSecret } from "../lib/security.mjs";

// A synthetic retired store is an isolated browser fixture, not rollout evidence.
// The separate core/API tests verify that real cutover cannot bypass readiness.
setDefaultResultOrder("ipv4first");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const customerServer = http.createServer(), adminServer = http.createServer();
await listen(customerServer); await listen(adminServer);
const portal = `http://localhost:${customerServer.address().port}`, admin = `http://localhost:${adminServer.address().port}`;
const password = "Synthetic retained admin password 82!", legacySecret = totpSecret(), secret = "pairing-tests";
const f = await pairingFixture({ origin: portal, liveClock: true, now: new Date(), env: {
  ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, ADMIN_SESSION_SECRET: secret,
  ADMIN_MFA_ENABLED: "true", ADMIN_MFA_CODE: "123456",
} });
const api = f.api.replace("127.0.0.1", "localhost"), origins = new Set([portal, admin, api]);
const customerAssets = createStaticServer("customer", { apiUrl: api, hotspotLoginUrl: "https://wifi.example.test/login" }), adminAssets = createStaticServer("admin", { apiUrl: api });
customerServer.on("request", (req, res) => customerAssets.emit("request", req, res));
adminServer.on("request", (req, res) => adminAssets.emit("request", req, res));
await f.store.transaction(async (s) => {
  // Runtime retirement also applies to stores that have not run offline credential purge.
  delete s.zone.authenticatorRetirement;
  s.customers[0].totpSecret = legacySecret; // Stale material must never reactivate it.
  s.customers[0].recoveryCodes = [{ id: "old", hash: hashSecret("ABCD-2345", secret) }];
  s.customers[0].passkeys = [];
  s.adminUsers.push({ id: "owner-82", username: "owner", displayName: "Owner", role: "owner", active: true, passwordHash: await argon2.hash(password), passkeys: [] });
  s.adminProfile = { mfaEnabled: true, totpSecret: legacySecret };
  s.adminSessions.push({ userId: "owner-82", role: "owner", tokenHash: hashSecret("owner-82", secret), csrfToken: "admin-csrf", expiresAt: new Date(+f.now() + 86400000).toISOString() });
});
const baseline = await f.store.snapshot(), screenshots = "/tmp/ndahi-authenticator-retirement-checks";
let browser, checks = 0;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  await mkdir(screenshots, { recursive: true });
  async function scenario(name, work, { adminUser = false, noSession = false, unsupported = false, storageDenied = false } = {}) {
    await f.store.transaction((s) => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width: 320, height: 900 } }), errors = [], urls = [];
    await context.addInitScript(({ unsupported, storageDenied }) => {
      if (unsupported) Object.defineProperty(window, "PublicKeyCredential", { value: undefined });
      if (storageDenied) for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(window, key, { get() { throw new DOMException("Storage denied", "SecurityError"); } });
    }, { unsupported, storageDenied });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url()); urls.push(url);
      return origins.has(url.origin) ? route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }) : route.abort("blockedbyclient");
    });
    if (!noSession) await context.addCookies([{ name: adminUser ? "admin_session" : "customer_session", value: adminUser ? "owner-82" : "main", domain: "localhost", path: adminUser ? "/api/admin" : "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", (error) => errors.push(error.message));
    try {
      await work({ page, context });
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const url of urls) assert.equal((url.search + url.hash).includes(legacySecret), false);
      console.log(`PASS ${name}`); checks++;
    } catch (error) { await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  async function virtualKey(page, context, { seeded = false, noPin = false } = {}) {
    const cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    if (seeded) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = publicKey.export({ format: "jwk" }), id = randomBytes(32);
      const publicBytes = Buffer.concat([Buffer.from("a5010203262001215820", "hex"), Buffer.from(jwk.x, "base64url"), Buffer.from("225820", "hex"), Buffer.from(jwk.y, "base64url")]);
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { credentialId: id.toString("base64"), isResidentCredential: false, rpId: "localhost", privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), signCount: 0 } });
      await f.store.transaction((s) => { if (noPin) delete s.customers[0].pinHash; s.customers[0].passkeys = [{ id: id.toString("base64url"), publicKey: publicBytes.toString("base64url"), counter: 0, label: "Only passkey", transports: ["internal"], createdAt: f.now().toISOString() }]; });
    }
    return { cdp, authenticatorId };
  }
  for (const width of [320,390,768,1280]) await scenario(`Account groups profile, security, recovery and sessions with theme/language disabled at ${width}px`,async ({page})=>{
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:"dark"});
    await page.addInitScript(()=>{localStorage.setItem("ndahi-theme","dark");localStorage.setItem("ndahi-lang","fr");});
    await page.goto(portal+"/dashboard#account");await page.getByRole("heading",{name:"PIN & passkeys",exact:true}).waitFor();
    assert.equal(await page.locator("#themeToggle, .lang-switcher").count(),0);
    assert.equal(await page.locator("html").getAttribute("data-theme"),null);
    assert.equal(await page.locator("html").getAttribute("lang"),"en");
    const text=await page.locator(".account-layout").textContent();assert.doesNotMatch(text,/authenticator|2FA|MFA|Prepare PIN|sign-in readiness/i);
    for(const name of ["Your profile","Sessions & security notices"])await page.getByRole("heading",{name,exact:true}).waitFor();
    assert.equal(await page.locator('#accountSecurity [name="otp"], #changePhone [name="otp"], #linkEmail [name="otp"]').count(),0);
    const color=await page.evaluate(()=>getComputedStyle(document.body).backgroundColor);assert.notEqual(color,"rgb(11, 19, 16)");
    await page.screenshot({path:`${screenshots}/account-cleanup-${width}.png`,fullPage:true});
  });
  await scenario("retired customer security and main-device controls show PIN/passkey only while retaining collapsed Manage devices", async ({ page }) => {
    await page.goto(portal + "/dashboard#account");
    await page.getByRole("heading", { name: "PIN & passkeys", exact: true }).waitFor();
    const security = page.locator("#accountSecurity");
    assert.doesNotMatch(await security.textContent(), /authenticator|recovery codes|2FA|MFA/i);
    assert.equal(await page.locator('#account [name="otp"], #changePhone [name="otp"], #linkEmail [name="otp"], #changePin [name="otp"]').count(), 0);
    await page.goto(portal + "/dashboard#devices");
    const details = page.getByText("Manage devices", { exact: true }); await details.waitFor();
    if (!await page.locator("#manageDevices").evaluate((node) => node.open)) await details.click();
    await page.locator("[data-select-main]").click();
    await page.locator('[data-main-proof] [name="mac"]').selectOption(mainMac);
    await page.locator('[data-main-proof] [name="confirm"]').check();
    assert.equal(await page.locator('[data-main-proof] [name="otp"]').count(), 0);
    await page.locator('[data-main-proof] [name="pin"]').fill("2468");
    await page.locator('[data-main-proof] [type="submit"]').click();
    await page.getByText(/This browser controls connection approvals/).waitFor();
  });
  await scenario("customer registers and removes a real user-verified passkey with fresh PIN authorization", async ({ page, context }) => {
    await virtualKey(page, context); await page.goto(portal + "/dashboard#account");
    await page.locator("#securityManager>summary").click(); await page.locator('[data-security-panel="passkeys"]').click(); await page.locator("#addCustomerPasskey").click();
    const proof = page.locator("[data-passkey-owner-proof]");
    await proof.getByLabel("Current PIN", { exact: true }).fill("2468");
    await proof.getByRole("button", { name: "Confirm with PIN", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-remove-passkey]").length === 1);
    assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 1);
    await page.locator("[data-remove-passkey]").click();
    await proof.getByLabel("Current PIN", { exact: true }).fill("2468"); await proof.getByRole("button", { name: "Confirm with PIN", exact: true }).click();
    await page.getByText("Passkey removed.", { exact: true }).waitFor(); assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 0);
  });
  await scenario("last usable passkey cannot be removed without a verified replacement", async ({ page, context }) => {
    await virtualKey(page, context, { seeded: true, noPin: true }); await page.goto(portal + "/dashboard#account");
    await page.locator("#securityManager>summary").click(); await page.locator('[data-security-panel="passkeys"]').click();
    await page.locator("[data-remove-passkey]").click();
    await page.locator("[data-passkey-owner-proof]").getByRole("button", { name: "Confirm with passkey", exact: true }).click();
    await page.locator("#securityOwnerProof").getByText(/last|another|usable|replacement/i).first().waitFor();
    assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 1);
  });
  await scenario("cancelled passkey proof keeps the fresh PIN fallback usable for registration", async ({ page, context }) => {
    const { cdp, authenticatorId } = await virtualKey(page, context, { seeded: true }); await page.goto(portal + "/dashboard#account");
    await page.locator("#securityManager>summary").click(); await page.locator('[data-security-panel="passkeys"]').click(); await page.locator("#addCustomerPasskey").click();
    const proof = page.locator("[data-passkey-owner-proof]");
    // The library is loaded by the proof action; replace only its assertion
    // prompt, leaving the subsequent real registration ceremony intact.
    await page.addScriptTag({ url: portal + "/vendor/webauthn.js" });
    await page.evaluate(() => { window.SimpleWebAuthnBrowser.startAuthentication = async () => { throw new DOMException("Synthetic cancelled assertion", "NotAllowedError"); }; });
    await proof.getByRole("button", { name: "Confirm with passkey", exact: true }).click();
    await proof.getByText(/Passkey not completed.*Use your PIN/).waitFor();
    // Enroll on a different authenticator: WebAuthn correctly refuses creating
    // another copy on the authenticator that already holds an excluded key.
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await proof.getByLabel("Current PIN", { exact: true }).fill("2468"); await proof.getByRole("button", { name: "Confirm with PIN", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-remove-passkey]").length === 2);
    assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 2);
  });
  await scenario("retired customer login keeps PIN/passkey available when policy loading fails or passkeys are unsupported", async ({ page }) => {
    await page.route("**/api/authentication-policy", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic policy unavailable" }) }));
    await page.goto(portal + "/login?account=1");
    assert.equal(await page.locator("#authenticatorLogin").isVisible().catch(() => false), false);
    await page.locator('#login [name="phone"]').fill("670050001"); await page.locator('#login [name="code"]').fill("NC-AAAA-1111"); await page.locator("#loginSubmit").click();
    await page.locator("#customerPin").fill("2468"); await page.locator("#loginSubmit").click();
    await page.waitForURL(/\/dashboard#account$/); await page.getByRole("heading", { name: "PIN & passkeys", exact: true }).waitFor();
  }, { noSession: true, unsupported: true, storageDenied: true });
  await scenario("forgetting a saved main device accepts a real passkey despite invalid leftover PIN text",async({page,context})=>{
    await virtualKey(page,context,{seeded:true});await f.store.transaction(s=>approveDevice(s,"c1",{mac:mainMac},f.now(),"fixture"));
    await page.goto(portal+"/dashboard#devices");await page.getByRole("button",{name:"Forget device",exact:true}).first().click();
    const form=page.locator("[data-forget-proof]");await form.locator('[name="confirm"]').check();await form.locator('[name="pin"]').fill("bad");
    assert.equal(await form.locator('[name="otp"]').count(),0);await form.getByRole("button",{name:"Verify with passkey",exact:true}).click();
    await form.waitFor({state:"hidden"});assert.equal((await f.store.snapshot()).customers[0].wifiMainDevice,undefined);
  });
  await scenario("old cached authenticator challenge receives explicit retirement and exposes no secret or factor input", async ({ page }) => {
    await page.goto(portal + "/login");
    await page.locator("#authenticatorLogin").waitFor({ state: "detached" });
    await page.evaluate(() => sessionStorage.setItem("ndahi-login-challenge", JSON.stringify({ challengeId: "old-login", phone: "670050001", enrollmentRequired: true, secret: "OLD-CACHED-FACTOR-SECRET" })));
    await page.goto(portal + "/verify.html");
    await page.getByText(/retired.*PIN|PIN.*passkey/i).first().waitFor();
    assert.equal(await page.locator('#verify input[name="otp"], #verify input[name="recoveryCode"]').isVisible().catch(() => false), false);
    assert.equal((await page.locator("body").textContent()).includes("OLD-CACHED-FACTOR-SECRET"), false);
    const response = await f.call("/api/account/login/verify-authenticator", { challengeId: "old-login", otp: "123456" });
    assert.equal(response.status, 410); assert.equal(response.body.code, "AUTHENTICATOR_RETIRED");
  }, { noSession: true });
  await scenario("admin password signs in without MFA despite leftover environment/profile flags", async ({ page }) => {
    await page.goto(admin + "/login"); await page.getByLabel("Username").fill("owner"); await page.locator("#adminPassword").fill(password);
    await page.getByRole("button", { name: "Continue", exact: true }).click(); await page.waitForURL(/\/dashboard$/);
    assert.equal(await page.locator('#mfaLogin [name="mfaCode"]').count(), 0);
    const retired = await page.evaluate(async (api) => { const response = await fetch(api + "/api/admin/login/mfa", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: "old", mfaCode: "123456" }) }); return { status: response.status, body: await response.json() }; }, api);
    assert.equal(retired.status, 410); assert.equal(retired.body.code, "AUTHENTICATOR_RETIRED");
  }, { adminUser: true, noSession: true });
  await scenario("audited owner support recovery uses a fresh password and resets PIN without retired factor fields", async ({ page }) => {
    await page.goto(admin + "/dashboard#customers");
    await page.locator('[data-reset-authenticator="c1"]').click();
    const recovery = page.locator("[data-authenticator-recovery]");
    await recovery.getByLabel("Support case reference", { exact: true }).fill("CASE-82-BROWSER");
    await recovery.getByLabel("Reason and verification notes", { exact: true }).fill("Synthetic identity verified in person for isolated recovery test");
    await recovery.locator('[name="confirmedIdentity"]').check();
    assert.equal(await recovery.locator('[name="mfaCode"]').count(), 0);
    await recovery.getByRole("button", { name: "Verify and issue support code", exact: true }).click();
    const proof = page.getByRole("dialog", { name: "Verify administrator action" });
    await (proof.getByLabel("Current administrator PIN").or(proof.getByLabel("Current administrator password"))).fill(password);
    await (proof.getByRole("button", { name: "Verify PIN" }).or(proof.getByRole("button", { name: "Verify password" }))).click();
    await recovery.getByRole("heading", { name: "Support code issued", exact: true }).waitFor();
    const token = await recovery.locator("code").textContent();
    await page.goto(portal + "/forgot-pin");
    await page.locator("[data-legacy-authenticator]").waitFor({ state: "detached" });
    await page.getByText("Use a support recovery code", { exact: true }).click();
    await page.locator('#supportReset [name="token"]').fill(token);
    await page.locator('#supportReset [name="pin"]').fill("5830"); await page.locator('#supportReset [name="confirmPin"]').fill("5830");
    await page.getByRole("button", { name: "Recover with support code", exact: true }).click();
    await page.locator("#supportReset [data-recovery-message]").getByText(/PIN.*reset|sign in/i).first().waitFor();
    assert.equal(await argon2.verify((await f.store.snapshot()).customers[0].pinHash, "5830"), true);
    assert.ok((await f.store.snapshot()).auditLogs.some((record) => record.action === "customer.support_recovery.approved"));
  }, { adminUser: true });
  console.log(`PASS ${checks} authenticator retirement browser journeys`);
} finally {
  await browser?.close(); await f.close(); await Promise.all([close(customerServer), close(adminServer)]);
}
