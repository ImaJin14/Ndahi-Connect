import assert from "node:assert/strict";
import http from "node:http";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture } from "../test/helpers/wifi-pairing-fixture.mjs";
import { hashSecret, totpSecret, totpCode } from "../lib/security.mjs";

const website = http.createServer();
await new Promise((resolve) => website.listen(0, "127.0.0.1", resolve));
const portal = `http://127.0.0.1:${website.address().port}`;
const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true });
const originalSecret = totpSecret();
await f.store.transaction((s) => { s.customers[0].totpSecret = originalSecret; s.customers[0].recoveryCodes = [{ id: "old-recovery", hash: hashSecret("ABCD-2345", "pairing-tests") }]; });
const assets = createStaticServer("customer", { apiUrl: f.api });
website.on("request", (req, res) => assets.emit("request", req, res));
let browser;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
  await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(() => { for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(window, key, { get() { throw new DOMException("Storage denied", "SecurityError"); } }); });
  const urls = [], errors = [];
  await context.route("**/*", (route) => {
    const url = route.request().url(); urls.push(url);
    return [portal, f.api].includes(new URL(url).origin) ? route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }) : route.abort("blockedbyclient");
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(portal + "/dashboard#account");
  await page.getByRole("button", { name: "Manage authenticator", exact: true }).waitFor();
  assert.equal(await page.locator("#enableCustomerMfa").count(), 0);
  assert.equal(await page.locator("#mfaSetupKey").count(), 0);
  await page.getByRole("button", { name: "Manage authenticator", exact: true }).click();
  await page.getByRole("button", { name: "Verify a code", exact: true }).click();
  await page.getByLabel("Current authenticator code", { exact: true }).fill(totpCode(originalSecret, +f.now()));
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await page.getByText("Your authenticator app is working. Its current code was verified.", { exact: true }).waitFor();
  console.log("PASS an enrolled account discovers Manage authenticator and verifies its existing app without redisplaying its enrolled key");

  await page.getByRole("button", { name: "Replace authenticator", exact: true }).click();
  const proof = page.locator("[data-mfa-owner-form]");
  await proof.getByLabel("Account PIN", { exact: true }).fill("2468");
  await proof.getByLabel("Current authenticator code", { exact: true }).fill(totpCode(originalSecret, +f.now()));
  await page.route("**/api/account/security/mfa/replace", async (route) => {
    const response = await route.fetch({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } });
    assert.equal(response.status(), 200); await route.abort("failed");
  }, { times: 1 });
  await proof.getByRole("button", { name: "Verify and start replacement", exact: true }).click();
  await proof.locator("[data-mfa-proof-message]").filter({ hasText: /network|reach|fetch|connection/i }).waitFor();
  await proof.getByRole("button", { name: "Verify and start replacement", exact: true }).click();
  await page.locator("#mfaSetupKey").waitFor();
  const replacement = await page.locator("#mfaSetupKey").textContent();
  assert.notEqual(replacement, originalSecret);
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, originalSecret);
  assert.equal((await f.store.snapshot()).customerMfaChallenges.filter((x) => x.secret).length, 1);
  console.log("PASS a lost replacement-start reply resumes the same verified intent, keeping the old app active and key material out of browser storage");

  await page.reload();
  await page.getByRole("button", { name: "Resume pending setup", exact: true }).waitFor();
  assert.equal(await page.locator("#mfaSetupKey").count(), 0);
  await page.getByRole("button", { name: "Resume pending setup", exact: true }).click();
  await page.locator("[data-mfa-owner-form]").getByLabel("Account PIN", { exact: true }).fill("2468");
  await page.getByRole("button", { name: "Resume setup", exact: true }).click();
  await page.locator("#mfaSetupKey").waitFor();
  assert.equal(await page.locator("#mfaSetupKey").textContent(), replacement);
  const correct = totpCode(replacement, +f.now()), wrong = correct === "000000" ? "111111" : "000000";
  await page.getByLabel("Six-digit code", { exact: true }).fill(wrong);
  await page.getByRole("button", { name: "Confirm replacement", exact: true }).click();
  await page.locator("#dashboardMessage").filter({ hasText: /invalid|expired/ }).waitFor();
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, originalSecret);
  await page.route("**/api/account/security/mfa/confirm", async (route) => {
    const response = await route.fetch({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } });
    assert.equal(response.status(), 200); await route.abort("failed");
  }, { times: 1 });
  await page.getByLabel("Six-digit code", { exact: true }).fill(totpCode(replacement, +f.now()));
  await page.getByRole("button", { name: "Confirm replacement", exact: true }).click();
  await page.locator("#dashboardMessage").filter({ hasText: "Authenticator setup was confirmed" }).waitFor();
  assert.equal(await page.locator("#mfaSetupKey").count(), 0);
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, replacement);
  assert.equal((await f.store.snapshot()).customers[0].recoveryCodes, undefined);
  console.log("PASS reload resumes pending setup with fresh owner proof; invalid confirmation keeps the old app; a lost successful confirmation is recovered without false failure");

  await page.getByRole("button", { name: "Generate recovery codes", exact: true }).click();
  await page.locator("#recoveryCodesOutput li code").first().waitFor();
  const firstBatch = await page.locator("#recoveryCodesOutput li code").allTextContents();
  assert.equal(firstBatch.length, 10);
  await page.getByRole("button", { name: "Generate recovery codes", exact: true }).click();
  await page.locator("[data-mfa-owner-form]").getByLabel("Current authenticator code", { exact: true }).fill(totpCode(replacement, +f.now()));
  await page.locator("[data-mfa-owner-form]").getByRole("button", { name: "Generate recovery codes", exact: true }).click();
  await page.waitForFunction((old) => document.querySelector("#recoveryCodesOutput li code")?.textContent !== old, firstBatch[0]);
  const recovery = await page.locator("#recoveryCodesOutput li code").first().textContent();
  await page.getByRole("button", { name: "I have lost access", exact: true }).click();
  await proof.getByLabel("Account PIN", { exact: true }).fill("2468");
  await proof.getByLabel("Unused authenticator recovery code", { exact: true }).fill(recovery);
  await proof.getByRole("button", { name: "Verify and start replacement", exact: true }).click();
  await page.locator("#mfaSetupKey").waitFor();
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, replacement);
  assert.equal((await f.store.snapshot()).customers[0].recoveryCodes.filter((x) => x.usedAt).length, 1);
  await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#mfaSetupKey"));
  await page.getByText("Authenticator setup cancelled. You can start again whenever you choose.", { exact: true }).waitFor();
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, replacement);
  assert.equal(await page.getByRole("button", { name: "Resume pending setup", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  for (const url of urls) { assert.equal(url.includes(originalSecret), false); assert.equal(url.includes(replacement), false); assert.equal(url.includes(recovery), false); }
  console.log("PASS recovery-code regeneration needs proof; lost-access replacement consumes one recovery code; cancellation keeps the old app and clears sensitive output at 320px");
  await context.close();
} finally {
  await browser?.close(); await f.close();
  await new Promise((resolve) => { website.close(resolve); website.closeAllConnections(); });
}
