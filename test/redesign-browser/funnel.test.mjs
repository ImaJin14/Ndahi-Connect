import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";

// Wi-Fi page → paid funnel (#262, Insights): a visit that opens the Wi-Fi page
// signed out counts each step once (Wi-Fi page, payment started, paid, signed
// up) as anonymous v2 counts; a reload does not count twice, and a visit that
// did not start at the Wi-Fi page counts nothing. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const secret = "redesign-funnel-secret";

test("a visit from the Wi-Fi page to paid is counted once per step, anonymously", { timeout: 240000 }, async (t) => {
  const store = createStore({ persistent: false });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const staticServer = await listen(createStaticServer("customer", { apiUrl: api, hotspotLoginUrl: "https://hotspot.example.test/login", env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${staticServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: {
    NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
    PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent",
  } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(staticServer); });
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [], beacons = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (request.url().endsWith("/api/telemetry/funnel")) beacons.push(JSON.parse(request.postData())); });
    return { context, page, errors, beacons };
  };
  const counts = async () => (await store.snapshot()).insightCounters.find((r) => r.type === "funnel_daily" && r.variant === "v2")?.steps;
  const settle = (beacons, n) => new Promise((resolve, reject) => {
    const started = Date.now(), tick = async () => {
      const steps = await counts(), total = steps ? Object.values(steps).reduce((a, b) => a + b, 0) : 0;
      if (total >= n && beacons.length >= n) return resolve(steps);
      if (Date.now() - started > 10000) return reject(Error(`expected ${n} funnel steps, have ${total}`));
      setTimeout(tick, 100);
    };
    tick();
  });

  // A new buyer: Wi-Fi page, "I'm new", pay, then set a PIN.
  const { context, page, errors, beacons } = await open();
  await page.goto(`${portal}/hotspot?mac=AA%3ABB%3ACC%3ADD%3AEE%3A05&address=10.20.0.50`);
  await page.getByRole("heading", { name: "Connect to the internet.", exact: true }).waitFor();
  await settle(beacons, 1);
  await page.reload();
  await page.getByRole("heading", { name: "Connect to the internet.", exact: true }).waitFor();
  await page.getByRole("link", { name: /I'm new — buy a bundle/ }).click();
  await page.waitForURL(/\/onboarding\.html/);
  await page.locator('#plans button[data-plan="weekly"]:not([disabled])').click();
  await page.locator("#checkout").waitFor({ state: "visible" });
  await page.locator('#purchase [name="name"]').fill("Funnel buyer");
  await page.locator('#purchase [name="phone"]').fill("670055123");
  const acknowledge = page.locator('#purchase [name="acknowledge"]');
  if (await acknowledge.isVisible()) await acknowledge.check();
  await page.locator("#requestPayment").click();
  await page.getByRole("button", { name: "Simulate payment approval" }).click();
  await page.waitForURL(/\/verify\.html\?setup=checkout/);
  await page.locator('#verify [name="pin"]').fill("4829");
  await page.locator('#verify [name="confirmPin"]').fill("4829");
  await page.locator("#verify").getByRole("button").first().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/verify.html"));
  assert.deepEqual(await settle(beacons, 4), { wifi_page: 1, signed_in: 1, payment_started: 1, paid: 1 }, "the reload did not count the Wi-Fi page twice");
  // The beacons carry the step and the variant, nothing else.
  assert.deepEqual(beacons, [{ step: "wifi_page", variant: "v2" }, { step: "payment_started", variant: "v2" }, { step: "paid", variant: "v2" }, { step: "signed_in", variant: "v2" }]);
  const row = (await store.snapshot()).insightCounters.find((r) => r.type === "funnel_daily");
  assert.equal(JSON.stringify(row).includes("670055123"), false);
  assert.deepEqual(errors, []);
  await context.close();

  // A visit that never opened the Wi-Fi page: buying counts nothing.
  const direct = await open();
  await direct.page.goto(`${portal}/onboarding.html`);
  await direct.page.locator('#plans button[data-plan="weekly"]:not([disabled])').click();
  await direct.page.locator('#purchase [name="name"]').fill("Direct buyer");
  await direct.page.locator('#purchase [name="phone"]').fill("670055124");
  if (await direct.page.locator('#purchase [name="acknowledge"]').isVisible()) await direct.page.locator('#purchase [name="acknowledge"]').check();
  await direct.page.locator("#requestPayment").click();
  await direct.page.getByRole("button", { name: "Simulate payment approval" }).waitFor();
  assert.deepEqual(direct.beacons, []);
  assert.deepEqual(await counts(), { wifi_page: 1, signed_in: 1, payment_started: 1, paid: 1 });
  assert.deepEqual(direct.errors, []);
  await direct.context.close();
});
