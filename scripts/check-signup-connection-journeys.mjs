import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture } from "../test/helpers/wifi-pairing-fixture.mjs";
import { enqueueRouterCommand } from "../lib/router-queue.mjs";

// Real local API and isolated payment/router fixtures. No production access.
const website = http.createServer();
await new Promise((resolve) => website.listen(0, "127.0.0.1", resolve));
const portal = `http://127.0.0.1:${website.address().port}`;
const ownerMac = "AA:BB:CC:DD:EF:01", guestMac = "AA:BB:CC:DD:EF:02", phone = "670050188";
const screenshots = "/tmp/ndahi-signup-connection-checks", contexts = [], errors = [];
let f, browser, routerEpoch = 0;
try {
  f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true,
    env: { NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock" },
    router: {
      async readGuestDevice({ mac, address }) {
        return { mac, address, loginAddress: address, hostId: `*guest-${routerEpoch}-${mac.slice(-2)}`,
          server: "ndahi-hotspot", name: routerEpoch ? "" : "Signup phone" };
      },
      async connectWifiDevice(device) {
        f.calls.push(structuredClone(device));
        return { confirmed: true, device: { mac: device.mac, address: device.loginAddress,
          sessionId: "*session-" + f.calls.length, startedAt: f.now().toISOString(), usedBytes: 0,
          ...(routerEpoch ? {} : { name: "Signup phone" }) } };
      },
      async syncVoucher(voucher) { return { synchronized: true, voucherId: voucher.id }; },
      async readUsage() {
        return (await f.store.snapshot()).vouchers.map((v) => ({ voucherId: v.id, usedBytes: v.usedBytes || 0, devices: v.wifiDevices || [] }));
      },
    },
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.hotspot.test/login" });
  website.on("request", (req, res) => assets.emit("request", req, res));
  await mkdir(screenshots, { recursive: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function newPage() {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 } }); contexts.push(context);
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "https://connect.hotspot.test") {
        assert.equal(url.pathname, "/login"); assert.equal(route.request().method(), "GET");
        assert.deepEqual([...url.searchParams], [["dst", portal + "/wifi-connected.html"], ["popup", "false"]]);
        assert.equal(route.request().headers().referer, undefined);
        return route.fulfill({ status: 302, headers: { location: url.searchParams.get("dst") } });
      }
      return [portal, f.api].includes(url.origin)
        ? route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }) : route.abort("blockedbyclient");
    });
    await context.addInitScript(() => {
      for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(window, name, {
        get() { throw new DOMException("Storage denied", "SecurityError"); },
      });
      Object.defineProperty(AbortSignal, "timeout", { value: undefined });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.message));
    return page;
  }
  async function refreshDevices() {
    await f.store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, f.now));
    await f.handler.routerProcessor.process("router:sync_usage:global");
  }
  async function confirmConnection(request) {
    const queued = (await f.store.snapshot()).wifiPairingRequests.find((p) => p.id === request.id);
    assert.equal(queued.status, "connecting");
    await f.handler.routerProcessor.process(queued.commandId);
  }
  const owner = await newPage();
  await owner.goto(portal + "/onboarding.html?mac=" + encodeURIComponent(ownerMac) + "&address=10.20.0.81");
  await owner.locator('[data-plan="connect30"]').click();
  await owner.locator('[name="name"]').fill("Signup Owner");
  await owner.locator('[name="phone"]').fill(phone);
  await owner.locator("#requestPayment").click();
  await owner.locator("#confirm").click();
  await owner.waitForURL((url) => url.pathname === "/verify.html" && url.searchParams.get("setup") === "checkout");
  assert.equal(new URL(owner.url()).searchParams.get("mac"), ownerMac, "payment-to-PIN handoff must retain device identity without storage");
  assert.equal(new URL(owner.url()).searchParams.get("address"), "10.20.0.81");
  assert.doesNotMatch(owner.url(), /670050188|requestKey|approvalCode/);
  const paid = (await f.store.snapshot()).payments.find((p) => p.payerPhone === phone);
  assert.equal(paid.status, "paid");
  // The voucher identity is resolved from committed state, never the UI's input.
  const voucher = (await f.store.snapshot()).vouchers.find((v) => v.paymentId === paid.id);
  await f.handler.routerProcessor.process("router:sync_voucher:" + voucher.id);
  await refreshDevices();
  await owner.reload();
  await owner.locator("#primary").fill("2468");
  await owner.locator("#confirm").fill("2468");
  const connecting = owner.waitForResponse((r) => r.url().endsWith("/api/account/device-management/connect") && r.status() === 202);
  await owner.locator("#submitLabel").click();
  await owner.waitForURL(/\/voucher-ready\.html/);
  await owner.getByRole("button", { name: "Download Voucher", exact: true }).waitFor();
  assert.equal(f.calls.length, 0, "voucher remains retrievable before connection begins");
  await owner.getByRole("link", { name: "Continue to Dashboard / Wi-Fi", exact: true }).click();
  const connection = await connecting, queued = await connection.json();
  const firstOwnerKey = connection.request().postDataJSON().key;
  assert.equal(connection.request().postDataJSON().mac, ownerMac);
  assert.equal(connection.request().postDataJSON().address, "10.20.0.81");
  assert.equal(queued.request.status, "connecting"); assert.equal(f.calls.length, 0);
  await confirmConnection(queued.request);
  await owner.getByRole("heading", { name: "Is this your main device?", exact: true }).waitFor();
  await owner.getByRole("button", { name: "Yes, set as main device", exact: true }).click();
  await owner.locator('[data-main-proof] [name="confirm"]').check();
  await owner.locator('[data-main-proof] [name="pin"]').fill("2468");
  await owner.getByRole("button", { name: "Verify and select", exact: true }).click();
  await owner.getByText("This browser controls connection approvals.", { exact: false }).waitFor({ state: "attached" });
  if (!await owner.locator("#manageDevices").evaluate((node) => node.open)) await owner.locator("#manageDevices > summary").click();
  await owner.getByText("This browser controls connection approvals.", { exact: false }).waitFor();
  const customer = (await f.store.snapshot()).customers.find((c) => c.phone === phone);
  assert.equal(customer.wifiMainDevice.mac, ownerMac);
  console.log("PASS paid signup preserves captive identity through PIN reload, router confirmation and main selection with storage blocked");

  const guest = await newPage();
  await guest.goto(portal + "/onboarding.html?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.82");
  await guest.getByRole("link", { name: "Customer login", exact: true }).click();
  await guest.locator('#login [name="phone"]').fill(phone);
  await guest.locator('#login [name="code"]').fill(voucher.code);
  await guest.locator("#loginSubmit").click();
  const requested = guest.waitForResponse((r) => r.url().endsWith("/api/wifi/pairing/request") && r.status() === 201);
  await guest.getByRole("button", { name: "Request access", exact: true }).click();
  const firstGuestKey = (await requested).request().postDataJSON().key;
  await guest.locator("#pairingStatus").filter({ hasText: "waiting for the main device" }).waitFor();
  await owner.getByRole("button", { name: "Refresh requests", exact: true }).click();
  const row = owner.locator("[data-request]").filter({ hasText: "ending EF:02" });
  await row.getByRole("button", { name: "Approve & show code", exact: true }).click();
  const code = await row.getByLabel("Approval code", { exact: true }).textContent();
  assert.match(code, /^\d{6}$/);
  await guest.getByLabel("Approval code from your main device").fill(code);
  const redeem = guest.waitForResponse((r) => r.url().endsWith("/api/wifi/pairing/redeem") && r.status() === 202);
  await guest.getByRole("button", { name: "Enter code and connect", exact: true }).click();
  const guestConnection = (await (await redeem).json()).request;
  assert.equal(f.calls.length, 1, "guest stays offline until the router confirms");
  await confirmConnection(guestConnection);
  await guest.waitForURL(portal + "/wifi-connected.html");
  assert.equal((await guest.context().cookies()).some((c) => c.name === "customer_session"), false);
  assert.equal((await guest.request.get(f.api + "/api/account/dashboard")).status(), 401);
  console.log("PASS a second browser requests and redeems main-device approval after the real signup without receiving an account session");

  routerEpoch++;
  await f.store.transaction((s) => {
    const v = s.vouchers.find((v) => v.id === voucher.id);
    v.wifiDevices = []; v.wifiDevicesAt = f.now().toISOString();
  });
  const rejoining = owner.waitForResponse((r) => r.url().endsWith("/api/account/device-management/connect") && r.status() === 202);
  await owner.goto(portal + "/hotspot?mac=" + encodeURIComponent(ownerMac) + "&address=10.20.0.91#wifi_key=" + firstOwnerKey);
  const rejoin = await rejoining;
  assert.notEqual(rejoin.request().postDataJSON().key, firstOwnerKey);
  assert.equal(f.calls.length, 2, "rejoining must wait for fresh router confirmation");
  await confirmConnection((await rejoin.json()).request);
  await owner.waitForURL((url) => url.pathname === "/dashboard");
  assert.deepEqual((await f.store.snapshot()).customers.find((c) => c.id === customer.id).wifiMainDevice, customer.wifiMainDevice);
  await owner.getByText("This browser controls connection approvals.", { exact: false }).waitFor({ state: "attached" });
  if (!await owner.locator("#manageDevices").evaluate((node) => node.open)) await owner.locator("#manageDevices > summary").click();
  await owner.getByText("This browser controls connection approvals.", { exact: false }).waitFor();
  const rejoiningGuest = guest.waitForResponse((r) => r.url().endsWith("/api/wifi/pairing/request") && r.status() === 202);
  await guest.goto(portal + "/pair?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.92#key=" + firstGuestKey);
  await guest.getByLabel("Account phone number", { exact: true }).fill(phone);
  await guest.getByLabel("Active voucher code", { exact: true }).fill(voucher.code);
  await guest.getByRole("button", { name: "Request access", exact: true }).click();
  const guestRejoin = await rejoiningGuest;
  assert.notEqual(guestRejoin.request().postDataJSON().key, firstGuestKey);
  assert.equal(f.calls.length, 3);
  await confirmConnection((await guestRejoin.json()).request);
  await guest.waitForURL(portal + "/wifi-connected.html");
  assert.equal(f.calls.length, 4);
  await refreshDevices();
  const restored = (await f.store.snapshot()).vouchers.find((v) => v.id === voucher.id);
  assert.deepEqual(restored.wifiDevices.map((d) => d.address).sort(), ["10.20.0.91", "10.20.0.92"]);
  console.log("PASS both approved devices reconnect after simulated router-session loss and changed IP/host/session IDs without repeating approval");

  const third = await newPage();
  await third.goto(portal + "/pair?mac=AA%3ABB%3ACC%3ADD%3AEF%3A03&address=10.20.0.93");
  await third.getByLabel("Account phone number", { exact: true }).fill(phone);
  await third.getByLabel("Active voucher code", { exact: true }).fill(voucher.code);
  await third.getByRole("button", { name: "Request access", exact: true }).click();
  await third.locator("#pairingStatus").filter({ hasText: "waiting for the main device" }).waitFor();
  assert.equal(f.calls.length, 4, "an unknown MAC must still require main-device approval");
  await owner.getByRole("button", { name: "Refresh requests", exact: true }).click();
  const thirdRow = owner.locator("[data-request]").filter({ hasText: "ending EF:03" });
  await thirdRow.getByRole("button", { name: "Approve & show code", exact: true }).click();
  const thirdCode = await thirdRow.getByLabel("Approval code", { exact: true }).textContent();
  await third.getByLabel("Approval code from your main device").fill(thirdCode);
  await third.getByRole("button", { name: "Enter code and connect", exact: true }).click();
  await third.locator("#pairingMessage").filter({ hasText: "All device slots are in use" }).waitFor();
  assert.equal(f.calls.length, 4);
  console.log("PASS an unknown third device requires approval and cannot exceed the bundle's two-device limit");
  for (const page of [owner, guest]) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.doesNotMatch(page.url(), new RegExp(phone + "|" + voucher.code + "|" + code));
  }
  await owner.screenshot({ path: screenshots + "/signup-main-320.png", fullPage: true });
  await guest.screenshot({ path: screenshots + "/signup-guest-320.png", fullPage: true });
  assert.deepEqual(errors, []);
} catch (error) {
  for (const [index, context] of contexts.entries()) {
    await context.pages()[0]?.screenshot({ path: screenshots + "/failure-" + index + ".png", fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  for (const context of contexts) { await context.unrouteAll({ behavior: "wait" }); await context.close(); }
  await browser?.close(); await f?.close();
  await new Promise((resolve) => { website.close(resolve); website.closeAllConnections(); });
}
