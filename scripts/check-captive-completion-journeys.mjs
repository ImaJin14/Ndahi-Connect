import assert from "node:assert/strict";
import { createStaticServer } from "../static-server.mjs";

// Browser security/UX fixtures only. Real approval/router transitions are tested
// separately by check-wifi-pairing-journeys.mjs; no live networks are modified.
const api = "http://api.captive.test", login = "https://connect.captive.test/login";
const website = createStaticServer("customer", { apiUrl: api, hotspotLoginUrl: login });
await new Promise((resolve) => website.listen(0, "127.0.0.1", resolve));
const portal = `http://127.0.0.1:${website.address().port}`;
const key = "b".repeat(32), id = "11111111-2222-4333-8444-555555555555";
let browser, checks = 0;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function scenario(name, { state = "connected", ready = true, blockedStorage = false, configuredLogin = login, direct = false, wrongCode = false, keepOpen = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
    const page = await context.newPage(), handoffs = [], errors = [], accountRequests = [], cleanedUrls = [];
    page.setDefaultTimeout(10000); page.on("pageerror", (error) => errors.push(error.message));
    try {
      await context.exposeBinding("recordCleanUrl", (_, url) => cleanedUrls.push(url));
      await context.addInitScript(({ blockedStorage }) => {
        const replace = history.replaceState.bind(history);
        history.replaceState = (data, unused, url) => { replace(data, unused, url); void window.recordCleanUrl(location.href); };
        if (blockedStorage) for (const store of ["sessionStorage", "localStorage"]) {
          Object.defineProperty(window, store, { get() { throw new DOMException("Storage denied", "SecurityError"); } });
        }
      }, { blockedStorage });
      await context.route("**/*", async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === portal) {
          if (url.pathname === "/config.js" && configuredLogin !== login) return route.fulfill({ contentType: "text/javascript", body: "window.NDAHI_CONFIG=" + JSON.stringify({ apiUrl: api, hotspotLoginUrl: configuredLogin }) });
          return route.continue();
        }
        if (url.origin === new URL(login).origin) {
          assert.equal(request.method(), "GET"); assert.equal(request.postData(), null);
          assert.equal(url.pathname, "/login");
          assert.deepEqual([...url.searchParams], [["dst", portal + "/wifi-connected.html"], ["popup", "false"]]);
          assert.equal(request.headers().referer, undefined);
          handoffs.push(url.href);
          // A response that leaves the document open must retain a usable Done
          // action. This is a browser fixture, not a simulated OS close API.
          if (keepOpen && handoffs.length === 1) return route.fulfill({ status: 204 });
          return route.fulfill({ status: 302, headers: { location: url.searchParams.get("dst") } });
        }
        if (url.origin !== api) return route.abort("blockedbyclient");
        const headers = { "access-control-allow-origin": portal, "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname.startsWith("/api/account/")) accountRequests.push(url.pathname);
        if (wrongCode && url.pathname.endsWith("/redeem")) return route.fulfill({ status: 401, headers, json: { error: "Approval code was not accepted." } });
        assert.equal(url.pathname, "/api/wifi/pairing/status");
        assert.deepEqual(request.postDataJSON(), { id, key, includeQr: true });
        return route.fulfill({ headers, json: { request: { id, status: state, completionReady: ready,
          updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() } } });
      });
      const source = portal + "/pair?mac=AA%3ABB%3ACC%3ADD%3AEE%3A03&address=10.20.0.30&next=https%3A%2F%2Fevil.test#key=" + key + "&request=" + id;
      await page.goto(direct ? portal + "/wifi-connected.html?next=https%3A%2F%2Fevil.test" : source);
      if (!direct && state === "connected" && ready) {
        if (keepOpen) {
          await page.getByRole("button", { name: "Done", exact: true }).waitFor();
          assert.equal(handoffs.length, 1);
          assert.equal(new URL(page.url()).hash, "");
          // Playwright's locator action waits for a cancelled 204 navigation;
          // focus the retained document directly, then use a real key event.
          await page.evaluate(() => document.getElementById("pairingDone").focus());
          await page.keyboard.press("Enter");
        }
        await page.waitForURL(portal + "/wifi-connected.html");
        await page.getByRole("heading", { name: "Finish Wi-Fi sign-in." }).waitFor();
        const expectedHandoffs = configuredLogin === login ? keepOpen ? 2 : 1 : 0;
        assert.equal(handoffs.length, expectedHandoffs);
        assert.ok(cleanedUrls.some((value) => !new URL(value).hash && new URL(value).pathname === "/pair"), "clean bearer fragment before leaving the pairing document");
        if (!blockedStorage) assert.equal(await page.evaluate(() => sessionStorage.getItem("ndahi_pairing")), null);
        await page.reload(); assert.equal(handoffs.length, expectedHandoffs);
        assert.equal(await page.isClosed(), false, "ordinary browser tab is not force-closed");
      } else if (direct) {
        await page.getByRole("heading", { name: "Finish Wi-Fi sign-in." }).waitFor();
        assert.equal(handoffs.length, 0);
        assert.equal(await page.getByText("Connected", { exact: true }).count(), 0, "public bookmark must not claim a live connection");
      } else {
        await page.locator("#pairingStatus").filter({ hasText: state === "pending" ? "waiting" : state === "awaiting_code" ? "Approved" : state === "connecting" ? "Connecting" : state === "connected" ? "no longer confirmed" : state }).waitFor();
        assert.equal(await page.locator("#pairingCompletion").isVisible(), false);
        assert.equal(handoffs.length, 0);
        if (state === "connected") assert.equal(await page.getByRole("button", { name: "Request access again", exact: true }).isVisible(), true);
        if (wrongCode) {
          await page.getByLabel("Approval code from your main device").fill("000000");
          await page.getByRole("button", { name: "Enter code and connect" }).click();
          await page.locator("#pairingMessage").filter({ hasText: "Approval code was not accepted" }).waitFor();
          assert.equal(handoffs.length, 0);
        }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(accountRequests, []); assert.deepEqual(errors, []);
      console.log("PASS " + name); checks++;
    } finally { await context.close(); }
  }
  await scenario("confirmed guest completes native sign-in once without leaking bearer state or granting account access");
  await scenario("confirmed guest completion survives denied storage", { blockedStorage: true });
  await scenario("Done remains keyboard-usable when the native handoff leaves the sign-in window open", { keepOpen: true });
  await scenario("missing router configuration uses the local completion fallback", { configuredLogin: "" });
  await scenario("untrusted router configuration cannot select a completion destination", { configuredLogin: "https://connect.captive.test/login?dst=https://evil.test" });
  for (const state of ["pending", "awaiting_code", "connecting", "failed", "expired", "declined", "cancelled"]) {
    await scenario(state + " never finishes captive sign-in", { state, ready: false });
  }
  await scenario("wrong approval code remains actionable without completion", { state: "awaiting_code", ready: false, wrongCode: true });
  await scenario("historical Connected requires a fresh connection attempt", { ready: false });
  await scenario("opening the public completion page directly does not redirect, sign in or claim connectivity", { direct: true });
  console.log(`Completed ${checks} captive completion browser checks.`);
} finally {
  await browser?.close();
  await new Promise((resolve) => { website.close(resolve); website.closeAllConnections(); });
}
