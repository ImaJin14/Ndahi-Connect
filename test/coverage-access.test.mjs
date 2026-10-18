import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { coverageConfigErrors, createCoverageGuard } from "../lib/coverage-access.mjs";
import { MockPaymentAdapter } from "../lib/payments.mjs";

const inside = "203.0.113.10", outside = "198.51.100.7", origin = "http://customer.test";
const coverage = { TRUST_PROXY: "render", COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: inside };
const purchaseInput = { phone: "670040001", planId: "weekly", requestKey: "coverage-checkout" };
async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const from = (address, headers = {}) => ({ headers: { "cf-connecting-ip": address, ...headers } });
async function fixture(t, env = {}, store = createStore({ persistent: false })) {
  const adapter = new MockPaymentAdapter();
  let providerCalls = 0;
  const create = adapter.createPayment.bind(adapter);
  adapter.createPayment = (...args) => { providerCalls++; return create(...args); };
  const base = await listen(t, createServer({ store, payments: { mock: adapter }, validateConfig: false, env: {
    ...coverage, NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: origin, ADMIN_PIN: "9999", ADMIN_SESSION_SECRET: "admin-secret",
    ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test",
    BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", ...env,
  } }));
  const post = async (path, input = {}, address = outside, headers = {}) => {
    const response = await fetch(base + path, { method: "POST", headers: {
      ...from(address).headers, origin, "content-type": "application/json", ...headers,
    }, body: JSON.stringify(input) });
    return { response, body: await response.json() };
  };
  return { base, store, post, providerCalls: () => providerCalls };
}

test("invalid coverage settings fail closed for API purchases; the portal ignores legacy settings", () => {
  assert.deepEqual(coverageConfigErrors({}), []);
  assert.deepEqual(coverageConfigErrors({ COVERAGE_ACCESS_ENABLED: "false" }), []);
  assert.deepEqual(coverageConfigErrors(coverage), []);
  assert.deepEqual(coverageConfigErrors({ ...coverage, COVERAGE_ALLOWED_IPS: `${inside}, 203.0.113.11` }), []);
  for (const env of [
    { ...coverage, COVERAGE_ACCESS_ENABLED: "yes" }, { ...coverage, TRUST_PROXY: "" },
    { ...coverage, COVERAGE_ALLOWED_IPS: "" }, { ...coverage, COVERAGE_ALLOWED_IPS: "203.0.113.0/24" },
    { ...coverage, COVERAGE_ALLOWED_IPS: "2001:db8::1" },
  ]) assert.throws(() => createCoverageGuard(env), /COVERAGE_|TRUST_PROXY/);
  assert.doesNotThrow(() => createStaticServer("customer", { apiUrl: "https://api.test", env: { ...coverage, TRUST_PROXY: "" } }));
  assert.throws(() => createServer({ store: createStore({ persistent: false }), env: { ...coverage, COVERAGE_ALLOWED_IPS: "" } }), /COVERAGE_ALLOWED_IPS/);
});

test("portal pages, assets and installed app remain accessible from any network", async (t) => {
  const base = await listen(t, createStaticServer("customer", { apiUrl: "https://api.test", env: coverage }));
  for (const address of [inside, outside, "2001:db8::7", ""]) {
    for (const path of ["/healthz", "/login", "/dashboard", "/onboarding.html", "/config.js", "/manifest.webmanifest", "/sw.js"]) {
      assert.equal((await fetch(base + path, from(address))).status, 200, `${address} ${path}`);
    }
  }
  const page = await fetch(base + "/login", from(outside));
  const script = (await page.text()).match(/src="(\/static\/login\.[0-9a-f]+\.js)"/)[1];
  const asset = await fetch(base + script, from(outside));
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const admin = await listen(t, createStaticServer("admin", { apiUrl: "https://api.test", env: coverage }));
  assert.equal((await fetch(admin + "/login", from(outside))).status, 200);
});

test("public catalogue reports uncached purchase access while accounts still require authentication", async (t) => {
  const { base } = await fixture(t);
  for (const [address, allowed] of [[inside, true], [outside, false], ["2001:db8::7", false], ["", false]]) {
    const response = await fetch(base + "/api/plans", from(address));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const catalogue = await response.json();
    assert.ok(catalogue.plans.length);
    assert.equal(catalogue.purchaseAccess.allowed, allowed);
    const access = await fetch(base + "/api/purchase/access", from(address));
    assert.equal(access.headers.get("cache-control"), "no-store");
    assert.deepEqual(await access.json(), catalogue.purchaseAccess);
  }
  for (const path of ["/api/status", "/api/health"]) assert.equal((await fetch(base + path, from(outside))).status, 200);
  for (const path of ["/api/account/dashboard", "/api/account/security"]) assert.equal((await fetch(base + path, from(outside))).status, 401);
});

