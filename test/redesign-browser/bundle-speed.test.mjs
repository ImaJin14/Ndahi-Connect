import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Speed limit per customer on Edit bundle (#263; canvas AdminBundleEdit, #339):
// "Speed limit (optional)" stays collapsed when empty; the owner sets download
// and upload Mbps, the preview reads "up to N Mbps", saving stores them and a
// blank field clears a limit. While ROUTER_SPEED_LIMITS is off the section says
// the router does not apply them yet (owner, #339). Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

async function start(t, speedLimits) {
  const secret = "redesign-bundle-speed", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "sp-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "sp-owner", role: "owner", tokenHash: hashSecret("sp-owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    seedCatalogue(s, new Date("2026-11-25T00:00:00Z"));
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", ...(speedLimits ? { ROUTER_SPEED_LIMITS: "on" } : {}),
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  t.after(async () => { await close(apiServer); await close(adminServer); });
  return { store, api, admin };
}

test("the owner sets a bundle's speed limit, sees it in the preview, and is told when the router does not apply it yet", { timeout: 240000 }, async (t) => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(() => browser.close());
  const screenshots = process.env.SPEED_SCREENSHOTS || "/tmp/ndahi-bundle-speed";
  await mkdir(screenshots, { recursive: true });
  const open = async ({ api, admin }, width = 1280) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1020 } });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "sp-owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${admin}/dashboard#bundle/unlimited-7d-2`);
    await page.locator(".admin-edit__speed").waitFor();
    return { context, page, errors };
  };
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };
  const save = async (page) => Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/admin/catalogue/update") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Save bundle", exact: true }).click(),
  ]);

  // Off (the default until the RB5009 check): the form says so.
  const off = await start(t, false);
  const { context, page, errors } = await open(off);
  const form = page.locator(".admin-edit__speed"), detail = page.locator("#editCardLine");
  assert.equal(await form.evaluate((el) => el.open), false, "collapsed while empty");
  assert.equal(await text(form.locator("summary")), "Speed limit (optional)");
  await form.locator("summary").click();
  assert.equal(await form.getByLabel("Download (Mbps)", { exact: true }).getAttribute("placeholder"), "No limit");
  assert.equal(await text(form.locator(".admin-edit__hint")), "Shared by all of a customer's devices. Applied on the MikroTik as a queue for this bundle. Leave blank for no limit.");
  assert.match(await text(page.locator("#speedLimitsOff")), /^Not applied on the router yet/);

  // Keyboard: Tab goes from the summary to Download to Upload, each with a visible ring.
  await form.locator("summary").focus();
  for (const name of ["download", "upload"]) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.name), name);
    assert.equal(await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2 || cs.boxShadow !== "none"; }), true, `${name} focus ring`);
  }

  await form.getByLabel("Download (Mbps)", { exact: true }).fill("10");
  await form.getByLabel("Upload (Mbps)", { exact: true }).fill("3");
  assert.equal(await text(detail), "Unlimited data · 7 days · 2 registered devices · up to 10 Mbps");
  await page.evaluate(() => document.activeElement.blur());
  await check(page, "bundle-edit-speed-1280");

  await save(page);
  await page.getByText("Saved. New checkouts use these terms now. Logged in the audit trail.", { exact: true }).waitFor();
  let saved = (await off.store.snapshot()).bundles.find((b) => b.id === "unlimited-7d-2");
  assert.deepEqual([saved.downloadMbps, saved.uploadMbps, saved.quotaGb], [10, 3, null]);
  // The saved values come back (open, as set), and a blank field clears that limit.
  assert.equal(await page.locator(".admin-edit__speed").evaluate((el) => el.open), true);
  assert.equal(await page.getByLabel("Download (Mbps)", { exact: true }).inputValue(), "10");
  assert.equal(await page.getByLabel("Upload (Mbps)", { exact: true }).inputValue(), "3");
  await page.getByLabel("Upload (Mbps)", { exact: true }).fill("");
  await save(page);
  saved = (await off.store.snapshot()).bundles.find((b) => b.id === "unlimited-7d-2");
  assert.deepEqual([saved.downloadMbps, saved.uploadMbps], [10, null]);
  assert.deepEqual(errors, []);
  await context.close();

  // Phone width: the fields stack without overflow.
  const phone = await open(off, 390);
  assert.equal(await phone.page.getByLabel("Download (Mbps)", { exact: true }).inputValue(), "10");
  await check(phone.page, "bundle-edit-speed-390");
  assert.deepEqual(phone.errors, []);
  await phone.context.close();

  // On: the note goes, the fields stay.
  const on = await start(t, true);
  const second = await open(on);
  assert.equal(await second.page.locator("#speedLimitsOff").count(), 0);
  await check(second.page, "bundle-edit-speed-on-1280");
  assert.deepEqual(second.errors, []);
  await second.context.close();
});
