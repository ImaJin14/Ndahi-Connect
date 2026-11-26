import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Signed-in devices (canvas: PhoneSessions, #413; owner 26 Nov): the lede, this
// device first with "You", the others with "Last active <when>" and Sign out
// (no town: we keep the IP address and browser, not a place), the sage
// "Signed out everywhere else." when no other device is signed in, and "Sign
// out all other devices" at the foot, which keeps this one. No confirmations
// and no security-history button. Local servers only, synthetic data.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

test("Signed-in devices is drawn as the board, signs one out and keeps this one when signing out the rest", { timeout: 120000 }, async (t) => {
  const secret = "redesign-sessions", store = createStore({ persistent: false }), now = Date.now();
  const seed = (s) => {
    const at = (hours) => new Date(now - hours * 3600000).toISOString();
    s.dashboardSessions = [
      { id: "phone", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", userAgent: ANDROID, ip: "102.244.1.9", createdAt: at(1), lastSeenAt: at(0), expiresAt: "2099-01-01T00:00:00.000Z" },
      { id: "laptop", customerId: "amina", tokenHash: hashSecret("laptop", secret), csrfToken: "x", userAgent: WINDOWS, ip: "102.244.1.9", createdAt: at(3), lastSeenAt: at(2), expiresAt: "2099-01-01T00:00:00.000Z" },
      { id: "iphone", customerId: "amina", tokenHash: hashSecret("iphone", secret), csrfToken: "y", userAgent: IPHONE, ip: "102.244.1.9", createdAt: at(100), lastSeenAt: at(96), expiresAt: "2099-01-01T00:00:00.000Z" },
      { id: "someone-else", customerId: "bruno", tokenHash: hashSecret("bruno", secret), csrfToken: "z", createdAt: at(1), expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
  };
  await store.transaction(async (s) => {
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", pinHash: await argon2.hash("2468"), passkeys: [] }, { id: "bruno", name: "Bruno", phone: "670001246", passkeys: [] });
    seed(s);
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
  const screenshots = process.env.PHONE_SESSIONS_SCREENSHOTS || "/tmp/ndahi-phone-sessions";
  await mkdir(screenshots, { recursive: true });
  const open = async (lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [], dialogs = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.goto(portal + "/dashboard#sessions");
    await page.locator("#sessionActivity .account-session").first().waitFor();
    return { page, errors, dialogs, context };
  };
  const rows = (page) => page.locator("#sessionActivity .account-session").evaluateAll((nodes) => nodes.map((n) => [n.querySelector("b").innerText, n.querySelector("small").innerText, (n.querySelector("button, .account-you")).innerText, n.querySelector("button")?.getAttribute("aria-label") || ""]));
  const sessions = async () => (await store.snapshot()).dashboardSessions.map((x) => x.id).sort();

  const { page, errors, dialogs, context } = await open();
  assert.equal(await page.locator("#portalSubTitle").innerText(), "Signed-in devices");
  assert.equal(await page.locator("#accountSessions > p:not(.eyebrow):not(.nd-visually-hidden)").innerText(), "Places where your NDAHI account is open. This isn't the same as devices using your bundle.");
  assert.deepEqual(await rows(page), [
    ["Android phone · Chrome", "This device", "You", ""],
    ["Windows computer · Firefox", "Last active 2 h ago", "Sign out", "Sign out Windows computer · Firefox"],
    ["iPhone · Safari", "Last active 4 days ago", "Sign out", "Sign out iPhone · Safari"],
  ]);
  assert.equal(await page.getByRole("button", { name: "View security history" }).count(), 0);
  assert.equal(await page.getByText("Signed out everywhere else.").count(), 0);
  const all = page.getByRole("button", { name: "Sign out all other devices", exact: true });
  assert.deepEqual(await all.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(innerWidth - r.right), Math.round(innerHeight - r.bottom), Math.round(r.height)]; }), [18, 18, 16, 50]);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${screenshots}/sessions.png` });

  // One device: no confirmation; that session ends, the others stay.
  await page.getByRole("button", { name: "Sign out Windows computer · Firefox", exact: true }).click();
  await page.locator("#sessionActivity .account-session").nth(2).waitFor({ state: "detached" });
  assert.deepEqual(await sessions(), ["iphone", "phone", "someone-else"]);
  // All other devices: this one stays signed in, another customer's session is untouched.
  await all.click();
  await page.getByText("Signed out everywhere else.", { exact: true }).waitFor();
  assert.deepEqual(await sessions(), ["phone", "someone-else"]);
  assert.equal(await page.locator("#sessionActivity .account-session").count(), 1);
  assert.deepEqual(dialogs, [], "no confirmation boxes");
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/signed-out-elsewhere.png` });
  await page.reload();
  await page.locator("#sessionActivity .account-session[data-current]").waitFor();
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  await store.transaction((s) => seed(s));
  const fr = await open("fr");
  assert.deepEqual((await rows(fr.page)).map((r) => r.slice(1, 3)), [["Cet appareil", "Vous"], ["Actif il y a 2 h", "Déconnecter"], ["Actif il y a 4 jours", "Déconnecter"]]);
  assert.equal(await fr.page.getByRole("button", { name: "Déconnecter tous les autres appareils", exact: true }).count(), 1);
  assert.deepEqual(fr.errors, []);
  await fr.context.close();
});
