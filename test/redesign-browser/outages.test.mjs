import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Outages (#259, canvas: AdminOutage, PhoneOutage, AdminSide): the router stops
// answering; staff post the notice (EN + FR) and an update; customers see it
// on Home; staff mark it fixed and give the time back with fresh PIN proof;
// customers see "We're back online" with the hours added.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const at = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Douala" });

test("staff post an outage, customers see it, and time is given back", { timeout: 240000 }, async (t) => {
  const secret = "redesign-outages", pin = "482913", store = createStore({ persistent: false }), since = at(-145);
  await store.transaction(async (s) => {
    s.adminUsers.push({ id: "out-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passwordHash: await argon2.hash(pin), passkeys: [] });
    s.adminSessions.push({ userId: "out-owner", role: "owner", tokenHash: hashSecret("out-owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.customers.push({ id: "c-amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", emailVerifiedAt: at(-6000) }, { id: "c-jean", name: "Jean Fon", phone: "670004019" });
    s.dashboardSessions.push({ id: "sess", customerId: "c-amina", role: "customer", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    for (const [id, customerId] of [["v-amina", "c-amina"], ["v-jean", "c-jean"]]) s.vouchers.push({ id, customerId, planId: "weekly", code: `NC-${id.slice(2, 6).toUpperCase()}-0001`, status: "active",
      activatedAt: at(-4000), expiresAt: at(2880), quotaBytes: 5e9, usedBytes: 1.8e9, deviceLimit: 3, routerSyncStatus: "synchronized" });
    // The router stopped answering when the outage began.
    s.operationalIncidents.push({ id: "inc-1", key: "k", action: "sync_usage", problem: "unavailable", status: "open", global: true, count: 3, failures: {}, customerIds: [], firstAt: since, lastAt: at(-1) });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`, admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); await close(adminServer); });
  const screenshots = "/tmp/ndahi-outages";
  await mkdir(screenshots, { recursive: true });
  const open = async (width, origin, cookie) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1020 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([cookie, { name: "ndahi_ui", value: "v2", url: origin, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return { context, page, errors };
  };
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };
  const staff = await open(1280, admin, { name: "admin_session", value: "out-owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" });
  const customer = await open(390, portal, { name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" });
  const desk = staff.page, phone = customer.page;

  // Detected, then the notice is posted.
  await desk.goto(`${admin}/dashboard#outages`);
  await desk.getByRole("heading", { name: "Outages.", level: 1 }).waitFor();
  await desk.getByRole("link", { name: "Outages" }).waitFor();
  const post = desk.locator("#outagePost");
  await post.waitFor();
  assert.equal(await text(desk.locator(".admin-outage__detected")), `The router has not answered since ${clock(since)}. Detected automatically — post a notice so customers know.`);
  assert.equal(await desk.getByLabel("Message (English)").inputValue(), `Our satellite link dropped at ${clock(since)}. We're working on it. The time you lose will be added back to your bundle.`);
  assert.equal(await text(desk.locator(".admin-outage__check").nth(1)), "Send a notification and email to the 2 customers with an active bundle");
  await check(desk, "admin-detected");
  await desk.getByRole("button", { name: "Post notice" }).click();
  const live = desk.getByRole("region", { name: "Outage in progress" });
  await live.waitFor();
  assert.match(await text(live), /Outage in progress Down 2 h 2[4-9] min All sites · since \d\d:\d\d · notice shown to customers · 2 active bundles affected/);
  await desk.getByLabel("Post an update").fill("Engineer on site, expected back by 17:00");
  await desk.getByRole("button", { name: "Post update" }).click();
  await desk.getByText("Update posted. Customers see it with the notice.").waitFor();
  await check(desk, "admin-live");

  // The customer's Home during the outage.
  await phone.goto(`${portal}/dashboard#home`);
  const down = phone.getByRole("status", { name: "Network outage" });
  await down.waitFor();
  assert.match(await text(down), new RegExp(`^Internet is down in All sites Our satellite link dropped at ${clock(since)}\\. .* Engineer on site, expected back by 17:00 Updated \\d\\d:\\d\\d by NDAHI · next update by \\d\\d:\\d\\d$`));
  assert.equal(await text(phone.locator(".home-outage-line")), "Network down · All sites");
  assert.equal(await text(phone.locator("#dataBalance [data-bundle-status]")), "No internet");
  assert.match(await text(phone.locator("#dataBalance .nd-meter-legend")), /\+ lost time/);
  await check(phone, "home-down");

  // Fixed: 2 h 25 min rounds up to 3 hours, with fresh PIN proof.
  await desk.getByRole("button", { name: "Mark as fixed…" }).click();
  const back = desk.getByRole("form", { name: "Back online — give time back?" });
  await back.waitFor();
  assert.match(await text(back), /Outage lasted 2 h 2[4-9] min \(\d\d:\d\d – \d\d:\d\d\)\. 2 customers had an active bundle during it\./);
  assert.equal(await back.getByRole("radio", { name: /\+3 hours/ }).isChecked(), true);
  await check(desk, "admin-fixed");
  await back.getByRole("radio", { name: /Nothing/ }).check();
  await back.getByRole("button", { name: "Close outage" }).waitFor();
  await back.getByRole("radio", { name: /\+3 hours/ }).check();
  await back.getByRole("button", { name: "Add 3 hours to 2 bundles" }).click();
  const dialog = desk.getByRole("dialog", { name: "Verify administrator action" });
  await dialog.getByLabel("Current administrator PIN").fill(pin);
  await dialog.getByRole("button", { name: "Verify PIN", exact: true }).click();
  await desk.getByText("Outage closed.").waitFor();
  assert.equal(await text(desk.locator(".admin-outage__done")), 'Outage closed. +3 hours added to 2 bundles. Customers now see "We’re back online".');
  assert.match(await text(desk.getByRole("region", { name: "Past outages" })), /All sites 2 h 2[4-9] min — \+3 h · 2 customers/);
  await check(desk, "admin-closed");

  // The customer: back online with the hours added.
  await phone.reload();
  const restored = phone.getByRole("status", { name: "Network restored" });
  await restored.waitFor();
  assert.match(await text(restored), /^We're back online Sorry for the interruption\. We added 3 hours to your bundle to make up for it\. Outage \d\d:\d\d – \d\d:\d\d · fixed$/);
  assert.notEqual(await text(phone.locator("#dataBalance [data-bundle-status]")), "No internet");
  await check(phone, "home-restored");
  const s = await store.snapshot();
  assert.equal(Date.parse(s.vouchers.find((v) => v.id === "v-amina").expiresAt) - Date.parse(at(2880)) > 3 * 36e5 - 120000, true);
  assert.deepEqual([...staff.errors, ...customer.errors], []);
});
