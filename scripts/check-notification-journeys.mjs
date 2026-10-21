import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { pairingFixture, guestMac } from "../test/helpers/wifi-pairing-fixture.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { recordOperationalFailure, updateOperationalIncident } from "../lib/operational-incidents.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";

const listen = (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
const close = (s) => new Promise((resolve) => { s.close(resolve); s.closeAllConnections(); });
const customer = http.createServer(), admin = http.createServer();
await listen(customer); await listen(admin);
const portal = "http://127.0.0.1:" + customer.address().port, administration = "http://127.0.0.1:" + admin.address().port;
const removals = [], f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { ADMIN_APP_URL: administration,
  WEB_PUSH_PUBLIC_KEY: "B".repeat(87), WEB_PUSH_PRIVATE_KEY: "fixture", WEB_PUSH_SUBJECT: "mailto:synthetic@example.test" },
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
  await guest.waitForURL(/\/pair\?.*#key=/);
  assert.equal(new URL(guest.url()).searchParams.get("mac"), "AA:BB:CC:DD:EE:04");
  assert.equal(new URL(guest.url()).searchParams.get("address"), "10.20.0.40");
  await guest.reload();
  await guest.locator("#pairingStatus").filter({ hasText: "must set a main device" }).waitFor();
  assert.equal(await guest.getByRole("link", { name: "Open Wi-Fi sign-in", exact: true }).getAttribute("href"), "https://connect.hotspot.test/login");
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

  await owner.getByRole("button", { name: /^Notifications/ }).click();
  await owner.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
    window.syntheticPush = { permissionCalls: 0, active: false, allowed: false, subscribed: false };
    Notification.requestPermission = async () => {
      syntheticPush.permissionCalls++; syntheticPush.active = navigator.userActivation.isActive;
      return syntheticPush.allowed ? "granted" : "denied";
    };
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };
    const target = { toJSON: () => subscription, endpoint: subscription.endpoint, unsubscribe: async () => { syntheticPush.subscribed = false; return true; } };
    navigator.serviceWorker.register = async () => ({ pushManager: {
      getSubscription: async () => syntheticPush.subscribed ? target : null,
      subscribe: async () => { syntheticPush.subscribed = true; return target; },
    } });
  });
  assert.equal(await owner.evaluate(() => syntheticPush.permissionCalls), 0);
  await panel.getByRole("button", { name: "Enable on this device", exact: true }).click();
  await panel.getByText("Allow notifications in your browser settings, or keep using the in-app inbox.", { exact: true }).waitFor();
  assert.equal(await owner.evaluate(() => syntheticPush.active), true);
  assert.equal((await f.store.snapshot()).customers[0].pushSubscriptions?.length || 0, 0);
  await owner.evaluate(() => { syntheticPush.allowed = true; });
  await panel.getByRole("button", { name: "Enable on this device", exact: true }).click();
  await panel.getByText("Browser notifications enabled on this device.", { exact: true }).waitFor();
  assert.equal((await f.store.snapshot()).customers[0].pushSubscriptions.length, 1);
  await panel.getByRole("button", { name: "Disable on this device", exact: true }).click();
  await panel.getByText("Browser notifications disabled on this device.", { exact: true }).waitFor();
  assert.equal((await f.store.snapshot()).customers[0].pushSubscriptions.length, 0);
  await owner.evaluate(() => { window.PushManager = undefined; });
  await panel.getByRole("button", { name: "Enable on this device", exact: true }).click();
  await panel.getByText("Browser notifications are not supported here. Use the in-app inbox.", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Back to notifications", exact: true }).click();
  await panel.getByLabel("Notification view", { exact: true }).selectOption("action");
  await panel.getByRole("heading", { name: "Set your main device", exact: true }).waitFor();
  await owner.keyboard.press("Escape");
  console.log("PASS permission is requested only by a user gesture; denied/unsupported push preserves the inbox; synthetic subscribe/unsubscribe persists on the real API");

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

  await owner.goto(portal + "/dashboard#account");
  await f.store.transaction((s) => s.securityAlerts.push({ id: "notice-59", customerId: "c1", subject: "Account security changed", lines: ["Review account settings"], at: f.now().toISOString() }));
  const loginStatus = await owner.evaluate(async (api) => (await fetch(api + "/api/account/login/pin", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "670050001", pin: "2468" }) })).status, f.api);
  assert.equal(loginStatus, 200);
  await owner.reload();
  assert.equal(await owner.getByRole("heading", { name: "Recent security notices", exact: true }).count(), 0);
  assert.equal(await owner.getByRole("heading", { name: "Recent sign-ins", exact: true }).count(), 0);
  await owner.locator("#sessionActivity summary").click();
  await owner.getByRole("button", { name: "View security history", exact: true }).click();
  const securityPanel = owner.getByRole("dialog", { name: "Notifications", exact: true });
  await securityPanel.getByRole("heading", { name: "Account security changed", exact: true }).waitFor();
  await securityPanel.getByRole("heading", { name: /PIN sign-in/ }).waitFor();
  await securityPanel.getByRole("link", { name: "Review sessions", exact: true }).first().click();
  await owner.waitForURL(/#sessions$/);
  await owner.locator("#sessionActivity [data-revoke-session]").first().waitFor();
  assert.equal(await owner.locator("#sessionActivity").evaluate((el) => el.open), true);
  assert.equal(await owner.getByRole("dialog", { name: "Notifications", exact: true }).isHidden(), true);
  assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log("PASS security/sign-in history lives in the centre and Review sessions opens active session controls without duplicate Account history at 320px");

  await f.store.transaction((s) => {
    for (let n = 0; n < 35; n++) {
      s.securityAlerts.push({ id: "history-" + n, customerId: "c1", subject: "History security " + n, lines: ["Review account"], at: "2026-09-01T12:00:00Z" });
      s.securityEvents.push({ id: "staff-history-" + n, type: "admin.authorization.denied", at: "2026-09-01T12:00:00Z" });
    }
  });
  for (const [page, origin] of [[owner, portal], [administrator, administration]]) {
    await page.goto(origin + "/dashboard");
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const centre = page.getByRole("dialog", { name: "Notifications", exact: true });
    await centre.getByLabel("Notification view", { exact: true }).selectOption("all");
    await centre.getByLabel("Notification category", { exact: true }).selectOption("security");
    await centre.getByLabel("Notifications from date", { exact: true }).fill("2026-09-01");
    await centre.getByLabel("Notifications through date", { exact: true }).fill("2026-09-01");
    await centre.getByRole("button", { name: "Apply dates", exact: true }).click();
    await centre.getByText("35 matching", { exact: true }).waitFor();
    assert.equal(await centre.locator("[data-notification-id]").count(), 25);
    await centre.getByRole("button", { name: "Next", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-notification-id]').length === 10);
    await centre.getByRole("button", { name: "Previous", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-notification-id]').length === 25);
    await page.route("**/api/*/notifications?**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Inbox temporarily unavailable" }) }), { times: 1 });
    await centre.getByRole("button", { name: "Refresh notifications", exact: true }).click();
    await centre.getByText(/Inbox temporarily unavailable/).waitFor();
    assert.equal(await centre.getByLabel("Notification category", { exact: true }).inputValue(), "security");
    assert.equal(await centre.getByLabel("Notifications from date", { exact: true }).inputValue(), "2026-09-01");
    await centre.getByRole("button", { name: "Refresh notifications", exact: true }).click();
    await centre.getByLabel("Notifications from date", { exact: true }).fill("2026-09-02");
    await centre.getByLabel("Notifications through date", { exact: true }).fill("2026-09-03");
    await centre.getByRole("button", { name: "Apply dates", exact: true }).click();
    await centre.getByText("No notifications match these filters.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("button", { name: /^Notifications/ }).evaluate((el) => el === document.activeElement), true);
  }
  assert.deepEqual(errors, []);
  console.log("PASS both centres filter dates/categories before pagination, reach older records, preserve filters after errors, recover and close accessibly at 320px");
  await f.store.transaction((s) => {
    for (let n = 0; n < 2; n++) {
      const c = { id: "incident-browser-" + n, kind: "router_command", action: "sync_voucher", targetId: "v1", status: "dead_letter", totalAttempts: 2, lastAttemptAt: f.now().toISOString(), lastError: "timeout private voucher-secret" };
      s.routerCommands.push(c); recordOperationalFailure(s, c, f.now);
    }
  });
  const incidentId = (await f.store.snapshot()).operationalIncidents[0].id;
  await administrator.goto(administration + "/dashboard");
  await administrator.getByRole("button", { name: /^Notifications/ }).click();
  const incidentRow = administrator.locator('[data-notification-id="incident:' + incidentId + '"]');
  await incidentRow.getByRole("link", { name: "Review incident", exact: true }).click();
  await administrator.waitForURL(/incident=.*#connections$/);
  const details = administrator.getByRole("region", { name: "Network incident details", exact: true });
  await details.getByText("sync voucher · open · 2 occurrence(s)", { exact: true }).waitFor();
  assert.equal(await details.getByRole("button", { name: "Replay", exact: true }).count(), 2);
  assert.equal((await details.textContent()).includes("voucher-secret"), false);
  assert.equal(await administrator.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await f.store.transaction((s) => {
    for (const c of s.routerCommands.filter((c) => c.id.startsWith("incident-browser-"))) { c.status = "processed"; updateOperationalIncident(s, c, f.now); }
  });
  await administrator.reload();
  await administrator.getByRole("region", { name: "Network incident details", exact: true }).getByText("sync voucher · resolved · 2 occurrence(s)", { exact: true }).waitFor();
  assert.equal(await administrator.getByRole("region", { name: "Network incident details", exact: true }).getByRole("button", { name: "Replay", exact: true }).count(), 0);
  console.log("PASS grouped incidents show first/latest/count, scoped command details and confirmed recovery without exposing raw errors at 320px");

  for (const context of contexts) { await context.unrouteAll({ behavior: "wait" }); await context.close(); }
} finally {
  await browser?.close(); await f.close(); await close(customer); await close(admin);
}
