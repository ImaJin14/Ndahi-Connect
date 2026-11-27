import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Your saved voucher (#367, canvas: PhoneVoucherReady; owner: exactly as drawn):
// the voucher's own terms, the code without NC-, "Not used yet · valid until …",
// "See what scanning opens", Copy code and Print slip, the note, and "Use it on
// this device now". No Download Voucher, Continue, links or install card.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const days = (n) => new Date(Date.now() + n * 864e5).toISOString();

test("the saved voucher page shows each voucher by its own terms, as drawn", { timeout: 180000 }, async (t) => {
  const secret = "redesign-voucher-ready", store = createStore({ persistent: false });
  await store.transaction((s) => {
    seedCatalogue(s, new Date()); s.catalogue.mode = "unlimited";
    const plan = s.bundles.find((b) => b.id === "unlimited-7d-2");
    for (const [id, phone] of [["c-new", "670001245"], ["c-old", "670002245"]]) {
      s.customers.push({ id, name: "Amina Nfor", phone, passkeys: [] });
      s.dashboardSessions.push({ id: `${id}-session`, customerId: id, tokenHash: hashSecret(id, secret), csrfToken: `${id}-csrf`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    const pay = (id, customerId, planId, snapshot) => s.payments.push({ id, customerId, status: "paid", amount: snapshot.price, currency: "XAF", provider: "mesomb", network: "mtn", payerPhone: "237670001245",
      planId, planSnapshot: snapshot, createdAt: days(-0.01), confirmedAt: days(-0.01) });
    pay("p-new", "c-new", plan.id, structuredClone(plan));
    s.vouchers.push({ id: "v-new", customerId: "c-new", paymentId: "p-new", planId: plan.id, code: "NC-QF83-ZK4M", status: "available", startsOnFirstConnection: true, startBy: "2027-02-10T10:00:00.000Z",
      quotaBytes: null, usedBytes: 0, deviceLimit: 2, accessType: "personal_unlimited", deviceSlots: 2, validityHours: 168, createdAt: days(-0.01) });
    const weekly = { id: "weekly", name: "Weekly", price: 1000, validityHours: 168, quotaGb: 5, deviceLimit: 1 };
    pay("p-old", "c-old", "weekly", weekly);
    s.vouchers.push({ id: "v-old", customerId: "c-old", paymentId: "p-old", planId: "weekly", code: "NC-WK5G-0001", status: "active", activatedAt: days(-1), expiresAt: "2026-12-04T10:00:00.000Z",
      quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1 });
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
  const open = async (customer, payment, { lang } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Africa/Douala" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: portal });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: customer, url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang) await context.addInitScript((value) => { try { localStorage.setItem("ndahi-lang", value); } catch {} }, lang);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${portal}/voucher-ready.html?payment=${payment}`);
    await page.locator("[data-voucher-code]").waitFor();
    return { context, page, errors };
  };

  // Personal Unlimited, not used yet.
  {
    const { context, page, errors } = await open("c-new", "p-new");
    const card = page.getByRole("region", { name: "Voucher" });
    assert.equal(await card.locator(".vready__eyebrow").textContent(), "Personal Unlimited · 7 days · 2 devices");
    assert.equal(await card.locator("[data-voucher-code]").textContent(), "QF83-ZK4M");
    assert.equal(await card.locator("[data-voucher-usage]").textContent(), "Not used yet · valid until 10 Feb 2027");
    await card.getByRole("img", { name: "QR code for voucher QF83-ZK4M" }).waitFor();
    assert.match(await card.getByRole("link", { name: "See what scanning opens →" }).getAttribute("href"), /^http/);
    assert.equal(await page.getByRole("link", { name: "Print slip" }).getAttribute("href"), "/voucher-print.html#ids=v-new&width=58");
    assert.equal(await text(page.locator("#voucherNote")), "Give the code or slip to anyone — it starts the bundle on the device where it's entered. Each code works once.");
    await page.getByRole("link", { name: "Use it on this device now" }).waitFor();
    for (const gone of ["Download Voucher", "Continue to Dashboard / Wi-Fi", "View all saved vouchers", "Install NDAHI Connect"]) assert.equal(await page.getByText(gone).count(), 0, gone);
    await page.getByRole("button", { name: "Copy code" }).click();
    await page.getByRole("button", { name: "Copied" }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "NC-QF83-ZK4M", "the full code is copied; either form works");
    assert.deepEqual(await lowContrastText(page), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // A fixed-data voucher already in use keeps its own terms.
  {
    const { context, page, errors } = await open("c-old", "p-old");
    assert.equal(await page.locator(".vready__eyebrow").textContent(), "Weekly · 5 GB · 7 days");
    assert.equal(await page.locator("[data-voucher-usage]").textContent(), "In use · ends 4 Dec 2026");
    assert.deepEqual(errors, []);
    await context.close();
  }
  // French.
  {
    const { context, page, errors } = await open("c-new", "p-new", { lang: "fr" });
    assert.equal(await page.locator("#voucherTitle").textContent(), "Votre ticket enregistré");
    assert.equal(await page.locator(".vready__eyebrow").textContent(), "Personal Unlimited · 7 jours · 2 appareils");
    assert.equal(await page.locator("[data-voucher-usage]").textContent(), "Pas encore utilisé · valable jusqu’au 10 févr. 2027");
    await page.getByRole("link", { name: "L’utiliser sur cet appareil" }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
});
