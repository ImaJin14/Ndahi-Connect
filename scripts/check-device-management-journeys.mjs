import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createHandler, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";

// Real local API and synthetic router state; never contact production.
const secret = "device-browser-fixture", store = createStore({ persistent: false }), pinHash = await argon2.hash("2468");
const now = new Date(), mac = "AA:BB:CC:DD:EE:01";
await store.transaction((s) => {
  s.customers.push({ id: "c1", name: "Imajin", phone: "670050001", pinHash });
  s.networkSetup = { runtimeRouterEnabled: true, connections: { router: { mode: "live", revision: "router-1" } } };
  for (const id of ["main", "secondary"]) s.dashboardSessions.push({ id, customerId: "c1", tokenHash: hashSecret(id, secret),
    csrfToken: "csrf", expiresAt: new Date(+now + 3600000).toISOString() });
  s.vouchers.push({ id: "v1", customerId: "c1", code: "NC-AAAA-1111", status: "active", planId: "family", deviceLimit: 3,
    expiresAt: new Date(+now + 86400000).toISOString(), activatedAt: now.toISOString(), quotaBytes: 1e9, usedBytes: 20,
    routerSyncStatus: "synchronized", wifiDevicesAt: now.toISOString(), wifiDevices: [1, 2].map((n) => ({
      mac: `AA:BB:CC:DD:EE:0${n}`, name: n === 1 ? "imajin" : '<img src=x onerror="alert(1)">', address: `10.20.0.${n}`,
      sessionId: `*${n}`, startedAt: new Date(+now - 60000).toISOString(), usedBytes: 5,
    })) });
});
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", r));
const apiServer = http.createServer(); await listen(apiServer);
const api = `http://127.0.0.1:${apiServer.address().port}`;
const website = createStaticServer("customer", { apiUrl: api, hotspotLoginUrl: "https://connect.hotspot.test/login" });
await listen(website);
const portal = `http://127.0.0.1:${website.address().port}`;
const handler = createHandler({ store, router: {}, now: () => now, validateConfig: false, env: {
  NODE_ENV: "production", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
  CUSTOMER_APP_URL: portal, LOG_LEVEL: "warn", NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false",
  SECURITY_ALERTS_ENABLED: "false",
} });
apiServer.on("request", handler);
let browser;
const screenshots = "/tmp/ndahi-device-management-checks";
try {
  await mkdir(screenshots, { recursive: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
  await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(portal + "/dashboard");
  await page.locator("#wifiDeviceList").getByText("imajin", { exact: true }).waitFor();
  assert.equal(await page.locator("#wifiDeviceList img").count(), 0);
  console.log("PASS router-announced names render safely at 320px");
  await page.getByRole("button", { name: "Select main device", exact: true }).click();
  await page.locator('[data-main-proof] [name="mac"]').selectOption(mac);
  await page.locator('[data-main-proof] [name="confirm"]').check();
  await page.locator('[data-main-proof] [name="pin"]').fill("2468");
  await page.getByRole("button", { name: "Verify and select", exact: true }).click();
  await page.getByText("This browser controls connection approvals.", { exact: false }).waitFor();
  await page.locator("#wifiDeviceList").getByText("imajin · Main device", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("This browser controls connection approvals.", { exact: false }).waitFor();
  assert.ok((await store.snapshot()).customers[0].wifiMainDevice.controllerHash);
  console.log("PASS owner verification remembers the main browser across reloads");
  await page.getByRole("button", { name: "Verify to disconnect", exact: true }).click();
  await page.getByRole("heading", { name: "Disconnect main device", exact: true }).waitFor();
  assert.equal((await store.snapshot()).routerCommands.some((c) => c.action === "disconnect_wifi_device"), false);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.screenshot({ path: screenshots + "/main-device-320.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("PASS main-device disconnection requires a separate verification");
  await context.close();
} finally {
  await browser?.close();
  for (const server of [apiServer, website]) await new Promise((r) => { server.close(r); server.closeAllConnections(); });
}
