import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Network setup (AdminNetworkSetup, #384; owner decisions 25 Nov), walked in
// simulation (no equipment): the drawn Router fields, Discover, "Next: access
// points" making the router preview, the standalone notes for access points
// and Wi-Fi, Review as the drawn summary rows, Run simulation with no
// checkbox, then the drawn "Applied" line and Keep changes. The outage area
// names (#385) are saved from "More network tools". 1280 and 390 px, French.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("network setup walks the drawn steps, reviews one change set and applies it", { timeout: 300000 }, async (t) => {
  const secret = "redesign-network-setup", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "standalone",
    NETWORK_CONFIG_KEY: "e".repeat(64), NETWORK_ALLOWED_ORIGINS: "", NETWORK_PROVISIONING_ENABLED: "false",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.POLISH_SCREENSHOTS || "/tmp/ndahi-admin-network-setup";
  await mkdir(screenshots, { recursive: true });
  const open = async (width, lang = "en") => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      try { localStorage.setItem("ndahi-language", "fr"); } catch {}
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { context, page, errors };
  };

  for (const width of [1280, 390]) {
    const { context, page, errors } = await open(width);
    await page.goto(`${admin}/dashboard#network-setup`);
    const steps = page.getByRole("list", { name: "Setup steps" }), panel = page.getByRole("region", { name: "Step details" });
    await panel.getByRole("heading", { name: "MikroTik router", exact: true }).waitFor();
    // The drawn four fields; the secrets and the rest are in "More router settings".
    for (const label of ["Router address", "Connection mode", "Internet uplink", "Hotspot DNS name"]) assert.equal(await panel.getByLabel(label, { exact: true }).isVisible(), true, label);
    assert.equal(await panel.getByLabel("Service password").isVisible(), false);
    if (width === 1280) {
      await page.screenshot({ path: `${screenshots}/router-${width}.png`, fullPage: true });
      await panel.getByLabel("Connection mode").selectOption("simulation");
      await panel.getByRole("button", { name: "Discover router", exact: true }).click();
      await page.locator('#netWan option[value="ether1"]').waitFor({ state: "attached" });
      await panel.getByRole("button", { name: "Next: access points", exact: true }).click();
      // Access points and Wi-Fi run standalone: the note, and Next.
      await panel.getByText("Access points run standalone, so set them up on each device.", { exact: true }).waitFor();
      assert.equal(await panel.getByRole("button", { name: "Discover access points" }).count(), 0, "nothing to discover");
      assert.match(await steps.getByRole("button", { name: "Router" }).innerText(), /^✓\s*Router$/);
      await panel.getByRole("button", { name: "Next: Wi-Fi", exact: true }).click();
      await panel.getByText("Set the network name, VLAN and client isolation on each access point.", { exact: true }).waitFor();
      assert.equal(await panel.getByLabel("Network name (SSID)").isVisible(), false);
      await panel.getByRole("button", { name: "Next: review", exact: true }).click();
      // Review: the router preview as the drawn rows; no checkbox; simulation only.
      await panel.getByRole("heading", { name: "Review before applying", exact: true }).waitFor();
      const rows = await panel.locator("#networkPreview .admin-setup__row").evaluateAll((els) => els.map((el) => [...el.children].map((c) => c.textContent.trim())));
      assert.deepEqual(rows, [["Hotspot DNS name", "connect.ndahi.local"], ["Internet uplink", "ether1"], ["Dedicated AP port", "ether2"], ["Hotspot network", "10.20.0.0/22"], ["DHCP range", "10.20.0.20 – 10.20.3.250"], ["DNS servers", "1.1.1.1,8.8.8.8"]]);
      assert.equal(await panel.locator("#networkPreview input[type=checkbox]").count(), 0);
      assert.equal(await panel.getByRole("button", { name: "Apply reviewed changes" }).isDisabled(), true);
      await panel.getByText("This preview is a simulation", { exact: false }).waitFor();
      await page.screenshot({ path: `${screenshots}/review-${width}.png`, fullPage: true });
      assert.deepEqual(await lowContrastText(page), [], "review contrast");
      await panel.getByRole("button", { name: "Run simulation", exact: true }).click();
      await panel.getByText("Applied. A backup of the previous settings was saved.", { exact: true }).waitFor();
      await panel.locator("[data-tested]").check();
      await panel.getByRole("button", { name: "Keep changes", exact: true }).click();
      await page.locator("#networkTools > summary").click();
      await page.getByRole("heading", { name: "router · simulation · completed", exact: true }).waitFor();
      // Outage area names, kept here for the outage form (#385).
      const areas = page.locator("#networkAreas");
      await areas.getByLabel("Site name").fill("Bamenda");
      await areas.getByLabel("Areas, one per line", { exact: false }).fill("AP-Market\nAP-Junction\n");
      await areas.getByRole("button", { name: "Save areas" }).click();
      await page.getByText("Outage areas saved.", { exact: true }).waitFor();
      assert.deepEqual((await store.snapshot()).outageAreas.areas, ["AP-Market", "AP-Junction"]);
    }
    assert.deepEqual(await lowContrastText(page), [], `contrast ${width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${width}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  const { context, page, errors } = await open(1280, "fr");
  await page.goto(`${admin}/dashboard#network-setup`);
  await page.getByRole("heading", { name: "Routeur MikroTik", exact: true }).waitFor();
  assert.deepEqual((await page.getByRole("list", { name: "Étapes de configuration" }).getByRole("button").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").replace(/^[✓\d] /, "").trim()), ["Routeur", "Points d'accès", "Wi-Fi", "Vérification"]);
  await page.screenshot({ path: `${screenshots}/router-fr.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});
