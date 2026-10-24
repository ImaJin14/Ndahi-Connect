import assert from "node:assert/strict";
import http from "node:http";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture, guestMac } from "../test/helpers/wifi-pairing-fixture.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";
import { setDefaultResultOrder } from "node:dns";

setDefaultResultOrder("ipv4first");

const website = http.createServer();
await new Promise((resolve) => website.listen(0, "127.0.0.1", resolve));
const portal = `http://localhost:${website.address().port}`;
let routerAvailable = true, identifications = 0;
const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, router: {
  async readGuestDevice(input) {
    identifications++;
    if (!routerAvailable) throw Error("Router unavailable");
    return { ...input, loginAddress: input.address, hostId: "*guest", server: "ndahi-hotspot" };
  },
  async disconnectWifiDevice() { return { confirmed: true, outcome: "disconnected" }; },
  async readUsage() { return (await f.store.snapshot()).vouchers.map((v) => ({ voucherId: v.id, usedBytes: v.usedBytes, devices: v.wifiDevices || [] })); },
} });
const api = f.api.replace("127.0.0.1", "localhost");
const assets = createStaticServer("customer", { apiUrl: api, hotspotLoginUrl: "https://connect.current.test/login" });
website.on("request", (req, res) => assets.emit("request", req, res));
await f.store.transaction((s) => {
  approveDevice(s, "c1", { mac: guestMac }, f.now(), "test");
  s.vouchers[0].wifiDevices.push({ mac: guestMac, address: "10.20.0.30", sessionId: "*guest", startedAt: f.now().toISOString() });
  s.wifiPairingRequests.push({ id: "historical-device-request", customerId: "c1", mac: "00:00:00:00:00:99", name: "Old device", kind: "reconnect", status: "connected",
    at: f.now().toISOString(), updatedAt: f.now().toISOString(), expiresAt: new Date(+f.now() + 300000).toISOString() });
  s.routerCommands.push({ id: "historical-disconnect", action: "disconnect_wifi_device", customerId: "c1", status: "processed", result: "disconnected", processedAt: f.now().toISOString(),
    device: { voucherId: "v1", mac: "00:00:00:00:00:99", sessionId: "*old", startedAt: f.now().toISOString() } });
});
let browser;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
  await context.addCookies([{ name: "customer_session", value: "main", domain: "localhost", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(() => {
    for (const store of ["localStorage", "sessionStorage"]) Object.defineProperty(window, store, { get() { throw new DOMException("Storage denied", "SecurityError"); } });
  });
  await context.route("**/*", (route) => [portal, api].includes(new URL(route.request().url()).origin)
    ? route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }) : route.abort("blockedbyclient"));
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000); page.on("pageerror", (error) => errors.push(error.message));
  const card = page.locator("#currentWifi");
  await page.goto(portal + "/dashboard");
  await card.locator('[data-current-state="unknown"]').waitFor();
  assert.equal(await card.getByRole("button", { name: "Disconnect this device", exact: true }).count(), 0);
  console.log("PASS an account login and other connected sessions do not label an unidentified browser Connected");
  assert.equal(await page.locator("#manageDevices").evaluate((d) => d.open), false);
  assert.equal(await page.locator('[data-request="historical-device-request"]').count(), 0);
  await page.goto(portal + "/dashboard#devices");
  await page.locator('#wifiDeviceList [data-forget-device]').waitFor();
  assert.equal(await page.locator("#manageDevices").evaluate((d) => d.open), true);
  assert.equal(await page.locator("#wifiDeviceList .device").filter({ hasText: "EE:03" }).count(), 1);
  assert.equal(await page.locator("#manageDevices").getByText("Old device", { exact: true }).count(), 0);
  const history = await context.request.get(api + "/api/account/notifications?view=all&category=devices", { headers: { origin: portal, "cf-connecting-ip": "203.0.113.10" } });
  const historyBody = await history.json();
  assert.ok(historyBody.items.some((n) => n.id === "device:historical-device-request"));
  assert.ok(historyBody.items.some((n) => n.id === "wifi-disconnect:historical-disconnect"));
  console.log("PASS Home hides terminal activity, Manage devices deduplicates connected approvals, and Notifications retains history");

  await page.goto(portal + "/dashboard?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.30");
  await card.locator('[data-current-state="connected"]').waitFor();
  assert.equal(await card.getByRole("link", { name: "Connect to Wi-Fi", exact: true }).count(), 0);
  assert.equal(await card.getByRole("button", { name: "Disconnect this device", exact: true }).isVisible(), true);
  assert.match(await card.textContent(), /Last checked:/);
  console.log("PASS fresh router-verified current session replaces Connect with Connected and an adjacent Disconnect at 320px without storage");

  await page.clock.install();
  await page.goto(portal + "/dashboard");
  await card.locator('[data-current-state="connected"]').waitFor();
  const initialReads = identifications;
  const advance = async (seconds) => {
    f.advance(seconds);
    await f.store.transaction((s) => { s.vouchers[0].wifiDevicesAt = f.now().toISOString(); });
    await page.clock.fastForward(seconds * 1000);
  };
  const identifiedResponse = () => page.waitForResponse((response) => response.url().endsWith("/current/identify") && response.request().method() === "POST");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await advance(901);
  assert.equal(identifications, initialReads, "background polling must not identify hidden pages");
  const resumed = identifiedResponse();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  assert.deepEqual((await resumed).request().postDataJSON(), {}, "renewal uses the server's saved candidate without URL hints");
  await card.locator('[data-current-state="connected"]').waitFor();
  assert.equal(identifications, initialReads + 1, "overlapping resume events share a single identification");
  console.log("PASS returning after 15 minutes renews this browser through the router without URL hints or storage");

  const polled = identifiedResponse();
  await advance(901); await polled;
  await card.locator('[data-current-state="connected"]').waitFor();
  assert.equal(identifications, initialReads + 2);
  console.log("PASS a visible dashboard renews its expired association during normal polling");

  routerAvailable = false;
  const failedRead = identifiedResponse();
  await advance(901); await failedRead;
  await card.locator('[data-current-state="unknown"]').waitFor();
  assert.equal(await card.getByRole("button", { name: "Disconnect this device", exact: true }).count(), 0);
  const readsAfterFailure = identifications;
  await advance(10);
  const resumedStatus = page.waitForResponse((response) => response.url().endsWith("/current"));
  await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
  // Wait for the shared status read; none of these events may bypass the backoff.
  await resumedStatus;
  assert.equal(identifications, readsAfterFailure);
  routerAvailable = true;
  const retried = identifiedResponse();
  await advance(21); await retried;
  await card.locator('[data-current-state="connected"]').waitFor();
  assert.equal(identifications, readsAfterFailure + 1);
  console.log("PASS router failure clears Connected, bounds automatic retries and recovers without URL hints");

  await advance(6);
  await f.store.transaction((s) => { s.dashboardSessions.find((a) => a.id === "main").currentWifi.verifiedAt = new Date(+f.now() - 901000).toISOString(); });
  const reloaded = identifiedResponse();
  await page.reload(); await reloaded;
  await card.locator('[data-current-state="connected"]').waitFor();
  assert.equal(f.calls.length, 0, "renewal never logs a device in or changes its approval");
  console.log("PASS a fresh dashboard load renews an expired association with no captive URL hints");

  const signedIn = await context.request.post(api + "/api/account/login/pin", { headers: { origin: portal, "cf-connecting-ip": "203.0.113.10" },
    data: { phone: (await f.store.snapshot()).customers[0].phone, pin: String(2468) } });
  assert.equal(signedIn.status(), 200);
  const newSessionCheck = identifiedResponse();
  await page.reload(); await newSessionCheck;
  await card.locator('[data-current-state="connected"]').waitFor();
  console.log("PASS an actual fresh PIN sign-in restores the app cookie's candidate and freshly rechecks the router");

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(portal + "/dashboard#account");
  await page.locator("#securityManager>summary").click(); await page.locator('[data-security-panel="passkeys"]').click(); await page.locator("#addCustomerPasskey").click();
  const enrollmentProof = page.locator("[data-passkey-owner-proof]");
  await enrollmentProof.getByLabel("Current PIN", { exact: true }).fill("2468");
  await enrollmentProof.getByRole("button", { name: "Confirm with PIN", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#accountSecurity").textContent.includes("Rename"));
  await page.goto("about:blank");
  await context.clearCookies({ name: "customer_session" });
  await page.goto(portal + "/login?account=1");
  await page.locator('#login [name="phone"]').fill((await f.store.snapshot()).customers[0].phone);
  await page.locator("#customerPasskeyLogin").click();
  await page.waitForURL(/\/dashboard#account$/);
  await page.goto(portal + "/dashboard#home");
  await card.locator('[data-current-state="connected"]').waitFor();
  console.log("PASS a real WebAuthn passkey sign-in also restores the app candidate without using the credential as physical Wi-Fi identity");

  const installed = await browser.newContext({ viewport: { width: 320, height: 900 } });
  await installed.route("**/*", (route) => [portal, api].includes(new URL(route.request().url()).origin)
    ? route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }) : route.abort("blockedbyclient"));
  assert.equal((await installed.request.post(api + "/api/account/login/pin", { headers: { origin: portal, "cf-connecting-ip": "203.0.113.10" },
    data: { phone: (await f.store.snapshot()).customers[0].phone, pin: String(2468) } })).status(), 200);
  const installedPage = await installed.newPage();
  await installedPage.goto(portal + "/dashboard");
  const installedCard = installedPage.locator("#currentWifi");
  await installedCard.locator('[data-current-state="unknown"]').waitFor();
  await installedCard.locator('select[name="device"]').selectOption({ label: "Unnamed device · " + guestMac });
  await installedCard.locator('input[name="confirmed"]').check();
  await installedCard.getByRole("button", { name: "Identify this device", exact: true }).click();
  await installedCard.locator('[data-current-state="connected"]').waitFor();
  await installedPage.reload(); await installedCard.locator('[data-current-state="connected"]').waitFor();
  await installed.close();
  console.log("PASS a separate installed-app context identifies its explicitly selected own MAC once and retains that association");

  // Commit the disconnect, lose its HTTP reply, and let the card reconcile the
  // existing operation. It must not claim the slot is free or issue a new login.
  await page.route("**/api/account/wifi-devices/disconnect", async (route) => {
    const response = await route.fetch({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } });
    assert.equal(response.status(), 202); assert.equal(route.request().postDataJSON().retainApproval, true);
    await route.abort("failed");
  }, { times: 1 });
  await card.getByRole("button", { name: "Disconnect this device", exact: true }).click();
  await card.locator('[data-current-state="disconnecting"]').waitFor();
  assert.equal(await card.getByRole("link", { name: "Connect to Wi-Fi", exact: true }).count(), 0);
  let state = await f.store.snapshot();
  assert.equal(state.vouchers[0].wifiDevices.length, 3);
  const operation = state.routerCommands.find((c) => c.action === "disconnect_wifi_device" && ["queued", "retry"].includes(c.status));
  await f.handler.routerProcessor.process(operation.id);
  await card.locator('[data-current-state="disconnected"]').waitFor();
  state = await f.store.snapshot();
  assert.equal(state.wifiDeviceGrants.find((g) => g.mac === guestMac).status, "approved");
  assert.equal(f.calls.length, 0);
  const connect = new URL(await card.getByRole("link", { name: "Connect to Wi-Fi", exact: true }).getAttribute("href"), portal);
  assert.equal(connect.searchParams.get("mac"), guestMac); assert.equal(connect.searchParams.get("address"), "10.20.0.30");
  console.log("PASS lost disconnect response remains pending until router confirmation, retains saved approval and preserves reconnect identity without storage");

  await f.store.transaction((s) => { s.vouchers[0].wifiDevicesAt = new Date(+f.now() - 121000).toISOString(); });
  await card.getByRole("button", { name: "Refresh connection status", exact: true }).click();
  // A targeted confirmed disconnect remains valid briefly; after its freshness
  // window expires a stale complete reading must not claim Connected.
  f.advance(121);
  await page.reload();
  await card.locator('[data-current-state="stale"]').waitFor();
  assert.equal(await card.getByRole("button", { name: "Disconnect this device", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("PASS stale readings never claim Connected or expose a destructive session action");
  await context.close();
} finally {
  await browser?.close(); await f.close();
  await new Promise((resolve) => { website.close(resolve); website.closeAllConnections(); });
}
