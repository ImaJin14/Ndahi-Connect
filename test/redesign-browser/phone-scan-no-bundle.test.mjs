import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Scan to connect without a bundle (canvas: PhoneScanNoBundle, #412; owner 26
// Nov): the account as drawn (first name and initial, masked number), when the
// last bundle ended, and Buy a bundle or a voucher code. A purchase started
// here comes back to the scan, which then offers the new bundle with the PIN:
// no second scan. Local servers only, synthetic data, every non-local request
// aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("a scan with no active bundle shows the account as drawn, and a purchase made from it comes back to the scan", { timeout: 180000 }, async (t) => {
  const secret = "redesign-scan-no-bundle", store = createStore({ persistent: false });
  const pinHash = await argon2.hash("2468");
  await store.transaction((s) => {
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", pinHash, emailVerifiedAt: "2026-09-01T08:00:00.000Z" });
    s.vouchers.push({ id: "hist", code: "NC-HIST-0001", customerId: "amina", status: "expired", planId: "weekly", quotaBytes: null, usedBytes: 0,
      activatedAt: "2026-10-29T18:00:00.000Z", expiresAt: "2026-11-05T18:00:00.000Z", createdAt: "2026-10-29T17:58:00.000Z" });
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
  const screenshots = process.env.PHONE_SCAN_NO_BUNDLE_SCREENSHOTS || "/tmp/ndahi-phone-scan-no-bundle";
  await mkdir(screenshots, { recursive: true });

  const open = async (path, { lang = "en", session = null } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: lang === "fr" ? "fr-FR" : "en-GB" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    if (session) await context.addCookies([{ name: "customer_session", value: session, url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + path);
    return { page, errors, context };
  };

  // As drawn, before any PIN: the account, the icon, the words, the two actions.
  const { page, errors, context } = await open("/voucher-connect.html?mac=AA:BB:CC:DD:EE:31&address=10.20.0.31#legacy=NC-HIST-0001");
  const none = page.locator("#qrNoBundle");
  await none.waitFor({ state: "visible" });
  assert.equal(await page.locator("#qrNoBundleName").innerText(), "Amina N.");
  assert.equal(await page.locator("#qrNoBundlePhone").innerText(), "+237 6•• •• 12 45");
  assert.equal(await page.locator("#qrNoBundleInitial").innerText(), "A");
  assert.equal(await page.locator("#qrNoBundleTitle").innerText(), "No active bundle");
  assert.equal(await page.locator("#qrNoBundleText").innerText(), "This account's last bundle ended on 5 Nov. Buy one and this device connects right after — you won't need to scan again.");
  assert.equal(await page.locator("#qrMessage").innerText(), await page.locator("#qrNoBundleText").innerText(), "announced as well");
  // Nothing else of the PIN step shows.
  for (const hidden of ["#qrConnectForm", "#restartQr"]) assert.equal(await page.locator(hidden).isVisible(), false, hidden);
  assert.equal(await page.locator("main h1:visible").count(), 0, "no other state's heading");
  const buy = page.locator("#qrBuyBundle");
  assert.equal(await buy.getAttribute("href"), "/onboarding.html?from=scan&mac=AA%3ABB%3ACC%3ADD%3AEE%3A31&address=10.20.0.31");
  assert.equal(await page.locator("#qrHaveVoucher").getAttribute("href"), "/dashboard#redeem");
  // The actions at the foot, 22px in and 22px up (canvas).
  const foot = await page.locator("#qrHaveVoucher").evaluate((node) => { const box = node.getBoundingClientRect(); return [box.left, innerWidth - box.right, innerHeight - box.bottom]; });
  assert.deepEqual(foot, [22, 22, 22]);
  // The scan is kept for 30 minutes, long enough to pay and come back.
  const kept = await page.evaluate(() => JSON.parse(sessionStorage.getItem("ndahi_voucher_scan")));
  assert.equal(kept.legacyCode, "NC-HIST-0001");
  assert.ok(kept.until > Date.now() + 25 * 60000);
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/no-bundle.png` });
  assert.deepEqual(errors.filter((e) => !/409/.test(e)), []);
  await context.close();

  // French.
  const fr = await open("/voucher-connect.html#legacy=NC-HIST-0001", { lang: "fr" });
  await fr.page.locator("#qrNoBundle").waitFor({ state: "visible" });
  assert.equal(await fr.page.locator("#qrNoBundleTitle").innerText(), "Aucun forfait actif");
  assert.equal(await fr.page.locator("#qrNoBundleText").innerText(), "Le dernier forfait de ce compte s'est terminé le 5 novembre. Achetez-en un et cet appareil se connecte aussitôt — inutile de scanner à nouveau.");
  assert.equal(await fr.page.locator("#qrBuyBundle").innerText(), "Acheter un forfait");
  assert.equal(await fr.page.locator("#qrHaveVoucher").innerText(), "J'ai un code de ticket");
  await fr.page.screenshot({ path: `${screenshots}/no-bundle-fr.png` });
  await fr.context.close();

  // Signed in on this phone: scan, buy from here, and the page comes back to the
  // scan once paid, now offering the new bundle with the PIN.
  await store.transaction((s) => { s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" }); });
  // On NDAHI Wi-Fi (the portal knows this device), as a scan to connect needs (#371).
  const buyer = await open("/voucher-connect.html?mac=AA:BB:CC:DD:EE:32&address=10.20.0.32#legacy=NC-HIST-0001", { session: "amina" });
  await buyer.page.locator("#qrNoBundle").waitFor({ state: "visible" });
  await buyer.page.locator("#qrBuyBundle").click();
  await buyer.page.waitForURL(/\/onboarding\.html\?from=scan/);
  await buyer.page.locator('[data-plan="weekly"]').click();
  const consent = buyer.page.locator('input[name="acknowledge"]');
  if (await consent.isVisible()) await consent.check();
  await buyer.page.locator("#requestPayment").click();
  await buyer.page.getByRole("button", { name: "Simulate payment approval" }).click();
  await buyer.page.waitForURL(/\/voucher-connect\.html(\?|$)/);
  // The new bundle is ready once the router has it.
  await store.transaction((s) => { for (const v of s.vouchers) if (v.customerId === "amina" && v.status === "active") v.routerSyncStatus = "synchronized"; });
  // Once the scan has been checked: if the bundle wasn't ready yet, Check again.
  await buyer.page.waitForFunction(() => document.body.dataset.scanState && document.body.dataset.scanState !== "checking");
  const again = buyer.page.getByRole("button", { name: "Check again" });
  if (await again.isVisible()) await again.click();
  await buyer.page.locator("#qrConnectForm").waitFor({ state: "visible" });
  assert.equal(await buyer.page.locator("#qrNoBundle").isVisible(), false);
  assert.match(await buyer.page.locator("#bundleName").innerText(), /Weekly/i);
  await buyer.page.screenshot({ path: `${screenshots}/after-purchase.png` });
  assert.deepEqual(buyer.errors.filter((e) => !/409/.test(e)), []);
  await buyer.context.close();
});
