import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { coverageConfigErrors, createCoverageGuard } from "../lib/coverage-access.mjs";

const inside = "203.0.113.10", outside = "198.51.100.7";
const coverage = { TRUST_PROXY: "render", COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: inside };

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const from = (address, headers = {}) => ({ headers: { "cf-connecting-ip": address, ...headers } });

test("coverage settings fail closed instead of silently opening or locking the portal", () => {
  assert.deepEqual(coverageConfigErrors({}), []);
  assert.deepEqual(coverageConfigErrors({ COVERAGE_ACCESS_ENABLED: "false" }), []);
  assert.deepEqual(coverageConfigErrors(coverage), []);
  assert.deepEqual(coverageConfigErrors({ ...coverage, COVERAGE_ALLOWED_IPS: `${inside}, 203.0.113.11` }), []);
  for (const env of [
    { ...coverage, COVERAGE_ACCESS_ENABLED: "yes" }, { ...coverage, TRUST_PROXY: "" },
    { ...coverage, COVERAGE_ALLOWED_IPS: "" }, { ...coverage, COVERAGE_ALLOWED_IPS: "203.0.113.0/24" },
    { ...coverage, COVERAGE_ALLOWED_IPS: "2001:db8::1" },
  ]) assert.throws(() => createCoverageGuard(env), /COVERAGE_|TRUST_PROXY/);
  assert.throws(() => createStaticServer("customer", { apiUrl: "https://api.test", env: { ...coverage, TRUST_PROXY: "" } }), /TRUST_PROXY/);
  assert.throws(() => createServer({ store: createStore({ persistent: false }), env: { ...coverage, COVERAGE_ALLOWED_IPS: "" } }), /COVERAGE_ALLOWED_IPS/);
});

test("the customer portal serves only the hotspot's exit address", async (t) => {
  const base = await listen(t, createStaticServer("customer", { apiUrl: "https://api.test", env: coverage }));
  const health = await fetch(base + "/healthz", from(outside));
  assert.equal(health.status, 200);
  const page = await fetch(base + "/login", from(outside, { accept: "text/html" }));
  assert.equal(page.status, 403);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.match(page.headers.get("content-security-policy"), /^default-src 'none'; style-src 'sha256-/);
  assert.match(await page.text(), /Connect to NDAHI Wi-Fi/);
  const config = await fetch(base + "/config.js", from(outside));
  assert.equal(config.status, 403);
  assert.equal((await config.json()).code, "OUTSIDE_COVERAGE");
  for (const address of ["2001:db8::7", ""]) assert.equal((await fetch(base + "/login", from(address))).status, 403, address || "peer");

  const allowed = await fetch(base + "/login", from(inside));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "private, no-cache");
  const script = (await allowed.text()).match(/src="(\/static\/login\.[0-9a-f]+\.js)"/)[1],
    asset = await fetch(base + script, from(inside));
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "private, max-age=31536000, immutable");
});

test("the admin site and an unrestricted portal keep their existing behavior", async (t) => {
  const admin = await listen(t, createStaticServer("admin", { apiUrl: "https://api.test", env: coverage }));
  assert.equal((await fetch(admin + "/login", from(outside))).status, 200);
  const open = await listen(t, createStaticServer("customer", { apiUrl: "https://api.test", env: {} }));
  const page = await fetch(open + "/login", from(outside));
  assert.equal(page.status, 200);
  const script = (await page.text()).match(/src="(\/static\/login\.[0-9a-f]+\.js)"/)[1];
  assert.equal((await fetch(open + script)).headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("customer API routes require coverage while admin, webhooks and probes stay reachable", async (t) => {
  const base = await listen(t, createServer({ store: createStore({ persistent: false }), env: {
    ...coverage, PAYMENT_MODE: "mock", SESSION_COOKIE_SECURE: "false", ADMIN_PIN: "9999", ADMIN_SESSION_SECRET: "admin-secret",
    ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
  } }));
  for (const path of ["/api/plans", "/api/status", "/api/account/dashboard"]) {
    const refused = await fetch(base + path, from(outside));
    assert.equal(refused.status, 403, path);
    assert.equal((await refused.json()).code, "OUTSIDE_COVERAGE");
  }
  assert.equal((await fetch(base + "/api/plans", from(inside))).status, 200);
  assert.equal((await fetch(base + "/api/health", from(outside))).status, 200);
  const login = await fetch(base + "/api/admin/login", { method: "POST", headers: { ...from(outside).headers, "content-type": "application/json", origin: "http://admin.test" }, body: JSON.stringify({ pin: "9999" }) });
  assert.equal(login.status, 200);
  const webhook = await fetch(base + "/api/webhooks/mesomb", { method: "POST", headers: { ...from(outside).headers, "content-type": "application/json" }, body: "{}" });
  assert.notEqual(webhook.status, 403);
});
