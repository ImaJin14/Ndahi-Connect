import assert from "node:assert/strict";
import { createStaticServer } from "../static-server.mjs";

// Browser-only fixtures: all API/router requests are intercepted; no live credentials or networks.
const api = "http://api.hotspot.test", login = "https://connect.hotspot.test/login",
  website = createStaticServer("customer", { apiUrl: api, hotspotLoginUrl: login });
await new Promise((resolve, reject) => { website.once("error", reject); website.listen(0, "127.0.0.1", resolve); });
const portal = `http://127.0.0.1:${website.address().port}`;
let browser, checks = 0;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const device = (n) => ({ mac: `AA:BB:CC:DD:EE:0${n}`, address: `10.20.0.3${n}`, uptime: `${n}m`, usedBytes: n * 1e6 });
  async function scenario(name, work, { pending = false, unauthorized = false, fullSlots = false, exhausted = false } = {}) {
    const context = await browser.newContext(), page = await context.newPage(), posts = [], errors = [], disconnects = [];
    let devices = fullSlots ? [device(1), device(2)] : [device(1)];
    let credentials = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === portal) return route.continue();
      if (request.url() === login) {
        posts.push({ method: request.method(), fields: Object.fromEntries(new URLSearchParams(request.postData())) });
        return route.fulfill({ status: 200, contentType: "text/html", body: "<p>Router accepted login</p>" });
      }
      if (url.origin !== api) return route.abort("blockedbyclient");
      const headers = { "access-control-allow-origin": portal, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      let status = 200, body = {};
      if (url.pathname === "/api/account/access/begin") body = { token: "fixture-token", mode: "login" };
      if (url.pathname === "/api/network/status") body = { status: "up" };
      if (url.pathname === "/api/account/wifi-devices") body = { deviceLimit: 2, devices, syncedAt: "2030-01-01T00:00:00Z", csrfToken: "csrf-fixture" };
      if (url.pathname === "/api/account/wifi-devices/disconnect") {
        const { mac } = JSON.parse(request.postData());
        disconnects.push({ mac, csrf: request.headers()["x-csrf-token"] });
        devices = devices.filter((item) => item.mac !== mac);
        body = { deviceLimit: 2, devices, syncedAt: "2030-01-01T00:00:00Z" };
      }
      if (url.pathname === "/api/account/hotspot-credentials") {
        credentials++;
        if (unauthorized) { status = 401; body = { error: "Expired session" }; }
        else if (exhausted) { status = 409; body = { code: "QUOTA_EXHAUSTED", error: "Your bundle's data is used up. Renew or switch your plan to reconnect." }; }
        else if (pending && credentials === 1) { status = 202; body = { code: "HOTSPOT_PENDING" }; }
        else body = { username: "NC-TEST-1234", password: "NC-TEST-1234" };
      }
      return route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await work({ page, posts, disconnects, credentials: () => credentials });
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}`); checks++;
    } finally { await context.close(); }
  }
  await scenario("portal sign-in waits for provisioning then posts credentials to the fixed HTTPS router", async ({ page, posts, credentials }) => {
    await page.goto(`${portal}/login`);
    await page.locator('[name="phone"]').fill("670040001");
    await page.locator('[name="code"]').fill("NC-TEST-1234");
    await page.locator("#loginSubmit").click();
    await page.locator('[name="pin"]').fill("2468");
    await page.locator("#loginSubmit").click();
    await page.waitForURL(login);
    assert.ok(credentials() >= 2);
    assert.deepEqual(posts, [{ method: "POST", fields: { username: "NC-TEST-1234", password: "NC-TEST-1234", dst: `${portal}/dashboard`, popup: "false" } }]);
    assert.equal(new URL(page.url()).search, "");
  }, { pending: true });
  await scenario("router rejection waits for an explicit retry", async ({ page, posts, credentials }) => {
    await page.goto(`${portal}/hotspot?router-error=1`);
    await page.waitForFunction(() => document.getElementById("message").textContent.includes("not accepted"));
    assert.equal(credentials(), 0);
    assert.equal(posts.length, 0);
    await page.locator("#connect").click();
    await page.waitForURL(login);
    assert.equal(posts.length, 1);
  });
  await scenario("a refused login with every device slot in use lets the customer free one", async ({ page, posts, disconnects }) => {
    await page.goto(`${portal}/hotspot?router-error=1`);
    await page.getByText("All 2 device slots on your bundle are in use", { exact: false }).waitFor();
    assert.equal(await page.locator("#wifiDevices button[data-wifi-device]").count(), 2);
    await page.locator('#wifiDevices button[data-wifi-device="AA:BB:CC:DD:EE:01"]').click();
    await page.getByText("Device disconnected.", { exact: false }).waitFor();
    assert.deepEqual(disconnects, [{ mac: "AA:BB:CC:DD:EE:01", csrf: "csrf-fixture" }]);
    assert.equal(await page.locator("#wifiDevices button[data-wifi-device]").count(), 1);
    assert.equal(posts.length, 0);
    await page.locator("#connect").click();
    await page.waitForURL(login);
    assert.equal(posts.length, 1);
  }, { fullSlots: true });
  await scenario("a refused login with free device slots keeps the general router message", async ({ page }) => {
    await page.goto(`${portal}/hotspot?router-error=1`);
    await page.waitForFunction(() => document.getElementById("message").textContent.includes("not accepted"));
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#wifiDevices").isHidden(), true);
  });
  await scenario("a used-up bundle offers renewal instead of sending credentials", async ({ page, posts }) => {
    await page.goto(`${portal}/hotspot`);
    await page.getByText("Your bundle's data is used up.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Renew or switch plan", exact: true }).waitFor();
    assert.equal(posts.length, 0);
  }, { exhausted: true });
  await scenario("expired customer sessions return to portal sign-in without sending credentials", async ({ page, posts }) => {
    await page.goto(`${portal}/hotspot`);
    await page.waitForURL(`${portal}/login`);
    assert.equal(posts.length, 0);
  }, { unauthorized: true });
  await scenario("untrusted return destinations cannot redirect credentials or post-login navigation", async ({ page, posts }) => {
    await page.goto(`${portal}/hotspot?next=${encodeURIComponent("https://outside.test/steal")}`);
    await page.waitForURL(login);
    assert.equal(posts[0].fields.dst, `${portal}/dashboard`);
  });
  console.log(`${checks} HotSpot browser journeys passed.`);
} finally {
  await browser?.close();
  await new Promise((resolve) => { website.close(resolve); website.closeAllConnections(); });
}
