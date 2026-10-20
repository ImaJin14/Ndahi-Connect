import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { pairingFixture, guestMac } from "../test/helpers/wifi-pairing-fixture.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";

const listen = (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
const close = (s) => new Promise((resolve) => { s.close(resolve); s.closeAllConnections(); });
const customer = http.createServer(), admin = http.createServer();
await listen(customer); await listen(admin);
const portal = "http://127.0.0.1:" + customer.address().port, administration = "http://127.0.0.1:" + admin.address().port;
const removals = [], f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { ADMIN_APP_URL: administration },
  router: { async revokeWifiDevice(device) { removals.push(device); return { confirmed: true, outcome: "revoked" }; } } });
const customerAssets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.hotspot.test/login" });
const adminAssets = createStaticServer("admin", { apiUrl: f.api });
customer.on("request", (req, res) => customerAssets.emit("request", req, res));
admin.on("request", (req, res) => adminAssets.emit("request", req, res));
const errors = [], contexts = [], screenshots = "/tmp/ndahi-notification-checks";
let browser;
try {
  await mkdir(screenshots, { recursive: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function pageFor(kind, { blockedStorage = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 } }); contexts.push(context);
    await context.route("**/*", (route) => [portal, administration, f.api].includes(new URL(route.request().url()).origin)
      ? route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }) : route.abort("blockedbyclient"));
    if (blockedStorage) await context.addInitScript(() => {
      for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(window, key, { get() { throw new DOMException("Storage denied", "SecurityError"); } });
      Object.defineProperty(AbortSignal, "timeout", { value: undefined });
    });
    if (kind) await context.addCookies([{ name: kind === "admin" ? "admin_session" : "customer_session", value: kind === "admin" ? "admin-owner" : "main",
      domain: "127.0.0.1", path: kind === "admin" ? "/api/admin" : "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", (e) => errors.push(e.message)); return page;
  }
  await f.store.transaction((s) => { delete s.customers[0].wifiMainDevice; s.vouchers[0].wifiDevices = []; });
  const owner = await pageFor("owner");
  const connecting = owner.waitForResponse((r) => r.url().endsWith("/api/account/device-management/connect") && r.request().method() === "POST");
  await owner.goto(portal + "/hotspot?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.30");
  assert.equal((await connecting).status(), 202);
  await f.process();
  await owner.waitForURL(/main-device=/);
  await owner.getByRole("heading", { name: "Is this your main device?", exact: true }).waitFor();
  assert.equal((await f.store.snapshot()).customers[0].wifiMainDevice, undefined);
  await owner.getByRole("button", { name: "No, skip for now", exact: true }).click();
  assert.equal(new URL(owner.url()).searchParams.has("main-device"), false);
  assert.equal((await f.store.snapshot()).wifiDeviceGrants[0].status, "approved");
  assert.equal((await f.store.snapshot()).customers[0].wifiMainDevice, undefined);
  console.log("PASS the first confirmed connection prompts for main-device choice and skipping retains internet without creating a main controller");

  const guest = await pageFor(null, { blockedStorage: true });
  await guest.goto(portal + "/onboarding.html?mac=AA%3ABB%3ACC%3ADD%3AEE%3A04&address=10.20.0.40");
  await guest.waitForFunction(() => document.querySelector('a[href*="/login"]').href.includes("mac="));
  await guest.getByRole("link", { name: "Customer login", exact: true }).click();
  await guest.locator('#login [name="phone"]').fill("670050001"); await guest.locator('#login [name="code"]').fill("NC-AAAA-1111");
  await guest.locator("#loginSubmit").click();
  await guest.getByRole("heading", { name: "Request access from your main device", exact: true }).waitFor();
  assert.equal(await guest.locator("#login").isHidden(), true);
  assert.equal(await guest.locator("#customerPin").isHidden(), true);
  assert.equal(await guest.locator("#customerPin").evaluate((input) => input.required), false);
  await guest.getByRole("button", { name: "Request access", exact: true }).click();
  await guest.waitForURL(/\/pair#key=/);
  await guest.locator("#pairingStatus").filter({ hasText: "must set a main device" }).waitFor();
  assert.equal(f.calls.length, 1, "a voucher and number alone cannot start a second router login");
  console.log("PASS additional voucher/number sign-in opens restricted access and waits when no main is selected");

  const missingHint = await pageFor(null, { blockedStorage: true }), accountConnections = [];
  missingHint.on("request", (r) => { if (r.url().endsWith("/api/account/device-management/connect")) accountConnections.push(r.url()); });
  await missingHint.goto(portal + "/login");
  await missingHint.locator('#login [name="phone"]').fill("670050001");
  await missingHint.locator('#login [name="code"]').fill("NC-AAAA-1111");
  await missingHint.locator("#loginSubmit").click();
  await missingHint.getByRole("heading", { name: "Request access from your main device", exact: true }).waitFor();
  assert.equal(await missingHint.locator("#customerPin").isHidden(), true);
  assert.equal(await missingHint.locator("#customerPin").evaluate((input) => input.required), false);
  assert.equal(await missingHint.locator("[data-request-access]").isHidden(), true);
  assert.equal(await missingHint.getByRole("link", { name: "Open Wi-Fi sign-in", exact: true }).getAttribute("href"), "https://connect.hotspot.test/login");
  assert.equal((await missingHint.context().cookies()).some((c) => c.name === "customer_session"), false);
  await missingHint.getByRole("button", { name: "Sign in to account settings", exact: true }).click();
  await missingHint.locator("#customerPin").fill("2468");
  await missingHint.getByRole("button", { name: "Sign in", exact: true }).click();
  await missingHint.waitForURL(/\/dashboard#account$/);
  await missingHint.getByRole("heading", { name: "PIN, authenticator & passkeys", exact: true }).waitFor();
  assert.equal(accountConnections.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(await missingHint.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log("PASS missing captive details never fall back to a PIN; explicit account sign-in opens settings without a Wi-Fi connection or blocked-storage dependency");

  await owner.getByRole("button", { name: /^Notifications/ }).click();
  const panel = owner.getByRole("dialog", { name: "Notifications", exact: true });
  await panel.getByRole("heading", { name: "Set your main device", exact: true }).waitFor();
  await panel.getByLabel("Notification view", { exact: true }).selectOption("action");
  await panel.getByRole("button", { name: "Mark all read", exact: true }).click();
  assert.ok(await panel.locator("[data-notification-id]").count() >= 1);
  assert.equal((await f.store.snapshot()).wifiPairingRequests.find((p) => p.mac.endsWith("04")).status, "pending");
  await panel.getByRole("button", { name: "Settings", exact: true }).click();
  await panel.getByLabel("Email security notices", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save notification settings", exact: true }).click();
  await panel.getByText("Notification settings saved.", { exact: true }).waitFor();
  assert.equal(await panel.getByLabel("Email security notices", { exact: true }).isChecked(), false);
  assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await owner.screenshot({ path: screenshots + "/customer-notifications-320.png", fullPage: true });
  await owner.keyboard.press("Escape");
  assert.equal(await owner.getByRole("button", { name: /^Notifications/ }).evaluate((el) => el === document.activeElement), true);
  await owner.reload(); await owner.getByRole("button", { name: /^Notifications/ }).click();
  await panel.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await panel.getByLabel("Email security notices", { exact: true }).isChecked(), false);
  await owner.keyboard.press("Escape");
  console.log("PASS notification filters, durable read/preferences, pending actions, focus restoration and 320px layouts");

  // Re-enter the guided choice to exercise Yes and fresh owner verification too.
  await owner.goto(portal + "/dashboard?main-device=" + encodeURIComponent(guestMac) + "#home");
  await owner.getByRole("button", { name: "Yes, set as main device", exact: true }).click();
  await owner.locator('[data-main-proof] [name="confirm"]').check();
  await owner.locator('[data-main-proof] [name="pin"]').fill("2468");
  await owner.getByRole("button", { name: "Verify and select", exact: true }).click();
  await owner.getByText("This browser controls connection approvals.", { exact: false }).waitFor();
  assert.equal((await f.store.snapshot()).customers[0].wifiMainDevice.mac, guestMac);
  console.log("PASS choosing Yes links the selected browser only after PIN verification");

  await f.store.transaction((s) => {
    s.adminUsers.push({ id: "admin-owner", username: "owner", role: "owner", active: true });
    s.adminSessions.push({ id: "admin-owner", userId: "admin-owner", role: "owner", tokenHash: hashSecret("admin-owner", "pairing-tests"),
      csrfToken: "csrf", expiresAt: new Date(+f.now() + 86400000).toISOString() });
    s.routerCommands.push({ id: "router-failed-one", action: "sync_usage", status: "dead_letter", at: f.now().toISOString() });
  });
  const administrator = await pageFor("admin");
  await administrator.goto(administration + "/dashboard");
  await administrator.getByRole("button", { name: /^Notifications/ }).click();
  const adminPanel = administrator.getByRole("dialog", { name: "Notifications", exact: true });
  await adminPanel.getByRole("heading", { name: "Router work needs attention", exact: true }).waitFor();
  await adminPanel.getByRole("button", { name: "Mark all read", exact: true }).click();
  await adminPanel.getByLabel("Notification view", { exact: true }).selectOption("action");
  await adminPanel.getByRole("heading", { name: "Router work needs attention", exact: true }).waitFor();
  await administrator.screenshot({ path: screenshots + "/admin-notifications-320.png", fullPage: true });
  assert.equal(await administrator.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("PASS admin notification bell exposes actionable network alerts with independent read state");
  await f.store.transaction((s) => {
    approveDevice(s, "c1", { mac: "AA:BB:CC:DD:EE:09", name: "Offline TV <img src=x>" }, f.now(), "test");
    s.vouchers[0].status = "expired";
  });
  await owner.reload();
  const saved = owner.locator("[data-approved-devices] .device").filter({ hasText: "Offline TV <img src=x>" });
  await saved.getByRole("button", { name: "Forget device", exact: true }).click();
  assert.equal(await saved.locator("img").count(), 0);
  const forgetting = owner.locator("[data-forget-proof]");
  await forgetting.locator('[name="confirm"]').check();
  await forgetting.locator('[name="pin"]').fill("0000");
  await forgetting.getByRole("button", { name: "Verify and forget", exact: true }).click();
  await forgetting.getByText(/Could not verify account ownership/).waitFor();
  let state = await f.store.snapshot(), grant = state.wifiDeviceGrants.find((g) => g.mac.endsWith("09"));
  assert.equal(grant.status, "approved"); f.advance(2);
  await forgetting.locator('[name="pin"]').fill("2468");
  await forgetting.getByRole("button", { name: "Verify and forget", exact: true }).click();
  await saved.getByText(/Waiting for router removal/).waitFor();
  assert.equal(removals.length, 0);
  state = await f.store.snapshot(); grant = state.wifiDeviceGrants.find((g) => g.mac.endsWith("09"));
  assert.equal(grant.status, "revoked"); await f.process(grant.revocationCommandId);
  await owner.getByRole("button", { name: "Refresh saved approvals", exact: true }).click();
  await saved.waitFor({ state: "detached" }); await owner.locator("[data-approved-devices]").waitFor();
  assert.equal(await owner.locator("[data-approved-devices] .device").filter({ hasText: "Offline TV <img src=x>" }).count(), 0);
  assert.equal(removals.length, 1);
  assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("PASS offline saved-device removal works after bundle expiry, requires fresh PIN, escapes names and awaits router confirmation at 320px");
  await administrator.keyboard.press("Escape");
  await administrator.getByRole("link", { name: "More", exact: true }).click();
  await administrator.getByRole("tab", { name: "Network setup", exact: true }).click();
  await administrator.locator("#networkPairingStatus").filter({ hasText: "Main-device approval is required" }).waitFor();
  await f.store.transaction((s) => { delete s.networkSetup.deviceApproval; s.networkSetup.assistedConnections.enabled = false; });
  await administrator.getByRole("button", { name: "Refresh jobs", exact: true }).click();
  await administrator.locator("#networkPairingStatus").filter({ hasText: "Mandatory device approval has not been enabled" }).waitFor();
  await f.store.transaction((s) => { s.networkSetup.deviceApproval = { version: 1, revision: "router-1" }; });
  await administrator.getByRole("button", { name: "Refresh jobs", exact: true }).click();
  await administrator.locator("#networkPairingStatus").filter({ hasText: "Existing device-approval requirements remain enforced" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS admin network setup distinguishes mandatory approval never enabled, active, and temporarily unavailable");
  for (const context of contexts) { await context.unrouteAll({ behavior: "wait" }); await context.close(); }
} finally {
  await browser?.close(); await f.close(); await close(customer); await close(admin);
}
