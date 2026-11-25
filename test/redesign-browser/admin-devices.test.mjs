import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { ensureHome } from "../../lib/home.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Live Wi-Fi devices (#381, canvas: AdminDevices) at 1280 px, with the owner's
// decisions of 24-25 Nov:
// - one row per customer: "4 of 4 slots", "2 devices" on an older plan,
//   "1 router" for Home WISP, a code with no account by its code;
// - the access-point filter and the Access point and Signal cells as drawn
//   but empty ("—"): the access points run standalone;
// - the pop-up: a real dialog, each device masked, Disconnect (the session
//   only), Disconnect all, Open customer;
// - the list updates every 5 seconds without a reload.
// Local servers only, synthetic data, a fixed clock (17:30 in Douala, Wed 25 Nov).

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const now = new Date("2026-11-25T16:30:00Z");
const at = (hm, date = "2026-11-25") => new Date(`${date}T${hm}:00+01:00`).toISOString();

test("Live devices shows one row per customer and their devices in a pop-up", { timeout: 300000 }, async (t) => {
  const secret = "redesign-admin-devices", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.networkSetup = { runtimeRouterEnabled: true };
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] },
      { id: "u-auditor", username: "audit", displayName: "Audit", role: "auditor", active: true, passkeys: [] });
    for (const [user, token, role] of [["u-owner", "owner-token", "owner"], ["u-auditor", "auditor-token", "auditor"]])
      s.adminSessions.push({ userId: user, role, tokenHash: hashSecret(token, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.customers.push({ id: "c-amina", name: "Amina N.", phone: "670001245", status: "active", createdAt: "2026-10-01T08:00:00Z" },
      { id: "c-fon", name: "J. Fon", phone: "690004417", status: "active", createdAt: "2026-10-01T08:00:00Z" },
      { id: "c-ngum", name: "Ngum family", phone: "650002233", status: "active", homeConnectionId: "h1", createdAt: "2026-10-01T08:00:00Z" },
      { id: "c-grace", name: "Grace T.", phone: "670007788", status: "active", createdAt: "2026-10-01T08:00:00Z" });
    s.bundles.push({ id: "gig-standard", name: "Gig Standard", price: 5000, quotaGb: 20, validityHours: 168, deviceLimit: 2, status: "archived" });
    const read = new Date(+now - 20000).toISOString();
    const device = (name, mac, hm, used, n) => ({ name, mac, address: `10.20.0.${n}`, uptime: "1h", usedBytes: used, sessionId: `*${n}`, startedAt: at(hm), day: "2026-11-25", dayStartBytes: 0 });
    const voucher = (id, customerId, extra) => ({ id, customerId, code: `NC-${id}`, status: "active", activatedAt: at("06:00"), quotaBytes: null, usedBytes: 0, wifiDevicesAt: read, ...extra });
    s.vouchers.push(
      voucher("va", "c-amina", { accessType: "personal_unlimited", deviceSlots: 4, deviceLimit: 4, validityHours: 168, expiresAt: at("12:00", "2026-11-27"),
        wifiDevices: [device("Android phone", "A2:44:7E:8B:03:D1", "08:12", 420e6, 11), device("HP laptop", "B6:10:2C:19:C7:5E", "09:40", 1.1e9, 12),
          device("Samsung tablet", "C8:3A:6F:4F:A2:10", "10:05", 650e6, 13), device("Smart TV", "D2:5B:91:E2:71:9A", "10:30", 2.8e9, 14)] }),
      voucher("vf", "c-fon", { planId: "gig-standard", quotaBytes: 20e9, deviceLimit: 2, expiresAt: at("12:00", "2026-11-27"),
        wifiDevices: [device("iPhone", "E4:22:7A:61:0D:44", "07:55", 760e6, 21), device("Tablet", "F0:18:98:A9:3E:12", "06:30", 2.3e9, 22)] }),
      voucher("vn", "c-ngum", { accessType: "home_wisp_unlimited", accessMode: "home", homeStatus: "connected", homeGeneration: 1, homeOnlineSince: at("18:02", "2026-11-23"),
        usedBytes: 50e9, homeDay: { date: "2026-11-25", bytes: 50e9 - 9.4e9 }, lastUsageSyncAt: new Date(+now - 5000).toISOString(), expiresAt: at("12:00", "2026-12-22"), wifiDevicesAt: undefined }),
      voucher("vg", "c-grace", { accessType: "personal_unlimited", deviceSlots: 1, deviceLimit: 1, validityHours: 24, expiresAt: at("21:10"),
        wifiDevices: [device("Android phone", "A6:0C:11:5D:22:B7", "13:05", 310e6, 31)] }),
      voucher("vv", null, { code: "K7PM-42XQ", accessType: "personal_unlimited", deviceSlots: 1, deviceLimit: 1, validityHours: 5, expiresAt: at("21:48"),
        wifiDevices: [device("Android phone", "AA:3B:52:0A:9F:63", "16:48", 95e6, 41)] }),
    );
    ensureHome(s).homeConnections.push({ id: "h1", customerId: "c-ngum", status: "linked", mac: "D4:6E:0E:9C:31:E4", generation: 1, routerRevision: "" });
    const grant = (id, customerId, voucherId, mac) => ({ id, customerId, voucherId, mac, status: "approved", routerRevision: "", createdAt: at("06:00") });
    s.wifiDeviceGrants = [grant("g1", "c-amina", "va", "A2:44:7E:8B:03:D1"), grant("g2", "c-amina", "va", "B6:10:2C:19:C7:5E"), grant("g3", "c-amina", "va", "C8:3A:6F:4F:A2:10"),
      grant("g4", "c-amina", "va", "D2:5B:91:E2:71:9A"), grant("g5", "c-grace", "vg", "A6:0C:11:5D:22:B7"), grant("g6", null, "vv", "AA:3B:52:0A:9F:63")];
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await listen(apiServer, apiPort);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.ADMIN_DEVICES_SCREENSHOTS || "/tmp/ndahi-admin-devices";
  await mkdir(screenshots, { recursive: true });
  const open = async ({ token = "owner-token", lang = "en", width = 1280 } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1110 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: token, url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
    await context.clock.setFixedTime(now);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] });
      set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Fonts from outside are blocked here on purpose; any other console error counts.
    page.on("console", (message) => { if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) errors.push(message.text()); });
    await page.goto(`${admin}/dashboard#devices`);
    await page.locator("#liveDeviceRows .admin-devices__view").first().waitFor();
    return { page, context, errors };
  };
  const rows = (page) => page.locator("#liveDeviceRows tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.replace(/\s+/g, " ").trim())));
  const dialogRows = (page) => page.locator("#liveDeviceDialog tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.replace(/\s+/g, " ").trim())));

  const { page, context, errors } = await open();
  assert.equal(await text(page.locator("#adminEyebrow")), "NETWORK");
  assert.equal(await text(page.locator("#adminTitle")), "Live Wi-Fi devices.");
  assert.equal(await text(page.locator("#wifiSummary")), "9 devices · 5 customers online · updated 20 s ago");
  assert.deepEqual(await page.locator(".admin-devices__ap").allInnerTexts(), ["All access points"]);
  assert.equal(await page.locator("#liveDeviceSearch").getAttribute("placeholder"), "Name, number or voucher code");
  assert.deepEqual(await page.locator(".admin-devices__card th").allInnerTexts(), ["Customer", "Devices online", "Access point", "Today", "Online since", "Action"]);
  assert.deepEqual(await rows(page), [
    ["A Amina N. Personal Unlimited · 7 days", "4 of 4 slots", "—", "5.0 GB", "08:12", "View 4 devices"],
    ["J J. Fon Gig Standard · current plan, original terms", "2 devices", "—", "3.1 GB", "06:30", "View 2 devices"],
    ["N Ngum family Home WISP Unlimited", "1 router", "—", "9.4 GB", "Mon 18:02", "View device"],
    ["G Grace T. Personal Unlimited · 24 hours", "1 of 1 slot", "—", "310 MB", "13:05", "View device"],
    ["# Voucher K7PM-42XQ Personal Unlimited · 5 hours", "1 of 1 slot", "—", "95 MB", "16:48", "View device"],
  ]);
  // A full bundle's count is forest and lime, as drawn.
  assert.deepEqual(await page.locator(".admin-devices__count").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor)),
    ["rgb(0, 59, 43)", "rgb(238, 243, 233)", "rgb(238, 243, 233)", "rgb(0, 59, 43)", "rgb(0, 59, 43)"]);
  assert.equal(await text(page.locator(".admin-devices__note")), "One row per customer. Open a row to see every device they have online. A Home WISP router counts as one device: NDAHI can't see the household devices behind it.");
  assert.equal(await page.getByRole("button", { name: "Refresh devices" }).count(), 0, "read on its own, as drawn");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/devices-en.png`, fullPage: true });

  // Search by name, number or code.
  const search = page.locator("#liveDeviceSearch");
  await search.fill("690004417");
  assert.deepEqual((await rows(page)).map((r) => r[0]), ["J J. Fon Gig Standard · current plan, original terms"]);
  await search.fill("k7pm");
  assert.deepEqual((await rows(page)).map((r) => r[0]), ["# Voucher K7PM-42XQ Personal Unlimited · 5 hours"]);
  await search.fill("");

  // The pop-up, by keyboard: focus moves in; Escape closes and gives focus back.
  const view = page.getByRole("button", { name: "View the devices of Amina N.", exact: true });
  await view.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("#liveDeviceDialog[open]");
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.className), "admin-devices__close");
  assert.equal(await text(page.locator("#liveDeviceDialogTitle")), "Amina N. · 4 devices online");
  assert.equal(await text(page.locator(".admin-devices__dtitle p")), "Personal Unlimited · 7 days · 4 of 4 device slots · ends Fri 27 Nov");
  assert.equal(await text(page.locator(".admin-devices__full")), "All slots are in use. A new device is refused until one is replaced, even if a registered device goes offline.");
  assert.deepEqual(await dialogRows(page), [
    ["Android phone ••:8B:03:D1 · slot 1", "—", "—", "420 MB", "08:12", "Disconnect"],
    ["HP laptop ••:19:C7:5E · slot 2", "—", "—", "1.1 GB", "09:40", "Disconnect"],
    ["Samsung tablet ••:4F:A2:10 · slot 3", "—", "—", "650 MB", "10:05", "Disconnect"],
    ["Smart TV ••:E2:71:9A · slot 4", "—", "—", "2.8 GB", "10:30", "Disconnect"],
  ]);
  assert.equal(await text(page.locator(".admin-devices__dnote")), "Disconnect ends the session now; the device can sign in again. To free a slot or stop a device for good, use Revoke device on the customer's page.");
  assert.equal(await page.locator(".admin-devices__open").getAttribute("href"), "/dashboard#customer/c-amina");
  assert.equal(await text(page.locator(".admin-devices__all")), "Disconnect all 4");
  assert.match(await page.locator("#liveDeviceRows tr.is-open").innerText(), /Amina N\./);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/devices-amina-en.png`, fullPage: false });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "View the devices of Amina N.");

  // Disconnect ends the session only: the device keeps its approval, so its slot.
  await view.click();
  await page.getByRole("button", { name: "Disconnect Android phone of Amina N.", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Android phone of Amina N.", exact: true }).filter({ hasText: "Disconnecting…" }).waitFor();
  let s = await store.snapshot();
  const command = s.routerCommands.find((c) => c.action === "disconnect_wifi_device");
  assert.deepEqual([command.kind, command.device.mac, command.device.retainApproval], ["wifi_session_disconnect", "A2:44:7E:8B:03:D1", true]);
  assert.equal(s.wifiDeviceGrants.find((g) => g.mac === "A2:44:7E:8B:03:D1").status, "approved");
  await page.locator(".admin-devices__close").click();

  // An older plan: its own device rule; Disconnect all in one audited request.
  await page.getByRole("button", { name: "View the devices of J. Fon", exact: true }).click();
  assert.equal(await text(page.locator(".admin-devices__dtitle p")), "Gig Standard · current plan, original terms · device rule of the current plan · ends Fri 27 Nov");
  assert.equal(await page.locator(".admin-devices__full").count(), 0);
  assert.deepEqual((await dialogRows(page)).map((r) => r[0]), ["iPhone ••:61:0D:44 · current plan", "Tablet ••:A9:3E:12 · current plan"]);
  await page.locator(".admin-devices__all").click();
  await page.locator(".admin-devices__kick:has-text('Disconnecting…')").nth(1).waitFor();
  s = await store.snapshot();
  assert.ok(s.auditLogs.some((a) => a.action === "wifi_device.disconnect_all_requested" && a.meta.customerId === "c-fon" && a.meta.requested === 2));
  await page.keyboard.press("Escape");

  // A Home WISP router: one device, ended through the Home worker.
  await page.getByRole("button", { name: "View the devices of Ngum family", exact: true }).click();
  assert.equal(await text(page.locator("#liveDeviceDialogTitle")), "Ngum family · router online");
  assert.equal(await text(page.locator(".admin-devices__dtitle p")), "Home WISP Unlimited · household devices behind the router aren't visible · ends Tue 22 Dec");
  assert.deepEqual(await dialogRows(page), [["Home WISP router ••:9C:31:E4 · registered router", "—", "—", "9.4 GB", "Mon 18:02", "Disconnect"]]);
  assert.equal(await text(page.locator(".admin-devices__all")), "Disconnect all 1");
  await page.getByRole("button", { name: "Disconnect Home WISP router of Ngum family", exact: true }).click();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(300);
  assert.ok((await store.snapshot()).homeOperations.some((o) => o.kind === "end_session" && o.voucherId === "vn"));
  await page.locator(".admin-devices__close").click();

  // A code with no account: no customer to open.
  await page.getByRole("button", { name: "View the devices of Voucher K7PM-42XQ", exact: true }).click();
  assert.equal(await page.locator(".admin-devices__open").evaluate((el) => getComputedStyle(el).visibility), "hidden");
  assert.deepEqual((await dialogRows(page))[0].slice(0, 1), ["Android phone ••:0A:9F:63 · slot 1"]);
  // Open customer closes the pop-up on its way.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "View the devices of Grace T.", exact: true }).click();
  await page.getByRole("link", { name: "Open customer", exact: true }).click();
  await page.waitForFunction(() => location.hash === "#customer/c-grace");
  assert.equal(await page.locator("#liveDeviceDialog[open]").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();

  // An auditor reads the screen and acts on nothing.
  const auditor = await open({ token: "auditor-token" });
  await auditor.page.locator("#liveDeviceRows .admin-devices__view").first().click();
  assert.equal(await auditor.page.locator(".admin-devices__kick, .admin-devices__all").count(), 0);
  assert.deepEqual(auditor.errors, []);
  await auditor.context.close();

  // French.
  const fr = await open({ lang: "fr" });
  assert.equal(await text(fr.page.locator("#wifiSummary")), "9 appareils · 5 clients en ligne · mis à jour il y a 20 s");
  assert.deepEqual(await fr.page.locator(".admin-devices__card th").allInnerTexts(), ["Client", "Appareils en ligne", "Point d'accès", "Aujourd'hui", "En ligne depuis", "Action"]);
  assert.deepEqual((await rows(fr.page))[0], ["A Amina N. Personal Unlimited · 7 jours", "4 sur 4 places", "—", "5,0 Go", "08:12", "Voir les 4 appareils"]);
  await fr.page.mouse.move(0, 0);
  await fr.page.screenshot({ path: `${screenshots}/devices-fr.png`, fullPage: true });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();

  // Phones: the table scrolls in its card, never the page.
  const phone = await open({ width: 390 });
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await lowContrastText(phone.page), []);
  await phone.context.close();
});
