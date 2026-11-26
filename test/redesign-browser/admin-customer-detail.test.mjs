import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Customer detail for Unlimited (canvas: AdminCustomerDetail, #341; owner 26 Nov):
// the masked number, Time left, Device slots, Ends and Home WISP router; the
// board's five support actions (each confirmed) plus Change number for owners;
// the Devices tab's slots with Revoke device (a reason, then "being removed").
const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const later = (hours) => new Date(Date.now() + hours * 36e5).toISOString();

test("Customer detail for an Unlimited customer is drawn as the board, with its actions", { timeout: 200000 }, async (t) => {
  const secret = "redesign-customer-detail", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.bundles.push({ id: "p2", name: "Week Unlimited", price: 3500, validityHours: 168, accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaGb: null, status: "published", catalogue: "unlimited" });
    s.customers.push({ id: "c-amina", name: "Amina N.", phone: "670001245", email: "amina@example.com", emailVerifiedAt: later(-900), pinHash: "hash", status: "active", createdAt: later(-1800), passkeys: [] });
    s.vouchers.push({ id: "va", code: "NC-K7PM-42XQ", customerId: "c-amina", planId: "p2", status: "active", accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2,
      validityHours: 168, quotaBytes: null, usedBytes: 0, activatedAt: later(-100), expiresAt: later(62), wifiDevices: [{ mac: "AA:BB:CC:4F:A2:10", sessionId: "s1", startedAt: later(-3) }] });
    s.wifiDeviceGrants = [
      { id: "g-phone", customerId: "c-amina", voucherId: "va", mac: "AA:BB:CC:4F:A2:10", status: "approved", routerRevision: "", name: "Android phone", approvedAt: later(-59), place: "AP-Market", placeSince: later(-3) },
      { id: "g-laptop", customerId: "c-amina", voucherId: "va", mac: "AA:BB:CC:19:C7:5E", status: "approved", routerRevision: "", name: "HP laptop", approvedAt: later(-80), lastSeenAt: later(-2) }];
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await listen(apiServer, apiPort);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1020 }, timezoneId: "Africa/Douala" });
  await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
  await context.addCookies([{ name: "admin_session", value: "owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => context.close());
  const text = (locator) => locator.evaluate((el) => el.innerText.replace(/\s+/g, " ").trim());

  await page.goto(`${admin}/dashboard#customer/c-amina`);
  await page.getByRole("heading", { name: "Amina N.", level: 1 }).waitFor();
  assert.match(await text(page.locator("#adminLede")), /^\+237 6•• •• 12 45 · amina@example\.com · customer since \d{1,2} \w{3}$/);
  assert.match(await text(page.locator(".admin-customer__overview > .admin-rows")), /^Active bundle Week Unlimited Time left 2 days \d+ h Device slots 2 of 2 used Ends \d{1,2} \w{3} · \d\d:\d\d Home WISP router None registered$/);
  const support = page.getByRole("region", { name: "Support actions" });
  assert.deepEqual(await support.getByRole("button").allInnerTexts(), ["Send PIN reset email", "Remove lost passkeys", "Give a voucher (sold or gift)", "Revoke current subscription", "Suspend customer", "Change number"]);
  assert.equal(await text(support.locator(".nd-meta")), "Each action asks you to confirm and is written to the audit log.");
  assert.deepEqual(await lowContrastText(page), []);

  // Send PIN reset email: confirmed, then where it went.
  await support.getByRole("button", { name: "Send PIN reset email", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Send a PIN reset link?" });
  await confirm.getByRole("button", { name: "Send the link", exact: true }).click();
  await support.getByText("Reset link sent to a••••@example.com.", { exact: true }).waitFor();
  // No passkeys: it says so.
  await support.getByRole("button", { name: "Remove lost passkeys", exact: true }).click();
  await support.getByText("Amina N. has no passkeys to remove.", { exact: true }).waitFor();

  // Devices: the slots as drawn, and Revoke device with a reason.
  await page.getByRole("tab", { name: "Devices", exact: true }).click();
  const devices = page.locator("[data-customer-devices]");
  await devices.locator(".admin-slot").first().waitFor();
  assert.match(await text(devices.locator(".admin-slots__head")), /^Personal Unlimited · 7 days · 2 devices · 2 of 2 slots used · ends \w{3} \d{1,2} \w{3} \d\d:\d\d$/);
  assert.deepEqual(await devices.locator(".admin-slot > span").evaluateAll((rows) => rows.map((row) => row.innerText.replace(/\s+/g, " ").trim().replace(/\d\d:\d\d/, "HH:MM"))),
    ["Slot 1 · HP laptop · ••:••:••:19:C7:5E · offline, last seen HH:MM", "Slot 2 · Android phone · ••:••:••:4F:A2:10 · online at AP-Market since HH:MM"]);
  assert.match(await text(devices.locator(".admin-slots__note")), /frees the slot\. The bundle's end date doesn't change\. Replacements made by the customer: none this bundle\.$/);
  await devices.getByRole("button", { name: "Revoke device", exact: true }).first().click();
  const revoke = page.getByRole("dialog", { name: "Revoke HP laptop?" });
  await revoke.getByLabel("Reason (kept in the audit log)").fill("Laptop lost");
  await revoke.getByRole("button", { name: "Revoke device", exact: true }).click();
  await devices.getByText(/^Revoked\. /).waitFor();
  assert.equal((await store.snapshot()).wifiDeviceGrants.find((g) => g.id === "g-laptop").status, "revoked");

  // Revoke current subscription: confirmed and audited.
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await support.getByRole("button", { name: "Revoke current subscription", exact: true }).click();
  const sub = page.getByRole("dialog", { name: "Revoke Amina N.'s current subscription?" });
  assert.equal(await text(sub.locator("[data-confirm-body]")), "Their devices are disconnected now and the rest of the bundle is lost. This can't be undone.");
  await sub.getByRole("button", { name: "Revoke current subscription", exact: true }).click();
  await page.getByText("Subscription revoked. Logged in the audit trail.", { exact: true }).waitFor();
  const s = await store.snapshot();
  assert.equal(s.vouchers.find((v) => v.id === "va").status, "revoked");
  assert.ok(s.auditLogs.some((a) => a.action === "voucher.revoked"));
  assert.deepEqual(errors, []);
});
