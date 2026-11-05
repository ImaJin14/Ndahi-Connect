import assert from "node:assert/strict";
import http from "node:http";
import { createHandler, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";

const portalWebsite = http.createServer();
await new Promise((resolve) => portalWebsite.listen(0, "127.0.0.1", resolve));
const portal = `http://127.0.0.1:${portalWebsite.address().port}`;

const store = createStore({ persistent: false });
const apiServer = http.createServer(createHandler({
  store,
  validateConfig: false,
  env: {
    NODE_ENV: "test",
    CUSTOMER_APP_URL: portal,
    PAYMENT_MODE: "mock",
    EMAIL_MODE: "mock",
    MIKROTIK_MODE: "mock",
    OMADA_MODE: "mock",
  },
}));
await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${apiServer.address().port}`;

const portalServer = createStaticServer("customer", {
  apiUrl,
  hotspotLoginUrl: "https://connect.hotspot.test/login",
});
portalWebsite.on("request", (req, res) => portalServer.emit("request", req, res));

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
});

const errors = [];
try {
  // 1. Hardware OUI MAC on onboarding and login does NOT trigger the banner
  {
    const context = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const page = await context.newPage();
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(`${portal}/onboarding.html?mac=B8:A3:86:5D:88:39&address=10.20.0.11`);
    await page.locator('[data-plan="daily"]').waitFor();
    assert.equal(await page.locator("#privateMacAdvisory").isVisible(), false, "hardware MAC must not show advisory on onboarding");

    await page.goto(`${portal}/login?mac=B8:A3:86:5D:88:39&address=10.20.0.11`);
    await page.locator("#loginSubmit").waitFor();
    assert.equal(await page.locator("#privateMacAdvisory").isVisible(), false, "hardware MAC must not show advisory on login");
    await context.close();
  }

  // 2. Randomized iOS MAC at 320px shows banner, highlights iOS, displays both iOS/Android toggle hints, and persists dismissal across pages
  {
    const context = await browser.newContext({
      viewport: { width: 320, height: 800 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    });
    const page = await context.newPage();
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(`${portal}/onboarding.html?mac=DA:A1:19:44:55:66&address=10.20.0.25`);
    const banner = page.locator("#privateMacAdvisory");
    await banner.waitFor({ state: "visible" });
    const text = await banner.textContent();
    assert.match(text, /Private Wi-Fi address detected/);
    assert.match(text, /DA:A1:19:44:55:66/);
    assert.match(text, /Settings → Wi-Fi → NDAHI Connect → Turn off "Private Wi-Fi Address"\./);
    assert.match(text, /Settings → Network → NDAHI Connect → Privacy → "Use device MAC"\./);
    assert.equal(
      await banner.locator(".private-mac-platform").first().getAttribute("data-mac-platform"),
      "ios",
      "iOS instructions appear first for iPhone user agents",
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflow, false, "320px viewport must not overflow horizontally");

    // Navigating to /login before dismissal still shows the banner
    await page.getByRole("link", { name: "Customer login", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/login");
    await page.locator("#privateMacAdvisory").waitFor({ state: "visible" });

    // Dismissing hides the banner and remembers choice across reloads and onboarding navigation
    await page.locator("[data-dismiss-mac-advisory]").click();
    assert.equal(await page.locator("#privateMacAdvisory").isVisible(), false);

    await page.reload();
    await page.locator("#loginSubmit").waitFor();
    assert.equal(await page.locator("#privateMacAdvisory").isVisible(), false, "dismissal persists across reload");

    await page.goto(`${portal}/onboarding.html?mac=DA:A1:19:44:55:66&address=10.20.0.25`);
    await page.locator('[data-plan="daily"]').waitFor();
    assert.equal(await page.locator("#privateMacAdvisory").isVisible(), false, "dismissal persists across onboarding navigation");
    await context.close();
  }

  // 3. Randomized Android MAC with storage blocked at 1280px still renders and dismisses cleanly without errors
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
    });
    await context.addInitScript(() => {
      for (const name of ["localStorage", "sessionStorage"]) {
        Object.defineProperty(window, name, {
          get() {
            throw new DOMException("Storage denied", "SecurityError");
          },
        });
      }
    });
    const page = await context.newPage();
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(`${portal}/login?mac=6E:22:33:44:55:77&address=10.20.0.44`);
    const banner = page.locator("#privateMacAdvisory");
    await banner.waitFor({ state: "visible" });
    assert.equal(
      await banner.locator(".private-mac-platform").first().getAttribute("data-mac-platform"),
      "android",
      "Android instructions appear first for Android user agents",
    );
    await page.locator("[data-dismiss-mac-advisory]").click();
    assert.equal(await banner.isVisible(), false);
    await context.close();
  }

  assert.deepEqual(errors, []);
  console.log("PASS private randomized MAC detection and dismissal browser journeys (320px/1280px, iOS/Android, blocked storage)");
} finally {
  await browser.close();
  await new Promise((resolve) => { portalWebsite.close(resolve); portalWebsite.closeAllConnections(); });
  await new Promise((resolve) => { apiServer.close(resolve); apiServer.closeAllConnections(); });
}
