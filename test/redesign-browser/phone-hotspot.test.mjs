import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The Wi-Fi page (canvas: PhoneHotspot, #404): on NDAHI Wi-Fi it says so and
// names the hotspot the owner set in Network setup (owner, 26 Nov): "Choose
// how you'd like to get online at <name>." Without a name, the sentence ends
// "…to get online." Local servers only; the request comes from the hotspot's
// public address through the trusted proxy header.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const HOTSPOT_IP = "203.0.113.7";

test("the owner names the hotspot and the Wi-Fi page shows it", { timeout: 180000 }, async (t) => {
  const secret = "redesign-phone-hotspot", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.zone = { ...s.zone, status: "online" };
    s.adminUsers.push({ id: "owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } }));
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, hotspotLoginUrl: "https://hotspot.example.test/login", env: { NODE_ENV: "test" } }));
  const [admin, portal] = [adminServer, portalServer].map((s) => `http://127.0.0.1:${s.address().port}`);
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock",
    OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent",
    COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: HOTSPOT_IP, TRUST_PROXY: "render" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); await close(portalServer); });
  const screenshots = process.env.PHONE_HOTSPOT_SCREENSHOTS || "/tmp/ndahi-phone-hotspot";
  await mkdir(screenshots, { recursive: true });
  const local = (route) => [api, admin, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient");

  const wifiPage = async (lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: lang === "fr" ? "fr-FR" : "en-GB", extraHTTPHeaders: { "cf-connecting-ip": HOTSPOT_IP } });
    await context.route("**/*", local);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/hotspot?mac=AA%3ABB%3ACC%3ADD%3AEE%3A03&address=10.20.0.30`);
    await page.locator("#hotspotLanding:not([hidden])").waitFor();
    await page.locator('#hotspotStatus:not([data-status="unavailable"])').waitFor();
    return { context, page, errors };
  };

  // No name yet.
  let { context, page, errors } = await wifiPage();
  assert.equal(await page.locator("#hotspotWifi").innerText(), "YOU'RE ON NDAHI WI-FI");
  assert.equal(await page.locator("#hotspotLede").innerText(), "Choose how you'd like to get online.");
  await context.close();

  // The owner names it in Network setup → More network tools.
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await owner.route("**/*", local);
  await owner.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
  const adminPage = await owner.newPage(), adminErrors = [];
  adminPage.on("pageerror", (error) => adminErrors.push(error.message));
  await adminPage.goto(`${admin}/dashboard#network-setup`);
  await adminPage.locator("#networkTools > summary").click();
  const form = adminPage.locator("#networkHotspotName");
  await form.locator('[name="en"]').fill("NDAHI Bamenda");
  await form.locator('[name="fr"]').fill("NDAHI Bamenda (FR)");
  await form.getByRole("button", { name: "Save name" }).click();
  await adminPage.getByText("Hotspot name saved.", { exact: true }).waitFor();
  await adminPage.reload();
  await adminPage.locator("#networkTools > summary").click();
  await adminPage.waitForFunction(() => document.querySelector('#networkHotspotName [name="en"]').value === "NDAHI Bamenda");
  assert.deepEqual(adminErrors, []);
  await owner.close();

  // The Wi-Fi page names it, in each language.
  ({ context, page, errors } = await wifiPage());
  await page.waitForFunction(() => /Bamenda/.test(document.getElementById("hotspotLede").textContent));
  assert.equal(await page.locator("#hotspotLede").innerText(), "Choose how you'd like to get online at NDAHI Bamenda.");
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await page.screenshot({ path: `${screenshots}/hotspot-390.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
  ({ context, page, errors } = await wifiPage("fr"));
  await page.waitForFunction(() => /Bamenda/.test(document.getElementById("hotspotLede").textContent));
  assert.equal(await page.locator("#hotspotLede").innerText(), "Choisissez comment vous connecter à NDAHI Bamenda (FR).");
  await page.screenshot({ path: `${screenshots}/hotspot-390-fr.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});
