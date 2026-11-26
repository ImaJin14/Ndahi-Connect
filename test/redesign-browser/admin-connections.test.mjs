import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { seal } from "../../lib/network-secrets.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Connections (AdminConnections, #380; owner decisions 25 Nov): six service
// cards from the API's checks (canned RouterOS replies for a read-only check),
// "Test connection", standalone access points with no test, Admin security
// with the real sign-in policy, and the router checks closed below.
// Local servers only, synthetic data, 390 and 1280 px, English and French.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const KEY = "c".repeat(64), ROUTER = "https://router.example.test";
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
let routerUp = true;
const routerFetch = async (url) => {
  if (!routerUp) throw new TypeError("fetch failed");
  const path = String(url).replace(ROUTER + "/rest/", "");
  if (path === "system/resource") return reply({ version: "7.24.5 (stable)" });
  if (path === "ip/hotspot/active") return reply(Array.from({ length: 48 }, (_, i) => ({ ".id": "*" + i })));
  if (path === "ping") return reply([{ seq: "2", sent: "3", received: "3", "packet-loss": "0", "avg-rtt": "24ms" }]);
  if (path.startsWith("ip/route")) return reply([{ "immediate-gw": "192.168.1.1%ether1" }]);
  if (path === "interface/monitor-traffic") return reply([{ "rx-bits-per-second": "18200000" }]);
  return new Response("", { status: 404 });
};

test("Connections shows each service's check, tests it, and keeps router checks below", { timeout: 300000 }, async (t) => {
  const secret = "redesign-connections", store = createStore({ persistent: false }), now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  await store.transaction((s) => {
    s.networkSetup = { connections: { router: { kind: "router", mode: "live", secret: seal({ url: ROUTER, username: "ndahi", password: "x" }, { NETWORK_CONFIG_KEY: KEY }) } } };
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] },
      { id: "u-op", username: "brenda", displayName: "Brenda", role: "operator", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    for (let i = 0; i < 4; i++) {
      s.payments.push({ id: `m${i}`, network: "mtn", status: "paid", createdAt: iso(now - (i + 1) * 36e5), confirmedAt: iso(now - (i + 1) * 36e5 + 90000), receiptEmail: { status: "sent", sentAt: iso(now - (i + 1) * 36e5 + 95000) } });
      s.payments.push({ id: `o${i}`, network: "orange", status: "paid", createdAt: iso(now - (i + 1) * 3e6), confirmedAt: iso(now - (i + 1) * 3e6 + 25000) });
    }
    s.routerCommands.push({ id: "cmd-stuck", kind: "router_command", action: "sync_voucher", targetId: "short-id", status: "dead_letter", attempts: 8, totalAttempts: 8, lastError: "router_unreachable", at: iso(now - 36e5) });
    s.zone.authenticatorRetirement = { version: 1, retiredAt: iso(now - 864e5) };
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, routerFetch, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mesomb", EMAIL_MODE: "resend", MIKROTIK_MODE: "live", OMADA_MODE: "standalone", SERVICE_HEALTH_ENABLED: "true",
    NETWORK_CONFIG_KEY: KEY, NETWORK_ALLOWED_ORIGINS: ROUTER, BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.POLISH_SCREENSHOTS || "/tmp/ndahi-admin-connections";
  await mkdir(screenshots, { recursive: true });

  for (const [width, lang] of [[1280, "en"], [390, "en"], [1280, "fr"]]) {
    routerUp = true;
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, timezoneId: "Africa/Douala", locale: lang === "fr" ? "fr-FR" : "en-GB" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      try { localStorage.setItem("ndahi-language", "fr"); } catch {}
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${admin}/dashboard#connections`);
    const card = (id) => page.locator(`.admin-service[data-service="${id}"]`);
    await card("router").locator(".admin-service__pill--ok").waitFor();
    const cards = await page.locator(".admin-service").evaluateAll((els) => els.map((el) => [el.querySelector("strong").textContent, el.querySelector(".admin-service__pill").textContent, el.querySelector(".admin-service__detail").textContent, Boolean(el.querySelector("button"))]));
    if (lang === "en") {
      assert.deepEqual(cards, [
        ["Starlink uplink", "OK", "24 ms · 18.2 Mbps in use", true],
        ["MikroTik gateway", "OK", "RouterOS hotspot · 48 sessions", true],
        ["Omada controller", "Standalone", "Access points run standalone — no controller to check", false],
        ["MTN MoMo", "Slow", "Confirmations taking ~90 s", true],
        ["Orange Money", "OK", "Payments confirming normally", true],
        ["Email", "OK", "Receipts and PIN-reset links delivering", true],
      ]);
      assert.match(await page.locator("#adminLede").innerText(), /checked every minute\.$/);
      const security = page.getByRole("region", { name: "Admin security" });
      assert.match(await security.innerText(), /PIN \+ passkey, required[\s\S]*1 owner · 1 operator[\s\S]*1 stuck/);
      assert.equal(await page.locator("#routerChecks").evaluate((d) => d.open), false, "router checks start closed");
      await page.screenshot({ path: `${screenshots}/connections-${width}.png`, fullPage: true });
      // Test connection: the router stops answering.
      routerUp = false;
      await card("router").getByRole("button", { name: "Test connection" }).click();
      await card("router").getByText("Tested just now — no answer").waitFor();
      assert.equal(await card("router").locator(".admin-service__pill").textContent(), "Down");
      routerUp = true;
      await card("router").getByRole("button", { name: "Test connection" }).click();
      await card("router").getByText("Tested just now — responded").waitFor();
      await card("mtn").getByRole("button", { name: "Test connection" }).click();
      await card("mtn").getByText("Checked just now").waitFor();
      // "1 stuck" opens the router checks.
      await security.getByRole("link", { name: "1 stuck" }).click();
      await page.getByRole("row").filter({ hasText: "short-id" }).waitFor();
      assert.equal(new URL(page.url()).hash, "#connections", "the view stays");
    } else {
      assert.deepEqual(cards.map((c) => c.slice(0, 2)), [["Liaison Starlink", "OK"], ["Passerelle MikroTik", "OK"], ["Contrôleur Omada", "Autonome"], ["MTN MoMo", "Lent"], ["Orange Money", "OK"], ["E-mail", "OK"]]);
      await page.screenshot({ path: `${screenshots}/connections-fr.png`, fullPage: true });
    }
    assert.deepEqual(await lowContrastText(page), [], `contrast ${width} ${lang}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${width}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
