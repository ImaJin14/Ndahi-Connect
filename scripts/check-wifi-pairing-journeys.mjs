import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture, publicRoot, ownerRoot, guestMac } from "../test/helpers/wifi-pairing-fixture.mjs";

const website = http.createServer();
await new Promise((r) => website.listen(0, "127.0.0.1", r));
const portal = `http://127.0.0.1:${website.address().port}`;
const hostileName = '<img src=x onerror="alert(1)">';
const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, router: {
  async readGuestDevice({ mac, address }) { return { mac, address, loginAddress: address, hostId: "*guest-" + mac.slice(-2), server: "ndahi-hotspot", name: mac === guestMac ? "Galaxy Note 8" : hostileName }; },
} });
const staticServer = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.hotspot.test/login" });
website.on("request", (req, res) => staticServer.emit("request", req, res));
const screenshots = "/tmp/ndahi-pairing-checks", errors = [], handoffs = [];
let browser;
try {
  await mkdir(screenshots, { recursive: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const contexts = [];
  async function context({ owner = false, blockedStorage = false } = {}) {
    const c = await browser.newContext({ viewport: { width: 320, height: 900 } }); contexts.push(c);
    await c.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "https://connect.hotspot.test") {
        assert.equal(route.request().method(), "GET"); assert.equal(url.pathname, "/login");
        assert.deepEqual([...url.searchParams], [["dst", portal + "/wifi-connected.html"], ["popup", "false"]]);
        assert.equal(route.request().headers().referer, undefined);
        handoffs.push(url.href);
        return route.fulfill({ status: 302, headers: { location: url.searchParams.get("dst") } });
      }
      if (![f.api, portal].includes(new URL(route.request().url()).origin)) return route.abort("blockedbyclient");
      return route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } });
    });
    if (owner) await c.addCookies([
      { name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" },
      { name: "ndahi_main_device", value: "controller", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" },
    ]);
    if (blockedStorage) await c.addInitScript(() => {
      for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(window, key, { get() { throw new DOMException("Storage denied", "SecurityError"); } });
      Object.defineProperty(AbortSignal, "timeout", { value: undefined });
    });
    const page = await c.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", (e) => errors.push(e.message));
    return { c, page };
  }
  const { page: owner } = await context({ owner: true }), { c: guestContext, page: guest } = await context({ blockedStorage: true });
  await owner.goto(portal + "/dashboard#devices");
  await owner.getByText("This browser controls connection approvals.", { exact: false }).waitFor();
  const pairUrl = portal + "/pair?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.30";
  await guest.goto(pairUrl.replace("/pair?", "/onboarding.html?"));
  await guest.getByRole("link", { name: "Connect using your main device", exact: true }).click();
  await guest.getByLabel("Account phone number", { exact: true }).fill("670050001");
  await guest.getByLabel("Active voucher code", { exact: true }).fill("NC-AAAA-1111");
  // The API commits, then the reply is lost. Retrying must keep the same request.
  let originalKey;
  await guest.route("**/api/wifi/pairing/request", async (route) => { originalKey = route.request().postDataJSON().key; await route.fetch({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }); await route.abort("failed"); }, { times: 1 });
  await guest.getByRole("button", { name: "Request access", exact: true }).click();
  await guest.locator("#pairingMessage").filter({ hasText: /network|reach|fetch|connection/i }).waitFor();
  await guest.reload();
  assert.equal(await guest.getByLabel("Account phone number", { exact: true }).isVisible(), false);
  await guest.locator("#pairingStatus").filter({ hasText: /waiting for your main device/i }).waitFor().catch(async (e) => {
    console.error(await guest.locator("#pairingMessage").textContent()); throw e;
  });
  assert.equal(await guest.locator("#pairingCode").count(), 0);
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 1);
  await guest.reload();
  await guest.locator("#pairingStatus").filter({ hasText: /waiting for your main device/i }).waitFor();
  assert.equal(new URL(guest.url()).searchParams.get("mac"), guestMac);
  assert.equal(new URL(guest.url()).searchParams.get("address"), "10.20.0.30"); assert.doesNotMatch(guest.url(), /670050001|NC-AAAA/);
  assert.equal(await guest.getByRole("link", { name: "Open Wi-Fi sign-in", exact: true }).getAttribute("href"), "https://connect.hotspot.test/login");
  assert.equal((await guestContext.cookies()).some((c) => c.name === "customer_session"), false);
  console.log("PASS lost-response retry and reload preserve one request with storage and AbortSignal.timeout unavailable");
  await owner.getByRole("button", { name: "Refresh requests", exact: true }).click();
  const row = owner.locator("[data-request]").first();
  await row.getByText("Galaxy Note 8 · ending EE:03", { exact: true }).waitFor();
  const displayed = await row.getByLabel("Matching request code", { exact: true }).textContent();
  assert.match(displayed, /^\d{3} \d{3}$/);
  assert.equal(displayed, await guest.getByLabel("Matching request code", { exact: true }).textContent());
  assert.equal(f.calls.length, 0, "displaying a reference must not connect the guest");
  assert.equal(handoffs.length, 0, "displaying a reference must not finish captive sign-in");
  await row.getByRole("button", { name: "Codes match — allow device", exact: true }).click();
  await row.getByText("Connecting — waiting for the router", { exact: true }).waitFor();
  assert.equal(f.calls.length, 0);
  assert.equal(handoffs.length, 0, "queued connection is not confirmation");
  await f.process();
  await guest.waitForURL(portal + "/wifi-connected.html");
  await guest.getByRole("heading", { name: "Finish Wi-Fi sign-in." }).waitFor();
  await row.waitFor({ state: "detached" });
  assert.equal(f.calls.length, 1); assert.equal(handoffs.length, 1); assert.equal(new URL(guest.url()).hash, "");
  await guest.reload(); assert.equal(handoffs.length, 1, "public completion reload must not repeat router handoff");
  const denied = await guest.request.get(f.api + "/api/account/dashboard", { headers: { origin: portal } }); assert.equal(denied.status(), 401);
  for (const page of [owner, guest]) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await guest.screenshot({ path: screenshots + "/guest-connected-320.png", fullPage: true });
  await owner.screenshot({ path: screenshots + "/main-approval-320.png", fullPage: true });
  console.log("PASS two independent browsers approve and finish native captive sign-in once without granting the guest an account session");

  const previousMain = (await f.store.snapshot()).customers[0].wifiMainDevice;
  await f.store.transaction((s) => { s.vouchers[0].wifiDevices = []; s.vouchers[0].wifiDevicesAt = f.now().toISOString(); });
  await guest.goto(pairUrl);
  await guest.getByLabel("Account phone number", { exact: true }).fill("670050001");
  await guest.getByLabel("Active voucher code", { exact: true }).fill("NC-AAAA-1111");
  const guestReconnecting = guest.waitForResponse((r) => r.url().endsWith("/api/wifi/pairing/request") && r.status() === 202);
  await guest.getByRole("button", { name: "Request access", exact: true }).click();
  const guestReconnect = await guestReconnecting, guestReconnectBody = await guestReconnect.json();
  assert.notEqual(guestReconnect.request().postDataJSON().key, originalKey);
  const guestOperation = (await f.store.snapshot()).wifiPairingRequests.find((p) => p.id === guestReconnectBody.request.id);
  assert.equal(guestOperation.kind, "reconnect");
  assert.equal(handoffs.length, 1, "saved approval does not replace fresh router confirmation");
  await f.process(guestOperation.commandId);
  await guest.waitForURL(portal + "/wifi-connected.html");
  assert.equal(handoffs.length, 2); assert.equal(f.calls.length, 2);
  assert.equal((await guestContext.cookies()).some((c) => c.name === "customer_session"), false);
  assert.deepEqual((await f.store.snapshot()).customers[0].wifiMainDevice, previousMain);
  console.log("PASS approved guest reconnect after router-session loss finishes captive sign-in without another code or an account session");
  await f.store.transaction((s) => { s.vouchers[0].wifiDevices = []; s.vouchers[0].wifiDevicesAt = f.now().toISOString(); });
  const reconnecting = owner.waitForResponse((r) => r.url().endsWith("/api/account/device-management/connect") && r.status() === 202);
  await owner.goto(portal + "/hotspot?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.95#wifi_key=" + originalKey);
  const reconnectReply = await reconnecting, reconnectBody = await reconnectReply.json();
  assert.notEqual(reconnectReply.request().postDataJSON().key, originalKey);
  const reconnectRequest = (await f.store.snapshot()).wifiPairingRequests.find((p) => p.id === reconnectBody.request.id);
  assert.equal(reconnectRequest.target.address, "10.20.0.95"); assert.equal(reconnectRequest.kind, "reconnect");
  assert.equal(f.calls.length, 2, "old completion must not count as fresh router confirmation");
  await f.process(reconnectRequest.commandId); await owner.waitForURL(/\/dashboard/);
  assert.equal(f.calls.length, 3); assert.deepEqual((await f.store.snapshot()).customers[0].wifiMainDevice, previousMain);
  await owner.goto(portal + "/dashboard#devices");
  console.log("PASS a restored connection URL starts a fresh grant-authorized reconnect after router session/IP changes, preserving main identity");

  await f.store.transaction((s) => { s.vouchers[0].deviceLimit = 5; });
  const { page: expired } = await context({ blockedStorage: true });
  await expired.goto(portal + "/pair?mac=AA%3ABB%3ACC%3ADD%3AEE%3A04&address=10.20.0.40");
  await expired.getByLabel("Account phone number", { exact: true }).fill("670050001");
  await expired.getByLabel("Active voucher code", { exact: true }).fill("NC-AAAA-1111");
  await expired.getByRole("button", { name: "Request access", exact: true }).click();
  await expired.locator("#pairingStatus").filter({ hasText: /waiting for your main device/i }).waitFor();
  await expired.reload();
  await expired.locator("#pairingStatus").filter({ hasText: /waiting for your main device/i }).waitFor();
  f.advance(301);
  await expired.locator("#pairingStatus").filter({ hasText: "expired" }).waitFor();
  assert.equal(await expired.locator("#pairingRedeem").isHidden(), true);
  await expired.getByRole("button", { name: "Request access again", exact: true }).waitFor();
  await owner.getByRole("button", { name: "Refresh requests", exact: true }).click();
  await owner.waitForFunction(() => !Array.from(document.querySelectorAll("[data-request]")).some((row) => row.textContent.includes("ending EE:04")));
  assert.equal(await owner.locator("[data-request] img").count(), 0);
  assert.equal(await owner.getByRole("heading", { name: hostileName + " · ending EE:04", exact: true }).count(), 0);
  await expired.getByRole("button", { name: "Request access again", exact: true }).click();
  await expired.getByLabel("Account phone number", { exact: true }).fill("670050001");
  await expired.getByLabel("Active voucher code", { exact: true }).fill("NC-AAAA-1111");
  await expired.getByRole("button", { name: "Request access", exact: true }).click();
  await expired.locator("#pairingStatus").filter({ hasText: /waiting for your main device/i }).waitFor();
  await owner.getByRole("button", { name: "Refresh requests", exact: true }).click();
  await owner.locator("[data-request]").filter({ has: owner.locator("[data-pairing-approval]") }).getByRole("button", { name: "Decline", exact: true }).click();
  await expired.locator("#pairingStatus").filter({ hasText: "declined" }).waitFor();
  assert.equal(f.calls.length, 3); assert.deepEqual(errors, []);
  console.log("PASS storage-blocked reload/expiry/retry/decline preserve target details, keep unknown devices offline and escape names at 320px");

  await f.store.transaction((s) => { s.vouchers[0].wifiDevicesAt = f.now().toISOString(); });
  await owner.getByText("Add a device without a browser", { exact: true }).click();
  const manual = owner.locator("[data-manual-form]");
  await manual.locator('[name="mac"]').fill("AA:BB:CC:DD:EE:05");
  await manual.locator('[name="address"]').fill("10.20.0.50");
  await manual.locator('[name="confirm"]').check();
  let manualKey;
  await owner.route("**/api/account/device-management/pairing/manual", async (route) => {
    manualKey = route.request().postDataJSON().key;
    const response = await route.fetch({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } });
    assert.equal(response.status(), 202);
    const reply = await response.json(), p = (await f.store.snapshot()).wifiPairingRequests.find((p) => p.id === reply.request.id);
    await f.process(p.commandId); await route.abort("failed");
  }, { times: 1 });
  await manual.getByRole("button", { name: "Approve this device", exact: true }).click();
  await manual.locator("[data-manual-message]").filter({ hasText: /network|reach|fetch|connection/i }).waitFor();
  const manualRetrying = owner.waitForResponse((r) => r.url().endsWith("/api/account/device-management/pairing/manual") && r.status() === 202);
  await manual.getByRole("button", { name: "Approve this device", exact: true }).click();
  const manualReply = await manualRetrying;
  assert.notEqual(manualReply.request().postDataJSON().key, manualKey);
  const retried = (await manualReply.json()).request;
  const operation = (await f.store.snapshot()).wifiPairingRequests.find((p) => p.id === retried.id);
  assert.equal(operation.kind, "reconnect"); assert.equal(operation.mac, "AA:BB:CC:DD:EE:05");
  await f.process(operation.commandId); assert.deepEqual(errors, []);
  console.log("PASS manual browserless-device approval recovers a lost completed response with a fresh key and its saved grant");
  for (const c of contexts) await c.close();
} finally {
  await browser?.close(); await f.close();
  await new Promise((r) => { website.close(r); website.closeAllConnections(); });
}
