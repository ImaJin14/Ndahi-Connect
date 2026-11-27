import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The receipt (#369, canvas: PhoneReceipt, 24 Nov): Payment and Wi-Fi tiles,
// the short receipt number, the total debited as the provider confirmed it (or
// "Total paid" with the quoted amounts), the rows from the receipt's snapshot,
// and the provider reference or the NDAHI payment ID with Copy. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const mins = (n) => new Date(Date.now() + n * 60000).toISOString();

test("a customer reads each kind of receipt as drawn", { timeout: 240000 }, async (t) => {
  const secret = "redesign-phone-receipt", store = createStore({ persistent: false });
  await store.transaction((s) => {
    seedCatalogue(s, new Date()); s.catalogue.mode = "unlimited";
    const plan = structuredClone(s.bundles.find((b) => b.id === "unlimited-7d-2"));
    const customer = (id) => {
      s.customers.push({ id, name: "Amina Nfor", phone: "670001245", email: `${id}@example.test`, passkeys: [] });
      s.dashboardSessions.push({ id: `${id}-session`, customerId: id, tokenHash: hashSecret(id, secret), csrfToken: `${id}-csrf`, expiresAt: "2099-01-01T00:00:00.000Z" });
    };
    const pay = (id, customerId, extra) => s.payments.push({ id, customerId, status: "paid", amount: 4000, fee: 80, total: 4080, currency: "XAF", provider: "mesomb", network: "mtn",
      payerPhone: "237670001245", planId: plan.id, planSnapshot: plan, accessMode: "direct", createdAt: mins(-4), confirmedAt: mins(-3), ...extra });
    const bundle = (id, customerId, paymentId, extra) => s.vouchers.push({ id, customerId, paymentId, planId: plan.id, code: `NC-${id.toUpperCase().slice(0, 4)}-0001`, deviceLimit: 2, quotaBytes: null, usedBytes: 0,
      accessType: "personal_unlimited", deviceSlots: 2, ...extra });
    // Confirmed by MTN, Wi-Fi active.
    customer("c-active"); pay("p-active", "c-active", { providerFee: 80, providerTotal: 4080, providerReference: "MP241124.1432.A7731" });
    bundle("v-active", "c-active", "p-active", { status: "active", activatedAt: mins(-2), expiresAt: mins(7 * 1440) });
    // Paid, no bundle yet: activating; the fee only quoted; no provider reference.
    customer("c-activating"); pay("p-activating", "c-activating", {});
    // Paid, saved until first connection.
    customer("c-waiting"); pay("p-waiting", "c-waiting", { providerFee: 80, providerTotal: 4080, providerReference: "MP241124.0900.B1234" });
    bundle("v-waiting", "c-waiting", "p-waiting", { status: "available" });
    // A fixed-data bundle bought before the switch keeps its terms.
    customer("c-legacy"); pay("p-legacy", "c-legacy", { amount: 1000, fee: 20, total: 1020, providerReference: "MP-LEGACY", planId: "weekly",
      planSnapshot: { id: "weekly", name: "Weekly", price: 1000, validityHours: 168, quotaGb: 5, deviceLimit: 1 } });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal,
    PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = "/tmp/ndahi-phone-receipt";
  await mkdir(screenshots, { recursive: true });
  const open = async (customerId, { lang } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Africa/Douala", locale: lang === "fr" ? "fr-FR" : "en-US" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: portal });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: customerId, url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => { try { localStorage.setItem("ndahi-lang", "fr"); } catch {} });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/dashboard#activity`);
    await page.locator("details[data-payment-row] > summary").first().click();
    await page.locator("[data-view-receipt]").first().click();
    await page.locator("#receiptPreview [data-receipt-ref]").waitFor();
    return { context, page, errors };
  };
  const rows = (page) => page.locator(".portal-receipt__details > div").evaluateAll((items) => items.map((row) => row.innerText.replace(/\s+/g, " ").trim()));
  const check = async (page, label) => {
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png` });
  };

  // Confirmed by MTN, Wi-Fi active: the drawn receipt.
  {
    const { context, page, errors } = await open("c-active");
    assert.equal(await page.locator("#receiptTitle").textContent(), "Payment receipt");
    assert.equal(await page.locator("#receiptClose").getAttribute("aria-label"), "Back to activity");
    assert.match(await text(page.locator("[data-receipt-payment]")), /^✓ Payment Confirmed · \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
    assert.match(await text(page.locator("[data-receipt-wifi]")), /^✓ Wi-Fi Active since \d{2}:\d{2}$/);
    assert.match(await text(page.locator(".portal-receipt__meta")), /^Receipt NC-\d{4}-0001$/);
    assert.equal(await text(page.locator(".portal-receipt__debited")), "Total debited (confirmed by MTN)");
    assert.equal(await text(page.locator(".portal-receipt__amount")), "4,080 XAF");
    assert.deepEqual(await rows(page), ["Bundle Personal Unlimited · 7 days · 2 devices", "Bundle Price 4,000 XAF", "Mobile Payment Fee 80 XAF", "Total debited 4,080 XAF",
      "Validity 7 days, from first connection", "Paid with MTN MoMo · 6•• •• 12 45", "Provider reference MP241124.1432.A7731 Copy"]);
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "MP241124.1432.A7731", "Copy puts the exact reference on the clipboard");
    await check(page, "active");
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Still activating, the fee only quoted, no provider reference: "Total paid" and the NDAHI payment ID.
  {
    const { context, page, errors } = await open("c-activating");
    assert.equal(await text(page.locator("[data-receipt-wifi]")), "… Wi-Fi Activating…", "never claims Wi-Fi is active");
    assert.equal(await text(page.locator(".portal-receipt__debited")), "Total paid");
    assert.match(await text(page.locator(".portal-receipt__meta")), /^Receipt NC-\d{4}-0002$/, "the next number in the month");
    const all = await rows(page);
    assert.equal(all[3], "Total paid 4,080 XAF");
    assert.match(all.at(-1), /^NDAHI payment ID NC-PAY-\d{4}-0002 Copy$/);
    await check(page, "activating");
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Saved until first connection.
  {
    const { context, page, errors } = await open("c-waiting");
    assert.equal(await text(page.locator("[data-receipt-wifi]")), "○ Wi-Fi Starts at first connection");
    assert.deepEqual(errors, []);
    await context.close();
  }
  // A fixed-data bundle keeps its own terms.
  {
    const { context, page, errors } = await open("c-legacy");
    const all = await rows(page);
    assert.equal(all[0], "Bundle Weekly · 5 GB · 1 device");
    assert.equal(all.find((row) => row.startsWith("Validity")), "Validity 7 days");
    assert.deepEqual(errors, []);
    await context.close();
  }
  // French.
  {
    const { context, page, errors } = await open("c-active", { lang: "fr" });
    assert.equal(await page.locator("#receiptTitle").textContent(), "Reçu de paiement");
    assert.equal(await text(page.locator(".portal-receipt__debited")), "Total débité (confirmé par MTN)");
    assert.equal(await text(page.locator(".portal-receipt__amount")), "4 080 XAF");
    assert.deepEqual((await rows(page)).slice(0, 2), ["Forfait Personal Unlimited · 7 jours · 2 appareils", "Prix du forfait 4 000 XAF"]);
    await check(page, "fr");
    assert.deepEqual(errors, []);
    await context.close();
  }
});
