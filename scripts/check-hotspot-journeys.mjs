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
  async function scenario(name, work, { pending = false, unauthorized = false } = {}) {
    const context = await browser.newContext(), page = await context.newPage(), posts = [], errors = [];
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
      if (url.pathname === "/api/account/hotspot-credentials") {
        credentials++;
        if (unauthorized) { status = 401; body = { error: "Expired session" }; }
        else if (pending && credentials === 1) { status = 202; body = { code: "HOTSPOT_PENDING" }; }
        else body = { username: "NC-TEST-1234", password: "NC-TEST-1234" };
      }
      return route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await work({ page, posts, credentials: () => credentials });
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
