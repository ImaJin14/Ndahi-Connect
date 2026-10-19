import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";

const api = "http://127.0.0.1:8998", admin = "http://127.0.0.1:8997", origins = new Set([api, admin]);
const store = createStore({ persistent: false }), secret = randomUUID(), tokens = Object.fromEntries(["owner", "operator", "auditor", "reseller"].map((r) => [r, randomUUID()]));
let now = new Date("2030-01-01T08:00:00Z"), devices, failRead = false, readGate, disconnectGate, readCalls = 0;
const observed = [{ mac: "AA:BB:CC:DD:EE:01", sessionId: "*A", startedAt: "2030-01-01T07:55:00.000Z", address: "10.20.0.2" },
  { mac: "AA:BB:CC:DD:EE:02", sessionId: "*B", startedAt: "2030-01-01T07:55:00.000Z", address: "10.20.0.3" }];
const server = createServer({ store, now: () => now, validateConfig: false, router: {
  readUsage: async () => { readCalls++; if (readGate) await readGate; if (failRead) throw Error("Fixture router unavailable"); return [{ voucherId: "v1", usedBytes: 0, devices }]; },
  disconnectWifiDevice: async (target) => { if (disconnectGate) await disconnectGate; devices = devices.filter((d) => d.sessionId !== target.sessionId); return { confirmed: true, outcome: "disconnected" }; },
}, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "live", OMADA_MODE: "not-configured", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "true", NETWORK_QUEUE_MAX_ATTEMPTS: "1", NETWORK_USAGE_SYNC_SECONDS: "0", NETWORK_QUEUE_INTERVAL_SECONDS: "3600", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin } });
const website = createStaticServer("admin", { apiUrl: api });
const listen = (app, port) => new Promise((r) => app.listen(port, "127.0.0.1", r));
const close = (app) => new Promise((r) => { app.close(r); app.closeAllConnections(); });
const screenshots = "/tmp/ndahi-admin-app-checks";
let browser, checks = 0;
await store.transaction((s) => {
  s.customers.push({ id: "c1", name: "Fixture customer", phone: "670042001" });
  s.vouchers.push({ id: "v1", customerId: "c1", code: "NC-FIXTURE", planId: "weekly", status: "active", quotaBytes: null, usedBytes: 0, expiresAt: "2030-01-02T08:00:00Z", deviceLimit: 2, wifiDevices: observed, wifiDevicesAt: now.toISOString() });
  s.routerCommands.push({ id: "router:disconnect_device:legacy-uuid", kind: "router_command", action: "disconnect_device", targetId: "legacy-uuid", status: "dead_letter", attempts: 1, totalAttempts: 49, lastError: "Legacy device disconnection needs a fresh router session mapping.", at: now.toISOString() });
  for (const [role, token] of Object.entries(tokens)) s.adminSessions.push({ tokenHash: hashSecret(token, secret), role, csrfToken: randomUUID(), expiresAt: "2030-01-02T08:00:00Z" });
});
const baseline = await store.snapshot();
try {
  await listen(server, 8998); await listen(website, 8997); await mkdir(screenshots, { recursive: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function scenario(name, work, { width = 390, role = "owner", apple = false } = {}) {
    if (process.env.ADMIN_APP_CASE && !new RegExp(process.env.ADMIN_APP_CASE).test(name)) return;
    now = new Date("2030-01-01T08:00:00Z"); devices = structuredClone(observed); failRead = false; readGate = disconnectGate = undefined; readCalls = 0;
    await store.transaction((s) => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width, height: 900 }, ...(apple ? { userAgent: "Mozilla/5.0 (iPad; CPU OS 15_8 like Mac OS X) AppleWebKit/605.1.15 Version/15.0 Mobile/15E148 Safari/604.1" } : {}) });
    await context.route("**/*", (route) => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: tokens[role], url: api, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000); page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    try { await work(page, context); assert.deepEqual(errors, []); console.log(`PASS ${name}`); checks++; }
    catch (e) { await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true }).catch(() => {}); throw e; }
    finally { await context.close(); }
  }
  await scenario("owner can inspect and copy purchase diagnostics in admin, with bounded retries and no provisioning", async (page) => {
    let attempts = 0, release;
    const gate = new Promise((r) => { release = r; });
    const report = { checkedAt: now.toISOString(), clientTestRequired: true,
      findings: [{ label: "Before-login HTTPS", status: "review", detail: "No matching exception was found. <script>throw Error('unsafe')</script>" }],
      targets: [{ host: "api.example.test", addresses: ["216.24.57.16"] }], readings: [],
      nextStep: "Test an unpaid phone with mobile data off. Copy this report for support." };
    await page.route("**/api/admin/network/setup/purchase-access", async (route) => {
      assert.equal(route.request().method(), "POST");
      assert.ok(route.request().headers()["x-csrf-token"]);
      attempts++;
      if (attempts === 1) { await gate; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Router unavailable. Check the saved connection." }) }); }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ report }) });
    });
    await page.goto(`${admin}/dashboard#more`);
    await page.getByRole("tab", { name: "Network setup", exact: true }).click();
    const button = page.getByRole("button", { name: "Check purchase access", exact: true });
    await button.click();
    assert.equal(await page.locator("#networkPurchaseCheck").isDisabled(), true);
    release();
    await page.getByText("Router unavailable. Check the saved connection.", { exact: true }).waitFor();
    await button.click();
    await page.locator("#networkPurchaseReportText").waitFor();
    assert.deepEqual(JSON.parse(await page.locator("#networkPurchaseReportText").inputValue()), report);
    assert.equal(await page.locator("#networkPurchaseReport script").count(), 0);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { window.ndahiCopiedDiagnostics = value; } } }));
    await page.getByRole("button", { name: "Copy diagnostic report", exact: true }).click();
    assert.deepEqual(JSON.parse(await page.evaluate(() => window.ndahiCopiedDiagnostics)), report);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/purchase-diagnostics-320.png`, fullPage: true });
    await page.getByRole("button", { name: "Close report", exact: true }).click();
    assert.equal(await page.locator("#networkPurchaseReport[data-review-output]").count(), 0);
    assert.equal(await page.locator("#networkPurchaseReport").textContent(), "");
    assert.equal((await store.snapshot()).networkSetupJobs.length, 0);
    assert.equal(attempts, 2);
  }, { width: 320 });
  for (const width of [320, 390, 1280]) await scenario(`admin navigation, live count, Back and reload at ${width}px`, async (page) => {
    await page.goto(`${admin}/dashboard`);
    await page.locator("#activeSessionsMetric").waitFor();
    assert.equal(await page.locator("#activeSessionsMetric").textContent(), "2");
    await page.getByRole("link", { name: "Devices", exact: true }).click();
    await page.locator("#wifiRecords tbody tr").filter({ hasText: observed[1].mac }).waitFor();
    assert.equal(await page.locator("#wifiRecords tbody tr").count(), 2);
    await page.reload(); await page.getByRole("heading", { name: "Live Wi-Fi devices.", exact: true }).waitFor();
    await page.getByRole("link", { name: "Payments", exact: true }).click();
    await page.goBack(); assert.equal(new URL(page.url()).hash, "#devices");
    assert.equal(await page.locator('[data-admin-nav="devices"]').getAttribute("aria-current"), "page");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/devices-${width}.png`, fullPage: true });
  }, { width });
  await scenario("obsolete disconnects have no Replay and can be resolved without disconnecting a device", async (page) => {
    await page.goto(`${admin}/dashboard#connections`);
    const row = page.getByRole("row").filter({ hasText: "legacy-uuid" });
    await row.waitFor(); assert.equal(await row.getByRole("button", { name: "Replay", exact: true }).count(), 0);
    await row.getByRole("button", { name: "Mark obsolete" }).click();
    await row.waitFor({ state: "detached" });
    const s = await store.snapshot();
    assert.equal(s.routerCommands[0].status, "resolved"); assert.equal(s.routerCommands[0].totalAttempts, 49);
    assert.equal(s.vouchers[0].wifiDevices.length, 2);
    assert.equal(s.auditLogs.filter((a) => a.action === "network.command_resolved").length, 1);
  });
  await scenario("refresh waits for a successful router reading and clears departed devices", async (page) => {
    let release; readGate = new Promise((r) => { release = r; });
    await page.goto(`${admin}/dashboard#devices`);
    await page.locator("#wifiRecords tbody tr").filter({ hasText: observed[0].mac }).waitFor();
    await page.getByRole("button", { name: "Refresh devices", exact: true }).click();
    await page.getByText("A router reading was requested.", { exact: false }).waitFor();
    assert.equal(readCalls, 1); assert.equal((await store.snapshot()).vouchers[0].wifiDevices.length, 2);
    devices = []; release();
    await page.locator("#wifiSummary").filter({ hasText: "0 confirmed connected" }).waitFor();
    await page.locator("#wifiRecords").getByText("No records found.").waitFor();
  });
  await scenario("failed router readings preserve stale devices and expose a bounded retry action", async (page) => {
    now = new Date(+now + 180000); failRead = true;
    await page.goto(`${admin}/dashboard#devices`);
    await page.getByRole("button", { name: "Refresh devices", exact: true }).click();
    await page.getByRole("button", { name: "Retry router reading" }).waitFor();
    assert.equal((await store.snapshot()).vouchers[0].wifiDevices.length, 2);
    assert.equal(await page.locator("#wifiRecords [data-wifi-mac]:enabled").count(), 0);
    failRead = false; await page.getByRole("button", { name: "Retry router reading" }).click();
    await page.locator("#wifiSummary").filter({ hasText: "Router reading current" }).waitFor();
  });
  await scenario("a device slot remains occupied until the scoped disconnect is confirmed", async (page) => {
    let release; disconnectGate = new Promise((r) => { release = r; });
    await page.goto(`${admin}/dashboard#devices`);
    await page.locator(`[data-wifi-mac="${observed[0].mac}"]`).click();
    await page.getByRole("button", { name: "Disconnecting…", exact: true }).waitFor();
    assert.equal((await store.snapshot()).vouchers[0].wifiDevices.length, 2);
    release();
    await page.locator("#wifiSummary").filter({ hasText: "1 confirmed connected" }).waitFor();
    assert.equal((await store.snapshot()).vouchers[0].wifiDevices[0].sessionId, "*B");
  });
  for (const role of ["operator", "auditor", "reseller"]) await scenario(`navigation preserves ${role} access and hides owner setup`, async (page) => {
    await page.goto(`${admin}/dashboard#network-setup`);
    await page.locator('[data-admin-nav="home"][aria-current]').waitFor();
    await page.getByRole("link", { name: "More", exact: true }).click();
    assert.equal(await page.getByRole("tab", { name: "Network setup", exact: true }).count(), 0);
    await page.getByRole("link", { name: "Devices", exact: true }).click();
    await page.locator("#wifiRecords tbody tr").filter({ hasText: observed[0].mac }).waitFor();
    assert.equal(await page.locator("#refreshWifi").isVisible(), role === "operator");
    assert.equal(await page.getByRole("button", { name: "Disconnect", exact: true }).count(), role === "operator" ? 2 : 0);
  }, { role });
  await scenario("admin installation assets, service worker and offline launch do not cache records", async (page, context) => {
    const response = await fetch(`${admin}/manifest.webmanifest`), manifest = await response.json();
    assert.match(response.headers.get("content-type"), /manifest\+json/); assert.equal(manifest.name, "NDAHI Admin");
    for (const icon of manifest.icons) { const r = await fetch(admin + icon.src); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /image\/png/); }
    await page.goto(`${admin}/dashboard#more`);
    await page.getByRole("heading", { name: "Install NDAHI Admin" }).waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    assert.deepEqual(await page.evaluate(() => caches.keys()), []);
    await context.setOffline(true); await page.reload(); await page.getByRole("heading", { name: "You're offline" }).waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("670042001"));
    await context.setOffline(false); await page.getByRole("link", { name: "Try again" }).click();
    await page.getByRole("link", { name: "Devices", exact: true }).click(); await page.locator("#wifiRecords").waitFor();
  });
  await scenario("the admin install button invokes the available browser prompt and hides after installation", async (page) => {
    await page.goto(`${admin}/dashboard#more`);
    await page.locator("#adminInstall").waitFor();
    await page.evaluate(() => {
      window.installPrompts = 0;
      const event = new Event("beforeinstallprompt", { cancelable: true });
      event.prompt = async () => { window.installPrompts++; };
      event.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(event);
    });
    await page.getByRole("button", { name: "Install app", exact: true }).click();
    assert.equal(await page.evaluate(() => window.installPrompts), 1);
    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    await page.locator("#adminInstall").waitFor({ state: "hidden" });
  });
  await scenario("Apple installation gives manual Home Screen instructions", async (page) => {
    await page.goto(`${admin}/dashboard#more`); await page.getByText(/tap Share, then Add to Home Screen/).waitFor();
  }, { apple: true });
  await scenario("admin updates preserve edits and pending network setup, then refresh when idle", async (page) => {
    await page.clock.install();
    await page.goto(`${admin}/dashboard#bundles`); await page.locator('#bundle [name="name"]').waitFor();
    const baseline = await page.locator('meta[name="ndahi-release"]').getAttribute("content");
    let available = true, reloads = 0;
    page.on("load", () => { reloads++; });
    await page.route("**/version.json", (route) => route.fulfill({ json: { revision: available ? "fixture-new-release" : baseline } }));
    await page.locator('#bundle [name="name"]').fill("Unsaved bundle");
    await page.clock.fastForward(61000); await page.getByText("A new version is ready.", { exact: false }).waitFor();
    assert.equal(reloads, 0); assert.equal(await page.locator('#bundle [name="name"]').inputValue(), "Unsaved bundle");
    await page.evaluate(() => { document.querySelector("#networkSetup").dataset.setupPending = "true"; document.querySelector("#bundle").reset(); });
    await page.clock.fastForward(61000); assert.equal(reloads, 0);
    await page.getByRole("link", { name: "More", exact: true }).click();
    await page.getByRole("tab", { name: "Generate voucher", exact: true }).click();
    await page.getByRole("button", { name: "Generate resale vouchers" }).click();
    await page.getByText("1 voucher generated").waitFor();
    await page.evaluate(() => { document.querySelector("#networkSetup").dataset.setupPending = "false"; });
    await page.clock.fastForward(61000); assert.equal(reloads, 0, "generated codes must not disappear on an automatic update");
    available = false;
    await page.getByRole("button", { name: "Close codes", exact: true }).click();
    await page.clock.fastForward(61000);
    await page.waitForFunction(() => !document.querySelector(".update-notice:not([hidden])"));
    await page.waitForLoadState("load");
    assert.equal(reloads, 1);
  });
  console.log(`${checks} admin app browser journeys passed. Screenshots: ${screenshots}`);
} finally { await browser?.close(); await close(website); await close(server); }
