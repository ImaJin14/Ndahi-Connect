import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Get connected (#250, canvas: ConnectFlow, PhoneHotspot, PhoneVoucher): the
// Wi-Fi landing offers the four ways online, each carrying this device's Wi-Fi
// details, with the network's own state; "I have a code" opens the voucher
// sign-in. Local servers only, signed out, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => {
  const server = await listen(http.createServer());
  const port = server.address().port;
  await close(server);
  return port;
};
const secret = "redesign-get-connected-secret";
const OPTIONS = [
  ["I have an account", "Sign in with your phone and PIN", "/login"],
  ["I have a code", "A voucher slip or a gift — type it or scan the QR", "/login"],
  ["Use a bundle from another phone", "Enter the pairing code from its owner", "/pair"],
  ["I'm new — buy a bundle", "Pay with MTN MoMo or Orange Money", "/onboarding.html"],
];

test("the Wi-Fi landing offers the four ways online with the network's state", { timeout: 180000 }, async (t) => {
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
  const screenshots = "/tmp/ndahi-get-connected";
  await mkdir(screenshots, { recursive: true });
  t.after(async () => { await browser.close(); await close(apiServer); await close(staticServer); });

  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${portal}/hotspot?mac=AA%3ABB%3ACC%3ADD%3AEE%3A03&address=10.20.0.30`);
      await page.getByRole("heading", { name: "Connect to the internet.", exact: true }).waitFor();
      const options = page.locator(".portal-hotspot__opt");
      assert.equal(await options.count(), 4);
      for (const [index, [title, hint, path]] of OPTIONS.entries()) {
        const option = options.nth(index);
        assert.equal(await option.locator("strong").textContent(), title);
        assert.equal(await option.locator(".portal-hotspot__text span").textContent(), hint);
        const href = new URL(await option.getAttribute("href"), portal);
        assert.equal(href.pathname, path, title);
        assert.equal(href.searchParams.get("mac"), "AA:BB:CC:DD:EE:03", `${title} carries this device's Wi-Fi details`);
      }
      assert.equal(new URL(await options.nth(1).getAttribute("href"), portal).searchParams.get("voucher"), "1", "\"I have a code\" opens the voucher sign-in");
      assert.match(await options.nth(3).getAttribute("class"), /portal-hotspot__opt--new/, "\"I'm new\" is the forest card");
      // The network's own state from /api/status: online in this store.
      await page.getByText("Network is working normally.", { exact: true }).waitFor();
      assert.equal(await page.locator("#hotspotStatus").getAttribute("data-status"), "online");
      assert.deepEqual(await lowContrastText(page), [], `contrast at ${width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
      await page.screenshot({ path: `${screenshots}/hotspot-${width}.png`, fullPage: true });
      if (width === 390) {
        await options.nth(1).click();
        await page.waitForURL(/\/login\?/);
        await page.locator('#login [name="code"]').waitFor();
        assert.equal(await page.locator("body").getAttribute("data-login-mode"), "voucher");
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }

  // "Scan the QR instead" explains scanning a slip with the phone's camera.
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  const page = await context.newPage();
  await page.goto(`${portal}/help#scan-qr`);
  const entry = page.locator("details#scan-qr");
  await entry.waitFor();
  assert.equal(await entry.evaluate((element) => element.open), true);
  await entry.getByText(/point it at the QR on your voucher slip/).waitFor();
  await context.close();
});
