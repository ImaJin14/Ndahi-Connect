import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Passkey sign-in (canvas: PhonePasskey, #408; owner 26 Nov): the forest card,
// "Your passkeys" with each passkey's name, "Added <date> · last used <day>"
// and Remove (no Rename), the sage note when there are none, and "Add a
// passkey on this phone" at the foot. Local servers only, synthetic data, every
// non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("the passkey page lists passkeys as drawn, with when each was added and last used", { timeout: 120000 }, async (t) => {
  const secret = "redesign-passkeys", store = createStore({ persistent: false }), now = new Date();
  const pinHash = await argon2.hash("2468");
  await store.transaction((s) => {
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", pinHash,
      passkeys: [{ id: "key-1", publicKey: "pk", counter: 0, transports: ["internal"], label: "Android phone", createdAt: "2026-11-02T09:00:00.000Z", lastUsedAt: now.toISOString() },
        { id: "key-2", publicKey: "pk2", counter: 0, label: "Windows computer", createdAt: "2026-10-20T09:00:00.000Z" }] });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
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
  const screenshots = process.env.PHONE_PASSKEY_SCREENSHOTS || "/tmp/ndahi-phone-passkey";
  await mkdir(screenshots, { recursive: true });
  const open = async (lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + "/dashboard#passkeys");
    await page.locator("#security-passkeys:not([hidden]) .account-passkey").first().waitFor();
    return { page, errors, context };
  };
  const rows = (page) => page.locator(".account-passkey").evaluateAll((nodes) => nodes.map((n) => [n.querySelector("b").innerText, n.querySelector("small").innerText, n.querySelector("button").getAttribute("aria-label")]));

  const { page, errors, context } = await open();
  assert.equal(await page.locator(".account-passkey-intro strong").innerText(), "Sign in with your fingerprint or face");
  assert.deepEqual(await rows(page), [["Android phone", "Added 2 Nov · last used today", "Remove Android phone"], ["Windows computer", "Added 20 Oct", "Remove Windows computer"]]);
  assert.equal(await page.locator("[data-rename-passkey], .rename-passkey").count(), 0, "no Rename");
  assert.equal(await page.getByText("Use your device lock").count(), 0);
  const add = page.locator("#addCustomerPasskey");
  assert.equal(await add.innerText(), "Add a passkey on this phone");
  assert.deepEqual(await add.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(innerWidth - r.right), Math.round(innerHeight - r.bottom)]; }), [18, 18, 20]);
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/passkeys.png` });
  assert.deepEqual(errors, []);
  await context.close();

  // None yet: the sage note.
  await store.transaction((s) => { s.customers[0].passkeys = []; });
  const none = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await none.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await none.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
  const nonePage = await none.newPage();
  await nonePage.goto(portal + "/dashboard#passkeys");
  await nonePage.locator(".account-passkeys__none").waitFor();
  assert.equal(await nonePage.locator(".account-passkeys__none").innerText(), "No passkeys yet. You'll sign in with your PIN.");
  await nonePage.screenshot({ path: `${screenshots}/none.png` });
  await none.close();
});
