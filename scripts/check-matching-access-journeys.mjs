import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import jsQR from "jsqr";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture, publicRoot, ownerRoot, guestMac } from "../test/helpers/wifi-pairing-fixture.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
let checks = 0;
async function harness(width) {
  const website = http.createServer(); await new Promise(r => website.listen(0, "127.0.0.1", r));
  const portal = `http://127.0.0.1:${website.address().port}`, f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true });
  const staticServer = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.matching.test/login" });
  website.on("request", (req, res) => staticServer.emit("request", req, res));
  const contexts = [], errors = [], handoffs = [];
  const pairUrl = portal + "/pair?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.30";
  async function context(role, blockedStorage = false) {
    const c = await browser.newContext({ viewport: { width, height: 950 } }); contexts.push(c);
    await c.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === "https://connect.matching.test") { handoffs.push(url.href); assert.equal(route.request().method(), "GET"); assert.equal(url.searchParams.get("dst"), portal + "/wifi-connected.html"); return route.fulfill({ status: 302, headers: { location: url.searchParams.get("dst") } }); }
      if (![portal, f.api].includes(url.origin)) return route.abort("blockedbyclient");
      return route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } });
    });
    if (role !== "guest") await c.addCookies([{ name: "customer_session", value: role, domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }, ...(role === "main" ? [{ name: "ndahi_main_device", value: "controller", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }] : [])]);
    if (blockedStorage) await c.addInitScript(() => { for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(window, key, { get() { throw new DOMException("Storage denied", "SecurityError"); } }); });
    const page = await c.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", e => errors.push(e.message)); return { page, context: c };
  }
  return { f, portal, pairUrl, context, errors, handoffs, async close() { for (const c of contexts) await c.close(); await f.close(); await new Promise(r => { website.close(r); website.closeAllConnections(); }); } };
}
async function noOverflow(...pages) { for (const p of pages) assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); }
try {
  await mkdir("/tmp/ndahi-matching-access-screens", { recursive: true });
  for (const width of [320, 1280]) {
    let h = await harness(width);
    try {
      const { page: guest } = await h.context("secondary"), { page: main } = await h.context("main"), { page: wrong } = await h.context("secondary");
      await guest.goto(h.pairUrl); await guest.getByRole("button", { name: "Request Wi-Fi access", exact: true }).waitFor();
      assert.equal(await guest.getByLabel("Account phone number", { exact: true }).isVisible(), false);
      const posted = guest.waitForRequest(r => r.url().endsWith(ownerRoot + "/request"));
      await guest.getByRole("button", { name: "Request Wi-Fi access", exact: true }).click();
      const payload = (await posted).postDataJSON(); assert.equal(payload.phone, undefined); assert.equal(payload.code, undefined); assert.equal(payload.pin, undefined);
      await guest.locator("#pairingReferenceCode").filter({ hasText: /\d{3} \d{3}/ }).waitFor();
      assert.equal(await guest.locator("#pairingRedeem").isVisible(), false);
      const pixels = await guest.locator("#pairingQr").evaluate(async img => { await img.decode(); const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0); return { width: canvas.width, height: canvas.height, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) }; });
      const qr = jsQR(Uint8ClampedArray.from(pixels.data), pixels.width, pixels.height); assert.ok(qr);
      const review = new URL(qr.data); assert.equal(review.origin, h.portal); assert.equal(review.pathname, "/pair-review.html"); assert.equal(review.searchParams.size, 1); assert.equal(review.hash, "");
      await wrong.goto(qr.data); await wrong.getByText(/Use the browser or installed app registered as your main device/).waitFor();
      assert.equal(await wrong.getByRole("button", { name: "Codes match — allow device" }).count(), 0); assert.equal(h.f.calls.length, 0);
      await main.goto(qr.data); const approval = main.getByRole("button", { name: "Codes match — allow device", exact: true }); await approval.waitFor();
      await main.route("**" + ownerRoot + "?request=*", route => route.fulfill({ status: 503, headers: { "access-control-allow-origin": h.portal, "access-control-allow-credentials": "true" }, contentType: "application/json", body: JSON.stringify({ error: "Synthetic temporary review failure" }) }), { times: 1 });
      await main.getByRole("button", { name: "Refresh request", exact: true }).click(); await main.getByText("Service temporarily unavailable", { exact: true }).waitFor();
      await main.getByRole("button", { name: "Refresh request", exact: true }).click(); await main.waitForFunction(() => document.getElementById("pairingReviewMessage").textContent === "");
      assert.equal(await main.getByLabel("Matching request code", { exact: true }).textContent(), await guest.getByLabel("Matching request code", { exact: true }).textContent());
      assert.equal((await h.f.store.snapshot()).routerCommands.filter(c => c.action === "connect_wifi_device").length, 0);
      await noOverflow(guest, main, wrong);
      await guest.screenshot({ path: `/tmp/ndahi-matching-access-screens/request-${width}.png`, fullPage: true });
      await main.screenshot({ path: `/tmp/ndahi-matching-access-screens/review-${width}.png`, fullPage: true });
      await approval.focus(); await main.keyboard.press("Enter"); await main.getByText("Connecting — waiting for the router to confirm.", { exact: true }).waitFor();
      assert.equal(h.f.calls.length, 0); assert.equal(h.handoffs.length, 0);
      await h.f.process(); await guest.waitForURL(h.portal + "/wifi-connected.html");
      assert.equal(h.f.calls.length, 1); assert.equal(h.handoffs.length, 1); assert.equal(new URL(guest.url()).hash, "");
      assert.deepEqual(h.errors, []); console.log(`PASS signed-in request without repeated credentials, actual QR decode, main-only match and router-confirmed completion at ${width}px`); checks++;
    } finally { await h.close(); }
    h = await harness(width);
    try {
      const { page } = await h.context("secondary", true); await page.goto(h.pairUrl);
      await page.getByRole("button", { name: "Request Wi-Fi access", exact: true }).waitFor();
      await page.route("**" + ownerRoot + "/request", async route => { await route.fetch({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }); await route.abort("failed"); }, { times: 1 });
      await page.getByRole("button", { name: "Request Wi-Fi access", exact: true }).click();
      await page.locator('#pairingMessage [role="alert"]').waitFor();
      const pending = (await h.f.store.snapshot()).wifiPairingRequests[0]; assert.ok(pending);
      await page.reload(); await page.getByLabel("Matching request code", { exact: true }).filter({ hasText: /\d{3} \d{3}/ }).waitFor();
      await page.reload(); await page.getByLabel("Matching request code", { exact: true }).filter({ hasText: /\d{3} \d{3}/ }).waitFor();
      assert.equal((await h.f.store.snapshot()).wifiPairingRequests.length, 1); assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("request"), pending.id);
      assert.equal(await page.getByLabel("Account phone number", { exact: true }).isVisible(), false);
      h.f.advance(301); await page.reload(); await page.locator("#pairingStatus").filter({ hasText: /expired/ }).waitFor();
      assert.equal(await page.locator("#pairingReference").isVisible(), false);
      assert.equal(await page.locator(".pair-progress").isVisible(), false);
      await page.getByRole("button", { name: "Request access again", exact: true }).click();
      await page.getByRole("button", { name: "Request Wi-Fi access", exact: true }).waitFor();
      assert.equal(await page.getByLabel("Account phone number", { exact: true }).isVisible(), false);
      await page.getByRole("button", { name: "Request Wi-Fi access", exact: true }).click();
      await page.getByLabel("Matching request code", { exact: true }).filter({ hasText: /\d{3} \d{3}/ }).waitFor();
      let release, captured;
      const held = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { captured = resolve; });
      await page.route("**" + publicRoot + "/status", async route => {
        const response = await route.fetch({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } });
        assert.equal(response.status(), 200); captured(); await held; await route.fulfill({ response });
      }, { times: 1 });
      h.f.advance(2); await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await observed;
      await page.getByRole("button", { name: "Cancel request", exact: true }).click();
      await page.locator("#pairingStatus").filter({ hasText: /cancelled/ }).waitFor();
      const late = page.waitForResponse(r => r.url().endsWith(publicRoot + "/status")); release(); await late;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.match(await page.locator("#pairingStatus").textContent(), /cancelled/);
      assert.equal(await page.locator("#pairingReference").isVisible(), false);
      assert.equal(await page.locator(".pair-progress").isVisible(), false);
      await noOverflow(page); assert.deepEqual(h.errors, []);
      console.log(`PASS committed lost reply, denied storage, rapid reload/throttle, expiry and cancellation despite a delayed poll at ${width}px`); checks++;
    } finally { await h.close(); }
    h = await harness(width);
    try {
      const { page, context } = await h.context("guest"), { page: main } = await h.context("main");
      await page.goto(h.pairUrl.replace("/pair?", "/login?"));
      await page.locator('input[name="phone"]').fill("670050001"); await page.locator('input[name="code"]').fill("NC-AAAA-1111");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Request access", exact: true }).click();
      await page.waitForURL(u => u.pathname === "/pair"); await page.getByLabel("Matching request code", { exact: true }).filter({ hasText: /\d{3} \d{3}/ }).waitFor();
      assert.equal(await page.getByLabel("Account phone number", { exact: true }).isVisible(), false); assert.equal((await context.cookies()).some(c => c.name === "customer_session"), false);
      const row = (await h.f.store.snapshot()).wifiPairingRequests[0]; assert.equal(row.protocol, 3);
      await main.goto(h.portal + "/pair-review.html?request=" + row.id);
      await main.getByRole("button", { name: "Decline", exact: true }).click();
      await page.locator("#pairingStatus").filter({ hasText: /declined/ }).waitFor(); assert.equal(h.f.calls.length, 0); assert.equal(h.handoffs.length, 0);
      await noOverflow(page, main); assert.deepEqual(h.errors, []);
      console.log(`PASS captive details carried forward once, no account session/PIN, and main decline at ${width}px`); checks++;
    } finally { await h.close(); }
    h = await harness(width);
    try {
      const { page } = await h.context("secondary", true), { page: main } = await h.context("main");
      await page.goto(h.pairUrl.replace("/pair?", "/hotspot?"));
      const started = page.waitForRequest(r => r.url().endsWith(ownerRoot + "/request"));
      await page.getByRole("link", { name: "Request access", exact: true }).click();
      assert.equal((await started).postDataJSON().phone, undefined);
      await page.waitForURL(u => u.pathname === "/pair"); await page.getByLabel("Matching request code", { exact: true }).filter({ hasText: /\d{3} \d{3}/ }).waitFor();
      assert.equal(await page.getByLabel("Account phone number", { exact: true }).isVisible(), false);
      const pending = (await h.f.store.snapshot()).wifiPairingRequests[0];
      await main.goto(h.portal + "/dashboard"); await main.getByRole("button", { name: /^Notifications/ }).click();
      const item = main.locator('[data-notification-id="device:' + pending.id + '"]');
      const open = item.getByRole("link", { name: "Review", exact: true });
      assert.equal(await open.getAttribute("href"), "/pair-review.html?request=" + pending.id);
      await open.click(); await main.getByRole("button", { name: "Codes match — allow device", exact: true }).waitFor();
      assert.equal((await h.f.store.snapshot()).routerCommands.filter(c => c.action === "connect_wifi_device").length, 0);
      await noOverflow(page, main); assert.deepEqual(h.errors, []);
      console.log(`PASS signed-in HotSpot action and exact notification review without repeated details or scan/navigation authorization at ${width}px`); checks++;
    } finally { await h.close(); }
  }
  const h = await harness(320);
  try {
    const request = await h.f.request(), r = request.body.request, { page } = await h.context("guest");
    await page.goto(h.pairUrl + "#request=" + r.id + "&key=" + request.requestKey);
    const issued = await h.f.call(ownerRoot + "/approve", { id: r.id });
    await page.getByLabel("Approval code from your main device").waitFor(); await page.getByLabel("Approval code from your main device").fill(issued.body.approvalCode);
    const redeemed=page.waitForResponse(r=>r.url().endsWith(publicRoot+"/redeem")&&r.status()===202); await page.getByRole("button", { name: "Enter code and connect" }).click(); await redeemed; await h.f.process(); await page.waitForURL(h.portal + "/wifi-connected.html");
    assert.equal(h.f.calls.length, 1); assert.deepEqual(h.errors, []); console.log("PASS legacy in-flight code-entry request remains safely completable"); checks++;
  } finally { await h.close(); }
  console.log(`Completed ${checks} matching access browser journeys.`);
} finally { await browser.close(); }
