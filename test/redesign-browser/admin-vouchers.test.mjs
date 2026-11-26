import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Vouchers (canvas: AdminVouchers, #343; owner 26 Nov): the custom gift form
// for owners ("They'll see: Gift from NDAHI · Unlimited · 10 days · 3 devices",
// the reason required), a number with no account (reserved, "Waiting for
// claim"), Recent vouchers as drawn (Code, Bundle, For, Type, Status; one
// search; no Filters or row actions), the batch box "Batch … ready · N codes",
// and operators without the Custom bundle tab. 1280 px, local servers only.

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("vouchers: custom gifts, a number with no account, the drawn list and batch box", { timeout: 200000 }, async (t) => {
  const secret = "redesign-admin-vouchers", store = createStore({ persistent: false }), now = new Date();
  await store.transaction((s) => {
    s.bundles.push({ id: "p2", name: "Weekly Unlimited", price: 3500, validityHours: 168, accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaGb: null, status: "published", catalogue: "unlimited" });
    s.customers.push({ id: "c-amina", name: "Amina N.", phone: "670001245", status: "active", createdAt: "2026-10-01T08:00:00Z" },
      { id: "c-grace", name: "Grace T.", phone: "670000366", status: "active", createdAt: "2026-10-01T08:00:00Z" });
    s.vouchers.push({ id: "va", code: "R2DA-8AQN", customerId: "c-amina", planId: "p2", status: "active", accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, validityHours: 168,
      activatedAt: now.toISOString(), expiresAt: new Date(+now + 6 * 864e5).toISOString(), createdAt: now.toISOString(), saleType: "sold", generatedByAdmin: true });
    for (const [id, role] of [["owner", "owner"], ["operator", "operator"]]) {
      s.adminUsers.push({ id, username: id, displayName: id, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: id, role, tokenHash: hashSecret(id, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
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
  const screenshots = process.env.ADMIN_VOUCHERS_SCREENSHOTS || "/tmp/ndahi-admin-vouchers";
  await mkdir(screenshots, { recursive: true });
  const open = async (token) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: token, url: `${api}/api/admin`, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(admin + "/dashboard#vouchers");
    await page.locator('[name="customerSearch"]').waitFor();
    return { page, errors, context };
  };
  const text = (locator) => locator.evaluate((el) => el.innerText.replace(/\s+/g, " ").trim());

  const { page, errors, context } = await open("owner");
  // Recent vouchers as drawn.
  assert.deepEqual(await page.locator("#voucherRecords thead th").allInnerTexts(), ["Code", "Bundle", "For", "Type", "Status"]);
  assert.equal(await page.locator("#voucherRecords input[type=search]").getAttribute("placeholder"), "Code, name or number");
  assert.equal(await page.getByText("Filters", { exact: true }).count(), 0);
  assert.equal(await page.locator("#voucherRecords .voucher-record-actions, #voucherRecords [data-print-voucher]").count(), 0);
  assert.equal(await page.locator("#voucherRecords .records-pager").isVisible(), false, "no pager for one page");

  // A custom gift for Amina: the button waits for the reason and the replacement.
  await page.locator('[name="customerSearch"]').fill("Amina");
  await page.locator("[data-give-pick]").filter({ hasText: "Amina" }).click();
  assert.equal(await text(page.locator(".customer-voucher__picked .nd-meta")), "+237 6•• •• 12 45 · Weekly Unlimited active, ends " + new Date(+now + 6 * 864e5).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Douala" }));
  await page.getByRole("tab", { name: "Custom bundle", exact: true }).click();
  await page.locator('[name="customValue"]').fill("10");
  await page.locator('[data-give-slots="4"]').click();
  await page.locator('[name="customSlots"]').fill("3");
  assert.equal(await text(page.locator(".customer-voucher__preview")), "They'll see: Gift from NDAHI · Unlimited · 10 days · 3 devices");
  const give = page.getByRole("button", { name: "Give custom bundle as a gift", exact: true });
  assert.equal(await give.isDisabled(), true, "the reason is required");
  await page.locator('[name="customReason"]').fill("Compensation for the 18 Nov outage at AP-Market");
  assert.equal(await give.isDisabled(), true, "the replacement must be confirmed");
  assert.equal(await page.getByRole("group", { name: "How it was paid" }).count(), 0, "custom gifts are always gifts");
  await page.getByLabel("Yes, replace their current bundle").check();
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/custom-personal.png`, fullPage: true });
  await give.click();
  await page.locator(".customer-voucher__code").waitFor();
  // Uppercased on screen, as drawn.
  assert.equal(await page.locator(".customer-voucher__code .nd-eyebrow").textContent(), "Gift · Custom · Unlimited · 10 days · 3 devices");
  assert.match(await text(page.locator(".customer-voucher__success")), /Their old Weekly Unlimited bundle was ended and its devices disconnected\. Logged in the audit trail\./);
  const gift = (await store.snapshot()).vouchers.find((v) => v.customTerms && v.customerId === "c-amina");
  assert.deepEqual([gift.saleType, gift.saleAmount, gift.customTerms.deviceSlots, gift.customTerms.validityHours], ["gift", 0, 3, 240]);
  assert.equal(typeof gift.givenAt, "string");
  // Home WISP shows its line and no slots.
  await page.getByRole("button", { name: "Give another", exact: true }).click();
  await page.locator('[name="customerSearch"]').fill("Grace");
  await page.locator("[data-give-pick]").filter({ hasText: "Grace" }).click();
  await page.getByRole("tab", { name: "Custom bundle", exact: true }).click();
  await page.getByText("Home WISP Unlimited", { exact: true }).click();
  await page.locator('[name="customValue"]').fill("10");
  assert.equal(await page.locator("[data-give-slots]").count(), 0);
  assert.equal(await text(page.locator(".customer-voucher__wisp")), "Supported WISP router · household sharing on");
  assert.equal(await text(page.locator(".customer-voucher__preview")), "They'll see: Gift from NDAHI · Home WISP Unlimited · 10 days");

  // A number with no account: reserved for it, and shown as waiting for claim.
  await page.locator("[data-give-change]").click();
  await page.locator('[name="customerSearch"]').fill("670009910");
  const unknown = page.locator("[data-give-number]");
  assert.equal(await text(unknown), "? 6•• •• 99 10 No account with this number");
  await unknown.click();
  assert.match(await text(page.locator(".customer-voucher__reserved")), /^The voucher is reserved for this number\. To claim it they need the number and the code/);
  await page.getByRole("tab", { name: "From the catalogue", exact: true }).click();
  await page.locator('#customerVoucherForm [name="planId"]').selectOption("p2");
  await page.getByRole("radio", { name: /Gift/ }).check();
  await page.getByRole("button", { name: "Reserve Weekly Unlimited for this number", exact: true }).click();
  await page.locator(".customer-voucher__code").waitFor();
  assert.match(await text(page.locator(".customer-voucher__success")), /Reserved for \+237 6•• •• 99 10\. Give them this code: they claim it with their number when they sign up\. Expires \d{1,2} \w{3} \d{4} if unclaimed\./);
  const reserved = (await store.snapshot()).vouchers.find((v) => v.reservation);
  const row = page.locator(`[data-voucher-record="${reserved.id}"]`);
  await row.waitFor();
  assert.deepEqual(await row.locator("td").allInnerTexts(), [reserved.code, "Weekly Unlimited", "6•• •• 99 10 · no account yet", "Gift", "Waiting for claim"]);
  // The list finds a voucher by the customer's name.
  await page.locator("#voucherRecords input[type=search]").fill("Amina");
  await page.locator(`[data-voucher-record="${gift.id}"]`).waitFor();
  assert.equal(await text(page.locator(`[data-voucher-record="${gift.id}"] td:nth-child(2)`)), "Custom · 10 days · 3 devices");

  // A batch: "Batch … ready · 3 codes" and Print slips; no More options.
  await page.getByRole("tab", { name: "Batch to print or sell", exact: true }).click();
  assert.equal(await page.locator("#voucherOptions").isVisible(), false);
  await page.getByLabel("How many", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Create 3 vouchers", exact: true }).click();
  await page.locator("#generated .admin-batch--ready strong").filter({ hasText: /^Batch \S+ ready · 3 codes$/ }).waitFor();
  await page.locator("#generated").getByRole("link", { name: "Print slips", exact: true }).waitFor();
  assert.deepEqual(await lowContrastText(page), []);
  assert.deepEqual(errors, []);
  await context.close();

  // An operator: catalogue only, no Custom bundle tab.
  const op = await open("operator");
  await op.page.locator('[name="customerSearch"]').fill("Grace");
  await op.page.locator("[data-give-pick]").filter({ hasText: "Grace" }).click();
  assert.equal(await op.page.getByRole("tab", { name: "Custom bundle" }).count(), 0);
  await op.page.locator('#customerVoucherForm [name="planId"]').waitFor();
  assert.deepEqual(op.errors, []);
  await op.context.close();
});
