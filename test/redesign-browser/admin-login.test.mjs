import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Admin sign in (canvas: AdminLogin, #383): Step 1 of 2 (Email and PIN, no Show
// toggle, Continue), then Step 2 of 2 "Confirm with your passkey." with the key,
// Use passkey, "Use a different account" as a link and the lost-device note,
// which shows on step 2 only. Local servers only, synthetic data, 1280 px.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("admin sign in shows the drawn two steps", { timeout: 120000 }, async (t) => {
  const secret = "redesign-admin-login", store = createStore({ persistent: false });
  await store.transaction(async (s) => {
    s.adminUsers.push({ id: "owner", username: "owner", email: "owner@ndahiconnect.net", displayName: "Owner", role: "owner", active: true, pinHash: await argon2.hash("246810"),
      passkeys: [{ id: "key-1", publicKey: "pk", counter: 0, transports: ["internal"], label: "Office laptop", createdAt: "2026-08-19T09:00:00.000Z" }] });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.ADMIN_LOGIN_SCREENSHOTS || "/tmp/ndahi-admin-login";
  await mkdir(screenshots, { recursive: true });
  const open = async (lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1020 } });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(admin + "/login");
    await page.locator("#login").waitFor();
    return { page, errors, context };
  };
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; });

  const { page, errors, context } = await open();
  // Step 1: the forest bar, then the card.
  assert.deepEqual(await box(page.locator(".admin-login__bar")), [0, 0, 1280, 74]);
  assert.deepEqual((await box(page.locator(".admin-login__card"))).slice(0, 3), [410, 146, 460]);
  assert.equal(await page.locator("#credentialsStep .nd-eyebrow").innerText(), "STEP 1 OF 2");
  assert.equal(await page.locator("#adminLoginTitle").innerText(), "Administrator access.");
  assert.deepEqual(await page.locator("#login .nd-label").allInnerTexts(), ["Email", "PIN"]);
  assert.equal(await page.getByRole("button", { name: /Show PIN/ }).count(), 0, "no Show toggle, as drawn");
  assert.equal(await page.getByText("Lost your passkey device?").isVisible(), false, "the note is for step 2");
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/step-1.png` });

  // Step 2: confirm with the passkey.
  await page.locator("#adminEmail").fill("owner@ndahiconnect.net");
  await page.locator("#adminPassword").fill("246810");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("#passkeyStep:not([hidden])").waitFor();
  assert.equal(await page.locator("#passkeyStep .nd-eyebrow").innerText(), "STEP 2 OF 2");
  assert.equal(await page.locator("#passkeyStepTitle").innerText(), "Confirm with your passkey.");
  assert.equal(await page.locator("#passkeyStepTitle").evaluate((el) => el === document.activeElement), true);
  const key = await box(page.locator(".admin-login__key")), use = await box(page.locator("#usePasskey"));
  assert.deepEqual([key[0], key[2], key[3]], [592, 96, 96]);
  assert.deepEqual([use[0], use[2], use[3], use[1] - (key[1] + key[3])], [447, 386, 50, 18], "Use passkey across the card, 18px under the key");
  const other = page.getByRole("button", { name: "Use a different account", exact: true });
  assert.equal(await other.evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "a link, not a button box");
  assert.equal(await page.locator("#lostPasskeyNote").innerText(), "Lost your passkey device? The owner can remove it and you add a new one after signing in on another device.");
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/step-2.png` });
  // Use a different account returns to step 1 with the fields cleared.
  await other.click();
  await page.locator("#credentialsStep:not([hidden])").waitFor();
  assert.equal(await page.locator("#adminPassword").inputValue(), "");
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  const fr = await open("fr");
  assert.equal(await fr.page.locator("#adminLoginTitle").innerText(), "Accès administrateur.");
  assert.deepEqual(fr.errors, []);
  await fr.context.close();
});
