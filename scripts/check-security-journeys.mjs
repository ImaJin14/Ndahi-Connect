import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import jsQR from "jsqr";
import { totpCode } from "../lib/security.mjs";

// Isolated local fixtures: no .env, live payment, mail, router, or database access.
const apiPort = Number(process.env.SECURITY_API_PORT || 8298), portalPort = Number(process.env.SECURITY_PORT || 8297),
  api = `http://127.0.0.1:${apiPort}`, portal = `http://127.0.0.1:${portalPort}`;
const store = createStore({ persistent: false });
const server = createServer({
  store, now: () => new Date(),
  email: { configured: () => true, sendVoucher: async () => ({ messageId: "voucher" }) },
  env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, ADMIN_APP_URL: "http://127.0.0.1:1", ALLOWED_ADMIN_ORIGINS: "http://127.0.0.1:1",
    ADMIN_PIN: "9999",
  },
});
const website = createStaticServer("customer", { apiUrl: api });
const listen = (app, port) => new Promise((resolve, reject) => { app.once("error", reject); app.listen(port, "127.0.0.1", resolve); });
const close = (app) => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
const post = async (path, input, cookie = "") => {
  const response = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(input) });
  const json = await response.json(); assert.ok(response.ok, JSON.stringify(json));
  return { response, json };
};
let browser;
try {
  await listen(server, apiPort); await listen(website, portalPort);
  const p = await post("/api/purchase", { phone: "670050001", name: "Security Preview", email: "security-preview@example.test", planId: "weekly" });
  const paid = await post(`/api/payments/${p.json.payment.id}/confirm`, {});
  const login = await post("/api/account/setup/pin", { phone: "670050001", code: paid.json.access.code, pin: "2468", confirmPin: "2468" });
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const screenshots = process.env.SECURITY_SCREENSHOTS || "/tmp/ndahi-security-checks";
  await mkdir(screenshots, { recursive: true });
  let checks = 0;
  async function scenario(name, work, { cookie: cookieOverride = cookie } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: "customer_session", value: cookieOverride.split("=")[1], domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try { await work(page, context); assert.deepEqual(errors, []); console.log(`PASS ${name}`); checks++; }
    finally { await context.close(); }
  }
  await scenario("a second signed-in device is listed and can be signed out from the first", async (page, context) => {
    const second = await post("/api/account/login/pin", { phone: "670050001", pin: "2468" });
    const secondCookie = second.response.headers.get("set-cookie").split(";")[0];
    await page.goto(`${portal}/dashboard#account`);
    await page.locator("#sessionActivity summary").click();
    assert.equal(await page.locator("#sessionActivity .device").count(), 2);
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("#sessionActivity .device").filter({ hasNotText: "This device" })
      .getByRole("button", { name: "Sign out" }).click();
    await page.getByText("Session signed out.").waitFor();
    assert.equal(await page.locator("#sessionActivity .device").count(), 1);
    const dashboardStillWorks = await fetch(`${api}/api/account/dashboard`, { headers: { cookie: secondCookie } });
    assert.equal(dashboardStillWorks.status, 401, "the revoked (non-current) session must no longer authenticate");
    await page.locator("#accountSecurity").screenshot({ path: `${screenshots}/sessions-desktop.png` });
  });
  await scenario("a passkey can be renamed and removed, and removal alerts the account", async (page) => {
    await store.transaction((s) => {
      s.customers.find((c) => c.phone === "670050001").passkeys = [
        { id: "preview-key", publicKey: "pk", counter: 0, createdAt: new Date().toISOString(), label: "Passkey 1" },
      ];
    });
    await page.goto(`${portal}/dashboard#account`);
    await page.locator('details.rename-passkey:has(form[data-rename-passkey="preview-key"]) summary').click();
    await page.locator('[data-rename-passkey="preview-key"] input[name="label"]').fill("Work laptop");
    await page.locator('[data-rename-passkey="preview-key"]').getByRole("button", { name: "Save name" }).click();
    await page.getByText("Passkey renamed.").waitFor();
    await page.getByText("Work laptop").waitFor();
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByText("Passkey removed.").waitFor();
    assert.equal(await page.getByText("No passkeys enrolled yet.").count(), 1);
    const queued = (await store.snapshot()).securityAlerts;
    assert.ok(queued.some((a) => a.kind === "passkey_removed"), "removal must queue a security alert");
  });
  await scenario("cancelled and expired authenticator setups can be started again without enabling them", async (page) => {
    await page.goto(`${portal}/dashboard#account`);
    await page.getByRole("button", { name: "Enable authenticator 2FA" }).click();
    await page.locator("#confirmMfa").waitFor();
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    await page.getByText("Authenticator setup cancelled. You can start again whenever you choose.").waitFor();
    assert.equal((await store.snapshot()).customerMfaChallenges.length, 0);
    await page.getByRole("button", { name: "Enable authenticator 2FA" }).click();
    const key = await page.locator("#mfaSetup code").textContent();
    await store.transaction((s) => { s.customerMfaChallenges.forEach((c) => { c.expiresAt = new Date(Date.now() - 1000).toISOString(); }); });
    await page.getByLabel("Six-digit code").fill(totpCode(key, Date.now()));
    await page.getByRole("button", { name: "Confirm 2FA" }).click();
    await page.getByText("Authenticator setup expired or was replaced. Start setup again in this browser.", { exact: true }).waitFor();
    assert.equal(await page.locator("#mfaSetup code").count(), 0);
    await page.getByRole("button", { name: "Enable authenticator 2FA" }).click();
    await page.locator("#confirmMfa").waitFor();
    assert.equal((await store.snapshot()).customers[0].totpSecret, undefined);
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    await page.getByText("Authenticator setup cancelled. You can start again whenever you choose.").waitFor();
  });
  await scenario("a customer scans the setup QR, confirms authenticator sign-in and uses a recovery code", async (page) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${portal}/dashboard#account`);
    await page.getByRole("button", { name: "Enable authenticator 2FA" }).click();
    const secret = await page.locator("#mfaSetup code").textContent();
    const pixels = await page.locator("#mfaSetup img").evaluate(async (img) => {
      if (!img.complete) await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext("2d"); context.drawImage(img, 0, 0);
      return { width: canvas.width, height: canvas.height, rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
    });
    const decoded = jsQR(new Uint8ClampedArray(pixels.rgba), pixels.width, pixels.height);
    assert.ok(decoded, "the actual displayed QR image must be readable");
    const uri = new URL(decoded.data);
    assert.equal(uri.protocol, "otpauth:"); assert.equal(uri.searchParams.get("secret"), secret);
    assert.equal(uri.searchParams.get("issuer"), "NDAHI Connect"); assert.equal(uri.searchParams.get("period"), "30");
    assert.equal((await store.snapshot()).customers[0].totpSecret, undefined);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole("button", { name: "Copy setup key", exact: true }).click();
    await page.locator("#mfaSetupMessage").filter({ hasText: "Setup key copied" }).waitFor();
    await page.screenshot({ path: `${screenshots}/authenticator-setup-320.png`, fullPage: true });
    const invalid = totpCode(secret, Date.now()) === "000000" ? "111111" : "000000";
    await page.getByLabel("Six-digit code").fill(invalid);
    await page.getByRole("button", { name: "Confirm 2FA" }).click();
    await page.getByText("The authenticator code is invalid or expired. Check the app's current code and your phone's automatic time setting.", { exact: true }).waitFor();
    assert.equal((await store.snapshot()).customers[0].totpSecret, undefined);
    await page.getByLabel("Six-digit code").fill(totpCode(secret, Date.now()));
    await page.getByRole("button", { name: "Confirm 2FA" }).click();
    await page.getByText("Authenticator sign-in enabled. Your PIN and passkeys still work.").waitFor();
    assert.equal(await page.locator("#mfaSetup img").count(), 0);
    await page.getByRole("button", { name: "Generate recovery codes" }).click();
    const codeText = await page.locator("#recoveryCodesOutput code").first().textContent();
    assert.match(codeText, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await post("/api/account/security/logout-everywhere", {}, cookie);
    await page.goto(`${portal}/login`);
    await page.locator('[name="phone"]').fill("670050001");
    await page.locator("#authenticatorLogin").click();
    await page.waitForURL("**/verify.html");
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await page.locator("#primary").fill(codeText);
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.waitForURL(`${portal}/dashboard`);
    const queued = (await store.snapshot()).securityAlerts;
    assert.ok(queued.some((a) => a.kind === "recovery_code_used"), "recovery-code sign-in must queue a security alert");
  });
  const dedicatedLogin = await post("/api/account/login/pin", { phone: "670050001", pin: "2468" });
  await scenario("logging out everywhere signs out the current browser too", async (page) => {
    await page.goto(`${portal}/dashboard#account`);
    await page.locator("#sessionActivity summary").click();
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Log out everywhere" }).click();
    await page.waitForURL("**/login");
  }, { cookie: dedicatedLogin.response.headers.get("set-cookie").split(";")[0] });
  console.log(`${checks} security browser scenarios passed. Screenshots: ${screenshots}`);
} finally {
  await browser?.close(); await close(website); await close(server);
}
