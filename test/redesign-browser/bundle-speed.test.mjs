import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Speed limit per customer on Edit bundle (#263, canvas: AdminBundleEdit): the
// owner sets download and upload Mbps, the preview reads "up to N Mbps", saving
// stores them and a blank field clears a limit. While ROUTER_SPEED_LIMITS is off
// the form says the router does not apply them yet. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

async function start(t, speedLimits) {
  const secret = "redesign-bundle-speed", store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "sp-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "sp-owner", role: "owner", tokenHash: hashSecret("sp-owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.bundles.push({ id: "custom-family", name: "Connect Family", price: 10000, quotaGb: 20, validityHours: 168, deviceLimit: 3, custom: true, createdAt: "2026-11-01T00:00:00Z" });
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
    await page.goto(`${admin}/dashboard#bundle/custom-family`);
    await page.locator("#bundleEdit .admin-bundle-edit__speed").waitFor();
    return { context, page, errors };
  };
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };
  const save = async (page) => Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/admin/bundles/update") && r.request().method() === "POST"),
    page.locator("#bundleEdit").getByRole("button", { name: "Save bundle" }).click(),
  ]);

  // Off (the default until the RB5009 check): the form says so.
  const off = await start(t, false);
  const { context, page, errors } = await open(off);
  const form = page.locator("#bundleEdit"), detail = page.locator("#bundlePreview [data-preview-detail]");
  assert.equal(await text(form.locator(".admin-bundle-edit__speed legend")), "Speed limit per customer");
  assert.equal(await form.locator('[name="downloadMbps"]').getAttribute("placeholder"), "No limit");
  assert.equal(await text(form.locator(".admin-bundle-edit__speed-help")), "Shared by all of a customer's devices. Applied on the MikroTik as a queue for this bundle. Leave blank for no limit.");
  assert.match(await text(page.locator("#speedLimitsOff")), /^Not applied on the router yet/);
  // The rest of the form reads as the updated artboard.
  await form.getByLabel("Unlimited data (fair use applies)", { exact: true }).waitFor();
  await form.getByLabel("Data (GB)", { exact: true }).waitFor();
  assert.equal(await text(form.locator(".admin-callout")), "Changes apply to new purchases only. Customers with this bundle keep what they paid for.");

  // Keyboard: Tab goes from Data to Download to Upload, each with a visible ring.
  await form.getByLabel("Data (GB)", { exact: true }).focus();
  for (const name of ["downloadMbps", "uploadMbps"]) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.name), name);
    assert.equal(await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2 || cs.boxShadow !== "none"; }), true, `${name} focus ring`);
  }

  await form.locator('[name="downloadMbps"]').fill("10");
  await form.locator('[name="uploadMbps"]').fill("3");
  assert.equal(await text(detail), "20 GB · 7 days · 3 devices · up to 10 Mbps");
  // Unlimited reads as the artboard's preview; untick to keep 20 GB.
  await form.getByLabel("Unlimited data (fair use applies)", { exact: true }).check();
  assert.equal(await text(detail), "Unlimited · fair use · 7 days · 3 devices · up to 10 Mbps");
  await form.getByLabel("Unlimited data (fair use applies)", { exact: true }).uncheck();
  await form.getByLabel("Data (GB)", { exact: true }).fill("20");
  assert.equal(await text(detail), "20 GB · 7 days · 3 devices · up to 10 Mbps");
  await page.evaluate(() => document.activeElement.blur());
  await check(page, "bundle-edit-speed-1280");

  await save(page);
  await page.locator("#bundleEditMessage").filter({ hasText: "Saved — logged in the audit trail" }).waitFor();
  let saved = (await off.store.snapshot()).bundles.find((b) => b.id === "custom-family");
  assert.deepEqual([saved.downloadMbps, saved.uploadMbps, saved.quotaGb], [10, 3, 20]);
  // The saved values come back, and a blank field clears that limit.
  assert.equal(await page.locator('#bundleEdit [name="downloadMbps"]').inputValue(), "10");
  assert.equal(await page.locator('#bundleEdit [name="uploadMbps"]').inputValue(), "3");
  await page.locator('#bundleEdit [name="uploadMbps"]').fill("");
  await save(page);
  saved = (await off.store.snapshot()).bundles.find((b) => b.id === "custom-family");
  assert.deepEqual([saved.downloadMbps, saved.uploadMbps], [10, null]);
  assert.deepEqual(errors, []);
  await context.close();

  // Phone width: the fields stack without overflow.
  const phone = await open(off, 390);
  assert.equal(await phone.page.locator('#bundleEdit [name="downloadMbps"]').inputValue(), "10");
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
