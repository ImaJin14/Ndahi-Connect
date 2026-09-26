import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";

// Optional browser check. Install Playwright separately and set
// PLAYWRIGHT_MODULE to its index.mjs when it is outside this project.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const store = createStore({ persistent: false });
const api = createServer({ store, env: {
  NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  ADMIN_PIN: "9999", ADMIN_SESSION_SECRET: "network-browser-test-secret", SECRET_PEPPER: "test-only",
  SESSION_COOKIE_SECURE: "false", NETWORK_CONFIG_KEY: "a".repeat(64), NETWORK_ALLOWED_ORIGINS: "", NETWORK_PROVISIONING_ENABLED: "false",
  ADMIN_APP_URL: "http://127.0.0.1:18981", ALLOWED_ADMIN_ORIGINS: "http://127.0.0.1:18981",
} });
const listen = (server, port) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
await listen(api, 18982);
const web = createStaticServer("admin", { apiUrl: "http://127.0.0.1:18982", production: false });
await listen(web, 18981);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const login = await context.request.post("http://127.0.0.1:18982/api/admin/login", { data: { pin: "9999" } });
  assert.equal(login.status(), 200);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:18981/dashboard");
  await page.getByRole("tab", { name: "Network setup", exact: true }).click();
  await page.locator("#networkRouterConnection select").selectOption("simulation");
  await page.getByRole("button", { name: "Save router connection", exact: true }).click();
  await page.getByText("router connection saved.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Discover router", exact: true }).click();
  await page.locator('#networkRouterConfig select[name="apPort"] option[value="ether2"]').waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Preview router changes", exact: true }).click();
  await page.getByRole("heading", { name: "3. Review router changes", exact: true }).waitFor();
  await page.locator("#networkReviewed").check();
  await page.getByRole("button", { name: "Run simulation", exact: true }).click();
  await page.getByRole("button", { name: "Keep changes", exact: true }).waitFor();
  await page.locator("[data-tested]").check();
  await page.getByRole("button", { name: "Keep changes", exact: true }).click();
  await page.getByRole("heading", { name: "router · simulation · completed", exact: true }).waitFor();
  const output = process.env.NETWORK_QA_DIR || "/tmp/ndahi-network-qa";
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "mobile page must not overflow horizontally");
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", checks: ["owner login", "simulation connection", "discovery", "preview", "apply", "confirm", "mobile overflow", "browser errors"], screenshots: output }));
} finally {
  await browser?.close();
  await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => web.close(r))]);
}
