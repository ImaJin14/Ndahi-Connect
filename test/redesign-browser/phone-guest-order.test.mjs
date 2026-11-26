import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// A guest's order (canvas: PhoneGuestOrder = PhoneOrder with guest, #401; owner
// 26 Nov), opened from its short private link store…/o/<token>: the bar, the
// item with how it was paid and its status, the code shown "739 204", each step
// with when it happened and "Held for you until", "Keep this private link" with
// the short link and Copy, and Receipt with Save to an account at the foot. No
// Local pickup or Store policies sections. The long #order/<id>/<token> link
// still opens it. Local servers only, synthetic data, Douala time.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };
const text = (locator) => locator.evaluate((el) => el.innerText.replace(/\s+/g, " ").trim());

test("a guest's order opens from its short link, drawn with its steps, link and actions", { timeout: 150000 }, async (t) => {
  const secret = "redesign-phone-guest-order", store = createStore({ persistent: false });
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", hours: "Mon–Sat 8:00–18:00", contact: "670000000", warranty: words, returns: words };
    s.storeProducts.push({ id: "cpe210", version: 1, stock: 3, sku: "cpe210", name: { en: "TP-Link CPE210", fr: "TP-Link CPE210" }, description: words, specifications: words,
      compatibility: words, contents: words, warranty: words, setup: words, images: [], price: 38000, cost: 1, status: "published", featured: false, categoryId: "" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`, portal = "http://127.0.0.1:9";
  const storeServer = await listen(createStaticServer("store", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const shop = `http://127.0.0.1:${storeServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    STORE_APP_URL: shop, CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(storeServer); });
  const screenshots = process.env.PHONE_GUEST_ORDER_SCREENSHOTS || "/tmp/ndahi-phone-guest-order";
  await mkdir(screenshots, { recursive: true });

  // A guest buys with Orange Money; it is paid on 8 Nov at 10:14 and made ready on 9 Nov at 16:02 (Douala).
  const bought = await (await fetch(`${api}/api/store/checkout`, { method: "POST", headers: { "content-type": "application/json", origin: shop },
    body: JSON.stringify({ checkoutKey: randomUUID(), productId: "cpe210", quantity: 1, expectedPrice: 38000, name: "Paul T.", phone: "670008802", payerPhone: "670008802", network: "orange" }) })).json();
  const token = bought.token;
  await store.transaction((s) => {
    const o = s.storeOrders.find((x) => x.id === bought.order.id);
    Object.assign(o.payment, { status: "paid", confirmedAt: "2026-11-08T09:14:00.000Z", creationState: "created" });
    Object.assign(o, { status: "ready", stockState: "committed", collectionCode: "739204" });
    o.history.push({ action: "ready", actor: "owner", at: "2026-11-09T15:02:00.000Z" });
  });
  const open = async (url, width = 390, height = 844) => {
    const context = await browser.newContext({ viewport: { width, height }, timezoneId: "Africa/Douala" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: shop });
    await context.route("**/*", (route) => [api, shop].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator(".order-page .progress").waitFor();
    return { context, page, errors };
  };
  const { context, page, errors } = await open(`${shop}/o/${token}`);
  const { reference, id } = (await store.snapshot()).storeOrders[0];

  // The bar: back to the shop, the order's reference.
  assert.equal(await page.locator(".bar-title").innerText(), `Order ${reference}`);
  assert.equal(await page.locator(".order-page .bar-back").getAttribute("href"), "#shop");
  assert.equal(await page.locator(".order-page .bar-back").getAttribute("aria-label"), "Back");
  // The item, how it was paid, and the status.
  assert.equal(await text(page.locator(".order-line > div:not(.product-visual)")), "TP-Link CPE210 × 1 38,000 FCFA · Orange Money");
  assert.equal(await text(page.locator(".order-line .order-status")), "Ready to collect");
  // The code in two groups of three.
  assert.equal(await page.locator(".code-card__code").innerText(), "739 204");
  assert.equal(await text(page.locator(".code-card p:last-child")), "Show this at Bandja Street. Staff check it before handing over.");
  // Each step with when it happened; the current one held until 14 days after it was ready.
  assert.deepEqual(await page.locator(".order-page .progress li").evaluateAll((items) => items.map((li) => li.innerText.replace(/\s+/g, " ").trim())),
    ["Paid 8 Nov, 10:14", "Prepared and tested 9 Nov, 16:02", "Ready to collect Held for you until 23 Nov", "Collected"]);
  assert.equal(await page.locator('.order-page .progress li[aria-current="step"]').innerText().then((s) => s.split("\n")[0]), "Ready to collect");
  // The short private link, shown without the scheme, copied whole.
  const short = `${shop}/o/${token}`;
  assert.equal(await text(page.locator("#keepTitle")), "Keep this private link");
  assert.equal(await page.locator("#privateLink").inputValue(), short.replace(/^https?:\/\//, ""));
  assert.equal(await page.locator("#privateLink").getAttribute("aria-label"), "Private tracking link");
  await page.locator("#copyLink").click();
  await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), short);
  // Receipt and Save to an account at the foot; no pickup or policies sections.
  assert.deepEqual(await page.locator(".order-actions > *").evaluateAll((nodes) => nodes.map((n) => n.innerText)), ["Receipt", "Save to an account"]);
  assert.equal(await page.locator("#signToClaim").getAttribute("href"), `${portal}/login`);
  const actions = await page.locator(".order-actions").evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
  assert.equal(actions, 844 - 16, "the actions sit at the foot");
  assert.equal(await page.getByText("Local pickup").count(), 0);
  assert.equal(await page.getByText("Store policies").count(), 0);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${screenshots}/order.png` });
  // The receipt downloads.
  const download = page.waitForEvent("download");
  await page.locator("#downloadStoreReceipt").click();
  assert.match((await download).suggestedFilename(), /^ndahi-store-receipt-/);
  assert.deepEqual(errors, []);
  await context.close();

  // The long link still opens the same order.
  const long = await open(`${shop}/#order/${encodeURIComponent(id)}/${encodeURIComponent(token)}`);
  assert.equal(await long.page.locator(".bar-title").innerText(), `Order ${reference}`);
  assert.equal(await long.page.locator("#privateLink").inputValue(), short.replace(/^https?:\/\//, ""));
  assert.deepEqual(long.errors, []);
  await long.context.close();

  // Desktop: the same order, centred.
  const desk = await open(`${shop}/o/${token}`, 1280, 900);
  assert.equal(await desk.page.locator(".order-actions > *").count(), 2);
  assert.deepEqual(await lowContrastText(desk.page), []);
  await desk.page.screenshot({ path: `${screenshots}/order-desktop.png` });
  assert.deepEqual(desk.errors, []);
  await desk.context.close();
});
