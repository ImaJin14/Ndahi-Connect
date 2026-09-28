import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { createPerformanceMetrics, operationFor } from "../lib/performance.mjs";
import { productionConfigErrors } from "../lib/config.mjs";

const token = "m".repeat(40);
async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
async function api(t, env = {}) {
  const server = createServer({
      store: createStore({ persistent: false }),
      validateConfig: false,
      env: {
        PAYMENT_MODE: "mock",
        CUSTOMER_APP_URL: "http://customer.test",
        ALLOWED_ADMIN_ORIGINS: "http://admin.test",
        PERFORMANCE_METRICS_ENABLED: "true",
        METRICS_BEARER_TOKEN: token,
        ...env,
      },
    }),
    base = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));
  return base;
}
const vital = (base, payload, origin = "http://customer.test") =>
  fetch(base + "/api/telemetry/vitals", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

test("static assets are versioned, compressed and immutable while pages revalidate", async (t) => {
  const server = createStaticServer("customer"), base = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));
  const page = await fetch(base + "/login", { headers: { "accept-encoding": "br" } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-encoding"), "br");
  assert.equal(page.headers.get("cache-control"), "no-cache");
  const html = await page.text(),
    styles = html.match(/href="(\/static\/styles\.[0-9a-f]{20}\.css)"/)?.[1];
  assert.ok(styles, "stylesheet reference is versioned");
  assert.doesNotMatch(html, /src="\/login\.js"/);
  const css = await fetch(base + styles);
  assert.equal(css.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const text = await css.text();
  assert.match(text, /url\('\/static\/assets\/signal-hero\.[0-9a-f]{20}\.webp'\)/);
  assert.ok(text.includes("https://fonts.googleapis.com/css2?"), "external URLs are not rewritten");
  const etag = css.headers.get("etag"),
    again = await fetch(base + styles, { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  const script = await (await fetch(base + html.match(/src="(\/static\/login\.[0-9a-f]{20}\.js)"/)[1])).text();
  assert.match(script, /from "\/static\/errors\.[0-9a-f]{20}\.js"/);
  assert.equal((await fetch(base + "/login", { method: "POST" })).status, 405);
  assert.equal((await fetch(base + "/static/styles.0000000000.css")).status, 404);
  assert.equal((await fetch(base + "/../server.mjs")).status, 404);
});

test("browser telemetry is injected only when enabled", async (t) => {
  for (const telemetry of [false, true]) {
    const server = createStaticServer("admin", { telemetry }), base = await listen(server);
    t.after(() => new Promise((r) => server.close(r)));
    const html = await (await fetch(base + "/login")).text();
    assert.equal(/\/static\/shared\/performance\.[0-9a-f]{20}\.js/.test(html), telemetry);
    if (telemetry) {
      const module = await (await fetch(base + html.match(/src="(\/static\/shared\/performance\.[^"]+)"/)[1])).text();
      assert.match(module, /from "\/static\/vendor\/web-vitals\.[0-9a-f]{20}\.js"/);
      assert.match(module, /credentials: "omit"/);
    }
  }
});

test("operations map to the documented performance targets", () => {
  assert.equal(operationFor("/api/account/dashboard"), "dashboard");
  assert.equal(operationFor("/api/admin/dashboard"), "dashboard");
  assert.equal(operationFor("/api/purchase"), "payment_creation");
  assert.equal(operationFor("/api/vouchers/redeem"), "voucher_redemption");
  assert.equal(operationFor("/api/account/login"), "login");
  assert.equal(operationFor("/api/admin/login"), "login");
  assert.equal(operationFor("/api/admin/vouchers"), "admin");
  assert.equal(operationFor("/api/plans"), null);
});

test("metrics require a bearer token and record request latency", async (t) => {
  const base = await api(t);
  assert.equal((await fetch(base + "/api/metrics")).status, 401);
  assert.equal((await fetch(base + "/api/metrics", { headers: { authorization: "Bearer wrong" } })).status, 401);
  await fetch(base + "/api/vouchers/redeem", {
    method: "POST",
    headers: { origin: "http://customer.test", "content-type": "application/json" },
    body: "{}",
  });
  const metrics = await fetch(base + "/api/metrics", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(metrics.status, 200);
  const text = await metrics.text();
  assert.match(text, /ndahi_request_duration_seconds_count\{operation="voucher_redemption",outcome="client_error"\} 1/);
  assert.match(text, /ndahi_request_target_seconds\{operation="payment_creation"\} 2\.5/);
  assert.match(text, /ndahi_web_vital_target\{metric="LCP"\} 2500/);
});

test("metrics and telemetry endpoints are hidden when disabled", async (t) => {
  const base = await api(t, { PERFORMANCE_METRICS_ENABLED: "false" });
  assert.equal((await fetch(base + "/api/metrics", { headers: { authorization: `Bearer ${token}` } })).status, 404);
  assert.equal((await vital(base, { name: "LCP", value: 1200, page: "login", device: "mobile", network: "slow" })).status, 404);
});

test("web vitals accept only trusted origins and fixed categories", async (t) => {
  const base = await api(t);
  assert.equal((await vital(base, { name: "LCP", value: 1800, page: "login", device: "mobile", network: "slow" })).status, 204);
  assert.equal((await vital(base, { name: "INP", value: 90, page: "dashboard", device: "desktop", network: "fast" }, "http://admin.test")).status, 204);
  for (const invalid of [
    { name: "FID", value: 10, page: "login", device: "mobile", network: "slow" },
    { name: "LCP", value: -1, page: "login", device: "mobile", network: "slow" },
    { name: "LCP", value: 100, page: "/login?phone=670000000", device: "mobile", network: "slow" },
    { name: "CLS", value: "0.1", page: "login", device: "mobile", network: "slow" },
  ]) assert.equal((await vital(base, invalid)).status, 400);
  assert.equal((await vital(base, { name: "LCP", value: 1, page: "login", device: "mobile", network: "slow" }, "http://evil.test")).status, 403);
  const oversized = await vital(base, { name: "LCP", value: 1, page: "login", device: "mobile", network: "slow", pad: "x".repeat(4000) });
  assert.equal(oversized.status, 413);
  const text = await (await fetch(base + "/api/metrics", { headers: { authorization: `Bearer ${token}` } })).text();
  assert.match(text, /ndahi_web_vital_lcp_count\{app="customer",page="login",device="mobile",network="slow"\} 1/);
  assert.match(text, /ndahi_web_vital_inp_count\{app="admin",page="dashboard",device="desktop",network="fast"\} 1/);
  assert.match(text, /ndahi_web_vital_rejected_total\{reason="invalid"\} 4/);
});

test("browser telemetry is rate limited per window", () => {
  let now = 0;
  const metrics = createPerformanceMetrics({ enabled: true, token, now: () => now, sampleLimit: 2 }),
    sample = { name: "CLS", value: 0.02, page: "login", device: "mobile", network: "unknown" };
  assert.equal(metrics.ingest(sample, "customer"), 204);
  assert.equal(metrics.ingest(sample, "customer"), 204);
  assert.equal(metrics.ingest(sample, "customer"), 429);
  now = 60_000;
  assert.equal(metrics.ingest(sample, "customer"), 204);
});

test("production metrics require a strong scrape token", () => {
  const errors = (env) => productionConfigErrors({ NODE_ENV: "production", ...env });
  assert.ok(errors({ PERFORMANCE_METRICS_ENABLED: "true" }).includes("METRICS_BEARER_TOKEN must be configured"));
  assert.ok(errors({ PERFORMANCE_METRICS_ENABLED: "true", METRICS_BEARER_TOKEN: "short-token" }).includes("METRICS_BEARER_TOKEN must be at least 32 characters"));
  assert.ok(!errors({ PERFORMANCE_METRICS_ENABLED: "true", METRICS_BEARER_TOKEN: token }).some((e) => e.startsWith("METRICS")));
});

test("CORS echoes only configured origins and rejects the opaque null origin", async (t) => {
  const base = await api(t);
  const allowed = await fetch(base + "/api/plans", { headers: { origin: "http://customer.test" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://customer.test");
  for (const origin of ["null", "http://evil.test"]) {
    const rejected = await fetch(base + "/api/plans", { headers: { origin } });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  }
  const admin = await fetch(base + "/api/admin/dashboard", { headers: { origin: "http://customer.test" } });
  assert.equal(admin.status, 403, "the customer origin cannot call administrator routes");
});
