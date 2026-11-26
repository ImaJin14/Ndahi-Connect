import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";
import { storeState } from "../../lib/device-store.mjs";

// Order tracking on phones (canvas: PhoneOrder, #406): the item with how it
// was paid, the 6-digit code shown "739 204", the steps with when each
// happened, "Held for you until <date>" from the owner's hold period (owner, 26
// Nov), and Receipt and Get help at the foot. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const at = (iso) => new Date(iso).toISOString();
const order = (id, status, history, extra = {}) => ({ id, reference: `NS-${id}`, version: 3, customerId: "amina", productId: "cpe210", product: { name: { en: "TP-Link CPE210", fr: "TP-Link CPE210" } },
  quantity: 1, unitPrice: 38000, status, stockState: "consumed", createdAt: at("2026-11-08T10:12:00+01:00"), expiresAt: at("2026-11-08T10:22:00+01:00"), contact: { name: "Amina", phone: "670001245" }, history,
  payment: { id: `store-${id}`, provider: "mesomb", amount: 38000, fee: 760, total: 38760, currency: "XAF", network: "orange", payerPhone: "670001245", status: "paid", creationState: "created",
    createdAt: at("2026-11-08T10:12:00+01:00"), confirmedAt: at("2026-11-08T10:14:00+01:00"), providerReference: `MP-${id}` },
  pickup: "Bandja Street", returns: { en: "", fr: "" }, hours: "", collectionCode: "739204", ...extra });

test("order tracking shows the code, the timed steps and the hold date", { timeout: 180000 }, async (t) => {
  const secret = "redesign-phone-order", store = createStore({ persistent: false });
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "670000000", readyHoldDays: 14 };
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.storeOrders.push(
      order("ready", "ready", [{ action: "ready", actor: "owner", at: at("2026-11-09T16:02:00+01:00") }]),
      order("preparing", "preparing", []),
      order("collected", "collected", [{ action: "ready", actor: "owner", at: at("2026-11-09T16:02:00+01:00") }, { action: "collect", actor: "owner", at: at("2026-11-10T09:30:00+01:00") }], { collectionCode: "A1B2C3D4E5" }));
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = process.env.PHONE_ORDER_SCREENSHOTS || "/tmp/ndahi-phone-order";
  await mkdir(screenshots, { recursive: true });
  const open = async (id, lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: lang === "fr" ? "fr-FR" : "en-GB" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/dashboard#order/${id}`);
    await page.locator(".portal-shop__steps").waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  };
  const steps = (page) => page.locator(".portal-shop__steps li").evaluateAll((items) => items.map((li) => [li.querySelector("strong").innerText, li.querySelector(".nd-meta")?.innerText || "", li.className]));

  let { context, page, errors } = await open("ready");
  assert.equal(await page.locator(".portal-shop__line--order .nd-meta").innerText(), "38,000 FCFA · Orange Money");
  assert.equal(await page.locator(".portal-shop__code-value").innerText(), "739 204");
  assert.deepEqual(await steps(page), [["Paid", "8 Nov, 10:14", "is-done"], ["Prepared and tested", "9 Nov, 16:02", "is-done"], ["Ready to collect", "Held for you until 23 Nov", "is-current"], ["Collected", "", ""]]);
  assert.equal(await page.locator('.portal-shop__steps [aria-current="step"] strong').innerText(), "Ready to collect");
  assert.equal(await page.getByRole("link", { name: "Get help", exact: true }).count(), 1);
  // Receipt and Get help at the foot of the screen.
  const foot = await page.locator(".portal-shop__actions").evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
  assert.equal(foot, 828);
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
  await page.screenshot({ path: `${screenshots}/order-ready-390.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  // Being prepared: paid done, prepared current, no hold date.
  ({ context, page, errors } = await open("preparing"));
  assert.deepEqual((await steps(page)).map(([name, line, state]) => [name, line, state]), [["Paid", "8 Nov, 10:14", "is-done"], ["Prepared and tested", "", "is-current"], ["Ready to collect", "", ""], ["Collected", "", ""]]);
  assert.deepEqual(errors, []);
  await context.close();

  // Collected, with an older 10-character code shown as it is.
  ({ context, page, errors } = await open("collected"));
  assert.equal(await page.locator(".portal-shop__code-value").innerText(), "A1B2C3D4E5");
  assert.deepEqual((await steps(page)).at(-1), ["Collected", "10 Nov, 09:30", "is-done"]);
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  ({ context, page, errors } = await open("ready", "fr"));
  assert.deepEqual((await steps(page))[2].slice(0, 2), ["Prête à retirer", "Gardée pour vous jusqu'au 23 nov."]);
  assert.equal(await page.getByRole("link", { name: "Obtenir de l'aide", exact: true }).count(), 1);
  await page.screenshot({ path: `${screenshots}/order-ready-390-fr.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});