test("off-network purchases, renewals and switches are refused before reservation or provider I/O", async (t) => {
  const f = await fixture(t), before = await f.store.snapshot();
  for (const address of [outside, "2001:db8::7", ""]) {
    for (const [path, input] of [
      ["/api/purchase", purchaseInput], ["/api/purchase", { ...purchaseInput, upgrade: true }],
      ["/api/account/plan/purchase", { planId: "weekly", action: "renew" }],
      ["/api/account/plan/purchase", { planId: "monthly", action: "switch" }],
    ]) {
      const refused = await f.post(path, input, address, { "x-forwarded-for": inside, "x-real-ip": inside });
      assert.equal(refused.response.status, 403, `${address} ${path}`);
      assert.equal(refused.body.code, "OUTSIDE_COVERAGE");
      assert.match(refused.body.error, /Connect to NDAHI Wi-Fi to purchase a bundle/);
      assert.equal(refused.response.headers.get("access-control-allow-origin"), origin);
    }
  }
  assert.equal(f.providerCalls(), 0);
  const after = await f.store.snapshot();
  for (const key of ["customers", "payments", "vouchers", "routerCommands"]) assert.deepEqual(after[key], before[key], key);
  const preflight = await fetch(f.base + "/api/purchase", { method: "OPTIONS", headers: { ...from(outside).headers, origin, "access-control-request-method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
});

test("a checkout started on Wi-Fi can recover, complete, sign in and show balances and receipts off-network", async (t) => {
  const f = await fixture(t);
  const created = await f.post("/api/purchase", purchaseInput, inside);
  assert.equal(created.response.status, 201);
  const id = created.body.payment.id;
  const recovery = await f.post("/api/purchase/recover", purchaseInput);
  assert.equal(recovery.response.status, 200);
  assert.equal(recovery.body.payment.id, id);
  assert.equal(f.providerCalls(), 1);
  assert.equal((await fetch(`${f.base}/api/payments/${id}/status`, from(outside))).status, 404, "payment IDs alone do not grant access");
  const paid = await f.post(`/api/payments/${id}/confirm`);
  assert.equal(paid.response.status, 200);
  const status = await fetch(`${f.base}/api/payments/${id}/status`, from(outside, { "x-checkout-key": purchaseInput.requestKey }));
  assert.equal(status.status, 200);
  assert.equal((await status.json()).payment.status, "paid");
  const setup = await f.post("/api/account/setup/pin", { phone: purchaseInput.phone, code: paid.body.access.code, pin: "2468", confirmPin: "2468" });
  assert.equal(setup.response.status, 200);
  const login = await f.post("/api/account/login/pin", { phone: purchaseInput.phone, pin: "2468" });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  const dashboard = await fetch(f.base + "/api/account/dashboard", from(outside, { cookie }));
  assert.equal(dashboard.status, 200);
  const account = await dashboard.json();
  assert.equal(account.activeBundle.planId, "weekly");
  assert.ok(account.activeBundle.remainingBytes > 0);
  assert.equal(account.purchaseAccess.allowed, false);
  assert.equal(account.payments.length, 1);
  assert.equal((await fetch(`${f.base}/api/account/payments/${id}/receipt?format=json`, from(outside, { cookie }))).status, 200);
  assert.equal((await fetch(`${f.base}/api/account/payments/${id}/receipt`, from(outside))).status, 401);
  for (const [action, planId] of [["renew", "weekly"], ["switch", "monthly"]]) {
    const input = { action, planId, acknowledge: true, requestKey: `coverage-${action}` };
    assert.equal((await f.post("/api/account/plan/purchase", input, outside, { cookie })).response.status, 403);
    const purchase = await f.post("/api/account/plan/purchase", input, inside, { cookie });
    assert.equal(purchase.response.status, 201, JSON.stringify(purchase.body));
    assert.equal((await f.post(`/api/payments/${purchase.body.payment.id}/confirm`)).response.status, 200);
  }
});

test("normal origin and CSRF security checks still apply to off-network account writes", async (t) => {
  const seed = await fixture(t);
  const created = await seed.post("/api/purchase", purchaseInput, inside);
  assert.equal(created.response.status, 201);
  const paid = await seed.post(`/api/payments/${created.body.payment.id}/confirm`);
  const setup = await seed.post("/api/account/setup/pin", { phone: purchaseInput.phone, code: paid.body.access.code, pin: "2468", confirmPin: "2468" });
  const f = await fixture(t, { NODE_ENV: "production" }, seed.store);
  const cookie = setup.response.headers.get("set-cookie").split(";")[0];
  const noToken = await f.post("/api/account/logout", {}, outside, { cookie });
  assert.equal(noToken.response.status, 403);
  assert.match(noToken.body.error, /Security token/);
  const untrusted = await f.post("/api/purchase", purchaseInput, inside, { origin: "http://untrusted.test" });
  assert.equal(untrusted.response.status, 403);
  assert.match(untrusted.body.error, /Origin is not allowed/);
  const account = await (await fetch(f.base + "/api/account/dashboard", from(outside, { cookie }))).json();
  assert.equal((await f.post("/api/account/logout", {}, outside, { cookie, "x-csrf-token": account.csrfToken })).response.status, 200);
});

test("disabling coverage allows purchases anywhere; admin and webhooks retain their own checks", async (t) => {
  const f = await fixture(t, { COVERAGE_ACCESS_ENABLED: "false" });
  assert.deepEqual(await (await fetch(f.base + "/api/purchase/access", from(outside))).json(), { allowed: true });
  assert.equal((await f.post("/api/purchase", purchaseInput)).response.status, 201);
  assert.equal((await f.post("/api/admin/login", { pin: "9999" }, outside, { origin: "http://admin.test" })).response.status, 200);
  assert.notEqual((await f.post("/api/webhooks/mesomb")).response.status, 403);
});
