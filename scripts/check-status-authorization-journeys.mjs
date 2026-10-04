import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { MockPaymentAdapter } from "../lib/payments.mjs";

// Local-only fixtures. This script never reads .env or contacts a payment provider.
const apiPort = Number(process.env.STATUS_AUTH_API_PORT || 8298);
const portalPort = Number(process.env.STATUS_AUTH_PORT || 8297);
const api = `http://127.0.0.1:${apiPort}`;
const portal = `http://127.0.0.1:${portalPort}`;
const fixtureOrigins = new Set([api, portal].map((url) => new URL(url).origin));
const store = createStore({ persistent: false });
const paymentAdapter = new MockPaymentAdapter();
const server = createServer({
  store,
  payments: { mock: paymentAdapter },
  env: {
    NODE_ENV: "test",
    PAYMENT_MODE: "mock",
    EMAIL_MODE: "mock",
    MIKROTIK_MODE: "mock",
    OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false",
    SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal,
  },
});
const website = createStaticServer("customer", { apiUrl: api });
const listen = (app, port) => new Promise((resolve, reject) => {
  app.once("error", reject);
  app.listen(port, "127.0.0.1", resolve);
});
const close = (app) => new Promise((resolve) => {
  app.close(resolve);
  app.closeAllConnections();
});
const call = async (path, { method = "GET", body, cookie = "", headers = {} } = {}) => {
  const response = await fetch(api + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { /* no JSON body */ }
  return { response, json, text };
};
const assertDenied = async (path, options) => {
  const denied = await call(path, options);
  assert.equal(denied.response.status, 404);
  assert.deepEqual(denied.json, { error: "Payment not found." });
  assert.equal("requestKey" in (denied.json || {}), false);
  assert.equal("access" in (denied.json || {}), false);
  assert.equal("payment" in (denied.json || {}), false);
};
const purchase = async (phone, requestKey) => {
  const result = await call("/api/purchase", {
    method: "POST",
    body: {
      phone, requestKey, name: `Status ${phone}`, email: `${phone}@example.test`,
      planId: "weekly", network: "mtn",
    },
  });
  assert.equal(result.response.status, 201, result.text);
  return result.json.payment;
};
const cookieFrom = (response) => {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "expected customer session cookie");
  return value.split(";")[0];
};
const createOwner = async (phone, requestKey) => {
  const payment = await purchase(phone, requestKey);
  const confirmed = await call(`/api/payments/${payment.id}/confirm`, { method: "POST" });
  assert.equal(confirmed.response.status, 200, confirmed.text);
  const setup = await call("/api/account/setup/pin", {
    method: "POST",
    body: { phone, code: confirmed.json.access.code, pin: "2468", confirmPin: "2468" },
  });
  assert.equal(setup.response.status, 200, setup.text);
  return { payment, cookie: cookieFrom(setup.response) };
};

let browser;
let pageContext;
try {
  await listen(server, apiPort);
  await listen(website, portalPort);

  // TEST-001: an ID alone, a wrong key, and a different payment's valid key
  // cannot expose a payment, voucher, or private key.
  const guest = await purchase("670090001", "guest-status-key");
  const otherGuest = await purchase("670090005", "another-checkout-key");
  const statusPath = `/api/payments/${guest.id}/status`;
  await assertDenied(statusPath);
  await assertDenied(statusPath, { headers: { "x-checkout-key": "wrong-key" } });
  await assertDenied(statusPath, { headers: { "x-checkout-key": otherGuest.requestKey } });

  const confirmedGuest = await call(`/api/payments/${guest.id}/confirm`, { method: "POST" });
  assert.equal(confirmedGuest.response.status, 200, confirmedGuest.text);
  const allowedGuest = await call(statusPath, {
    headers: { "x-checkout-key": "guest-status-key" },
  });
  assert.equal(allowedGuest.response.status, 200);
  assert.equal(allowedGuest.json.payment.id, guest.id);
  assert.equal(allowedGuest.json.payment.status, "paid");
  assert.match(allowedGuest.json.access.code, /^NC-/);
  assert.equal(allowedGuest.json.payment.requestKey, "guest-status-key", "only the authorized guest can read its saved checkout");

  // Ownership is session-bound, including legacy payments without a key.
  const owner = await createOwner("670090002", "owner-status-key");
  const ownerPaymentPath = `/api/payments/${owner.payment.id}/status`;
  await store.transaction((state) => {
    delete state.payments.find((item) => item.id === owner.payment.id).requestKey;
  });
  await assertDenied(ownerPaymentPath);
  const ownerStatus = await call(ownerPaymentPath, { cookie: owner.cookie });
  assert.equal(ownerStatus.response.status, 200);
  assert.equal(ownerStatus.json.payment.id, owner.payment.id);
  assert.match(ownerStatus.json.access.code, /^NC-/);

  const foreign = await createOwner("670090003", "foreign-status-key");
  await assertDenied(ownerPaymentPath, { cookie: foreign.cookie });
  await store.transaction((state) => {
    const session = state.dashboardSessions.find((item) => item.customerId === state.customers.find((customer) => customer.phone === "670090002")?.id);
    assert.ok(session);
    session.expiresAt = new Date(Date.now() - 1_000).toISOString();
  });
  await assertDenied(ownerPaymentPath, { cookie: owner.cookie });

  // Browser journey: resume a real paid guest checkout, complete PIN setup, and
  // keep the entire flow usable at a narrow mobile width.
  const browserGuest = await purchase("670090004", "browser-paid-guest-key");
  const browserPaid = await call(`/api/payments/${browserGuest.id}/confirm`, { method: "POST" });
  assert.equal(browserPaid.response.status, 200, browserPaid.text);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
  });
  pageContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await pageContext.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["http:", "https:"].includes(url.protocol) && !fixtureOrigins.has(url.origin)
      ? route.abort("blockedbyclient") : route.continue();
  });
  const page = await pageContext.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${portal}/onboarding.html`);
  await page.evaluate((saved) => {
    localStorage.setItem("ndahi-interrupted-checkout", JSON.stringify(saved));
  }, {
    input: {
      phone: "670090004", name: "Browser Paid Guest", email: "browser@example.test",
      network: "mtn", planId: "weekly", requestKey: "browser-paid-guest-key",
    },
    paymentId: browserGuest.id,
  });
  await page.reload();
  const statusRequest = page.waitForRequest((request) =>
    request.url().endsWith(`/payments/${browserGuest.id}/status`));
  await page.getByRole("button", { name: "Resume saved payment" }).click();
  const request = await statusRequest;
  assert.equal(request.headers()["x-checkout-key"], "browser-paid-guest-key");
  await page.waitForURL("**/verify.html?setup=pin");
  assert.equal(await page.locator("#title").textContent(), "Create your PIN.");
  await page.getByLabel("Create PIN", { exact: true }).fill("2468");
  await page.getByLabel("Confirm PIN", { exact: true }).fill("2468");
  await page.getByRole("button", { name: "Create PIN and continue" }).click();
  await page.waitForURL("**/dashboard");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => localStorage.getItem("ndahi-interrupted-checkout")), null);
  assert.deepEqual(errors, []);
  console.log("PASS TEST-001 status authorization and guest browser journey");
} finally {
  await pageContext?.close();
  await browser?.close();
  await close(website);
  await close(server);
}
