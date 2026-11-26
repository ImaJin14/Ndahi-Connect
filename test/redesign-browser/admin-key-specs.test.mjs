import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { publishInitialStoreCatalogue } from "../../lib/initial-store-catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Key specs (ProductDesktop, #415; owner 26 Nov): Edit product's "More product
// details" gains short label/value rows, in the language chosen with EN/FR, up
// to 12; they fill the public store's spec table on desktop. Local servers
// only, the owner-approved catalogue, every non-local request aborted.

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("the owner adds, translates and removes key specs in Edit product", { timeout: 200000 }, async (t) => {
  const secret = "redesign-admin-key-specs", store = createStore({ persistent: false });
  await publishInitialStoreCatalogue({ store, now: () => new Date("2026-11-08T08:00:00Z") });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "u-owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const cpe = (await store.snapshot()).storeProducts.find((p) => p.sku === "ND-TPLINK-CPE210");
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
  const open = async (width = 1280) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1110 } });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`${admin}/dashboard#product/${cpe.id}`);
    await page.locator("#storeProductForm").waitFor();
    await page.locator("#productMoreDetails > summary").click();
    return { page, context, errors };
  };
  const saved = async () => (await store.snapshot()).storeProducts.find((p) => p.id === cpe.id).keySpecs;

  const { page, context, errors } = await open();
  const editor = page.locator("#productKeySpecs");
  assert.equal(await editor.locator("legend").innerText(), "Key specs");
  assert.equal(await editor.locator("[data-key-spec]").count(), 0);
  // Two rows in English, then the first one's French label.
  for (const [label, value] of [["Band", "2.4 GHz"], ["Power", "Passive PoE"]]) {
    await editor.getByRole("button", { name: "Add a key spec" }).click();
    const row = editor.locator("[data-key-spec]").last();
    assert.equal(await row.getByLabel("Label (English)").evaluate((el) => el === document.activeElement), true, "the new row's label takes focus");
    await row.getByLabel("Label (English)").fill(label);
    await row.getByLabel("Value (English)").fill(value);
  }
  await page.locator('[data-product-lang="fr"]').click();
  assert.equal(await editor.getByLabel("Label (English)").first().isVisible(), false);
  await editor.locator("[data-key-spec]").first().getByLabel("Label (Français)").fill("Bande");
  await page.locator('[data-product-lang="en"]').click();
  // A third row, then removed: Remove names its row.
  await editor.getByRole("button", { name: "Add a key spec" }).click();
  await editor.getByRole("button", { name: "Remove key spec 3" }).click();
  assert.equal(await editor.locator("[data-key-spec]").count(), 2);
  await page.locator("#storeHeadProduct button").click();
  await page.locator("#storeSaved:not(:empty)").waitFor();
  const row = (en, value, fr = "") => ({ label: { en, fr }, value: { en: value, fr: "" } });
  assert.deepEqual(await saved(), [row("Band", "2.4 GHz", "Bande"), row("Power", "Passive PoE")]);
  // Reopened, the rows are there; removing one and saving removes it.
  await page.reload();
  await page.locator("#productMoreDetails > summary").click();
  assert.deepEqual(await editor.locator('[data-spec-label="en"]').evaluateAll((els) => els.map((el) => el.value)), ["Band", "Power"]);
  await editor.getByRole("button", { name: "Remove key spec 2" }).click();
  await page.locator("#storeHeadProduct button").click();
  for (let i = 0; i < 50 && (await saved()).length !== 1; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await saved(), [row("Band", "2.4 GHz", "Bande")]);
  assert.deepEqual(await lowContrastText(page), []);
  assert.deepEqual(errors, []);
  await context.close();

  // Phones: each row's fields stack; nothing runs off the screen.
  const phone = await open(390);
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.context.close();
});
