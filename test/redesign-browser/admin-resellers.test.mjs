import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Resellers, stock and cash (#390, canvas: AdminResellers) at 1280 px, with the
// owner's decisions of 25 Nov:
// - "Commission split: N% · Change": one rate for every reseller; Change opens
//   the rate form kept below;
// - the ledger as drawn, with each reseller's @sign-in name under the name,
//   "Net owed" orange while something is owed, amounts with the comma in English;
// - Record a cash handoff, then "Recorded … · by Owner · …";
// - the corrections form and the two histories stay below.
// Local servers only, synthetic data, a fixed clock (17:30 in Douala, 25 Nov).

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s  ]+/g, " ").trim();
const now = new Date("2026-11-25T16:30:00Z");

test("Resellers shows the drawn ledger, one commission split, and records a cash handoff", { timeout: 300000 }, async (t) => {
  const secret = "redesign-admin-resellers", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] },
      { id: "u-operator", username: "brenda-op", displayName: "Brenda", role: "operator", active: true, passkeys: [] });
    for (const [user, token] of [["u-owner", "owner-token"], ["u-operator", "operator-token"]])
      s.adminSessions.push({ userId: user, role: user === "u-owner" ? "owner" : "operator", tokenHash: hashSecret(token, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    const reseller = (id, username, name, remitted) => s.adminUsers.push({ id, username, displayName: name, role: "reseller", active: true, passkeys: [], commissionPercent: 10,
      remittances: remitted ? [{ id: `rem-${id}`, amount: remitted, note: "", recordedBy: "owner", createdAt: "2026-11-20T09:00:00Z" }] : [] });
    reseller("r-kiosk", "brenda", "Market kiosk", 20000); reseller("r-canteen", "canteen", "School canteen", 16200); reseller("r-church", "church", "Church shop", 0);
    let n = 0;
    const codes = (owner, count, sold) => { for (let i = 0; i < count; i++, n++) s.vouchers.push({ id: `v${n}`, code: `NC-${String(n).padStart(4, "0")}-RSLR`, planId: "weekly",
      status: i < sold ? "active" : "available", activatedAt: i < sold ? "2026-11-21T10:00:00Z" : null, expiresAt: null, quotaBytes: 5e9, usedBytes: 0, deviceLimit: 1,
      generatedByAdmin: true, assignedResellerId: owner, commissionPercent: 10, resale: true, saleType: "sold", saleAmount: 2000, faceValue: 2000, createdAt: "2026-11-15T10:00:00Z" }); };
    codes("r-kiosk", 40, 26); codes("r-canteen", 20, 9); codes("r-church", 20, 0);
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
  const screenshots = process.env.ADMIN_RESELLERS_SCREENSHOTS || "/tmp/ndahi-admin-resellers";
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
    await page.goto(`${admin}/dashboard#resellers`);
    await page.locator(".admin-resellers__table tbody tr").first().waitFor();
    return { page, context, errors };
  };
  const rows = (page) => page.locator(".admin-resellers__table tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.replace(/\s+/g, " ").trim())));

  const { page, context, errors } = await open();
  assert.equal(await text(page.locator("#adminTitle")), "Resellers, stock and cash.");
  assert.equal(await text(page.locator("#resellerSplit")), "Commission split: 10% · Change");
  assert.deepEqual(await page.locator(".admin-resellers__table th").allInnerTexts(), ["Reseller", "Assigned stock", "Redeemed sales", "Cash collected", "Commission", "Remitted", "Net owed"]);
  assert.deepEqual(await rows(page), [
    ["Market kiosk @brenda", "40 codes", "26", "52,000 FCFA", "5,200 FCFA", "20,000 FCFA", "26,800 FCFA"],
    ["School canteen @canteen", "20 codes", "9", "18,000 FCFA", "1,800 FCFA", "16,200 FCFA", "0 FCFA"],
    ["Church shop @church", "20 codes", "0", "0 FCFA", "0 FCFA", "0 FCFA", "0 FCFA"],
  ]);
  // Orange while something is owed, green once settled, as drawn.
  assert.deepEqual(await page.locator(".admin-resellers__owed").evaluateAll((els) => els.map((el) => getComputedStyle(el).color)), ["rgb(138, 74, 0)", "rgb(52, 80, 0)", "rgb(52, 80, 0)"]);
  assert.equal(await text(page.locator(".admin-resellers__note")), "Net owed = cash collected − commission − remitted.");
  assert.deepEqual(await page.locator("#handoffReseller option").allInnerTexts(), ["Market kiosk", "School canteen", "Church shop"]);
  assert.equal(await page.locator(".admin-resellers__form input[name=note]").count(), 0, "no note field, as drawn");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${screenshots}/resellers-en.png`, fullPage: true });

  // Record a cash handoff: audited, then the drawn confirmation and the new figures.
  await page.locator("#handoffAmount").fill("20000");
  await page.locator(".admin-resellers__record").click();
  await page.locator(".admin-resellers__recorded:not([hidden])").waitFor();
  assert.equal(await text(page.locator(".admin-resellers__recorded")), "Recorded 20,000 FCFA from Market kiosk · by Owner · 25 Nov 17:30");
  assert.deepEqual((await rows(page))[0].slice(5), ["40,000 FCFA", "6,800 FCFA"]);
  assert.ok((await store.snapshot()).auditLogs.some((entry) => entry.action === "reseller.remittance_recorded" && entry.meta.amount === 20000));
  await page.screenshot({ path: `${screenshots}/resellers-recorded-en.png`, fullPage: true });

  // Change, by keyboard: opens the rate form; the new rate is every reseller's.
  const change = page.locator("#resellerSplit").getByRole("button", { name: "Change", exact: true });
  await change.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("rate")?.open === true);
  assert.equal(await page.evaluate(() => document.activeElement?.name), "commissionPercent");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("12.5");
  await page.locator("[data-reseller-commission-form] button[type=submit]").click();
  await page.getByText("Every reseller now earns 12.5% on codes issued from now on.").waitFor();
  assert.equal(await text(page.locator("#resellerSplit")), "Commission split: 12.5% · Change");
  assert.deepEqual((await rows(page))[0].slice(4), ["5,200 FCFA", "40,000 FCFA", "6,800 FCFA"], "codes already sold keep their rate");
  // Kept by the owner: corrections and both histories.
  assert.equal(await page.locator("[data-reseller-adjustment-form]").count(), 1);
  assert.match(await text(page.locator(".admin-resellers__history").first()), /Audited cash handoffs \(3\)/);
  assert.deepEqual(errors, []);
  await context.close();

  // French: the space in amounts, "12,5 %".
  const fr = await open({ lang: "fr" });
  assert.equal(await text(fr.page.locator("#adminTitle")), "Revendeurs, stock et espèces.");
  assert.equal(await text(fr.page.locator("#resellerSplit")), "Commission : 12,5 % · Modifier");
  assert.deepEqual(await fr.page.locator(".admin-resellers__table th").allInnerTexts(), ["Revendeur", "Stock attribué", "Ventes utilisées", "Espèces encaissées", "Commission", "Remis", "Reste dû"]);
  assert.deepEqual((await rows(fr.page))[0], ["Market kiosk @brenda", "40 codes", "26", "52 000 FCFA", "5 200 FCFA", "40 000 FCFA", "6 800 FCFA"]);
  await fr.page.mouse.move(0, 0);
  await fr.page.screenshot({ path: `${screenshots}/resellers-fr.png`, fullPage: true });
  assert.deepEqual(fr.errors, []);
  await fr.context.close();

  // An operator reads the ledger but records nothing and changes no rate.
  const operator = await open({ token: "operator-token" });
  assert.equal(await text(operator.page.locator("#resellerSplit")), "Commission split: 12.5%");
  assert.equal(await operator.page.locator(".admin-resellers__handoff, [data-reseller-commission-form], [data-reseller-adjustment-form]").count(), 0);
  assert.deepEqual(operator.errors, []);
  await operator.context.close();

  // Phones: no sideways scrolling.
  const phone = await open({ width: 390 });
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await lowContrastText(phone.page), []);
  await phone.context.close();
});
