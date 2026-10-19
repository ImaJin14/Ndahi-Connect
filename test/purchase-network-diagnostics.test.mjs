import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { createNetworkSetup } from "../lib/network-setup.mjs";
import { inspectPurchaseNetwork } from "../lib/purchase-network-diagnostics.mjs";

const env = { NODE_ENV: "test", CUSTOMER_APP_URL: "https://portal.example.test", API_URL: "https://api.example.test",
  COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: "209.46.126.73", TRUST_PROXY: "render",
  NETWORK_CONFIG_KEY: "a".repeat(64), NETWORK_ALLOWED_ORIGINS: "https://router.test", NETWORK_PROVISIONING_ENABLED: "false" };
const lookup = async () => ["216.24.57.16", "216.24.57.18"];
function fixture() {
  const requests = [], data = {
    "ip/hotspot": [{ name: "ndahi-hotspot", interface: "vlan20-hotspot", disabled: "false", password: "private-hotspot-password" }],
    "ip/hotspot/walled-garden/ip": ["16", "18"].map((end) => ({ server: "ndahi-hotspot", "dst-address": `216.24.57.${end}/32`, protocol: "tcp", "dst-port": "443", action: "accept" })),
    "ip/route": ["16", "18"].map((end) => ({ "dst-address": `216.24.57.${end}/32`, gateway: "10.77.0.1", "routing-table": "main", active: "true", distance: "1", comment: "private-script-comment" })),
    "interface/wireguard": [{ name: "wg-ndahi", running: "true", "private-key": "private-wireguard-key" }],
    "ip/address": [{ interface: "wg-ndahi", address: "10.77.0.2/24" }],
    "ip/dns/cache": [{ name: "portal.example.test", type: "A", data: "216.24.57.16" }, { name: "private-browsing.example", type: "A", data: "8.8.8.8" }],
    "system/device-mode": { hotspot: "yes", proxy: "yes", "activation-code": "private-activation-code" },
  };
  const router = { request: async (path, method) => {
    requests.push({ path, method }); assert.equal(method, "GET", "diagnostics must never write to the router");
    return structuredClone(data[path] || []);
  } };
  return { router, data, requests };
}

test("owner diagnostics read routes and pre-auth access without exposing secrets or claiming a phone test passed", async () => {
  const f = fixture(), before = structuredClone(f.data);
  const report = await inspectPurchaseNetwork(f.router, env, { lookup, now: () => new Date("2030-01-01T00:00:00Z") });
  assert.equal(report.checkedAt, "2030-01-01T00:00:00.000Z"); assert.equal(report.clientTestRequired, true);
  assert.ok(report.findings.filter((f) => f.label.startsWith("Main route:")).every((f) => f.status === "configured"));
  assert.ok(report.findings.filter((f) => f.label.startsWith("Before-login HTTPS:")).every((f) => f.status === "configured"));
  assert.match(report.nextStep, /cannot prove the phone's actual egress/);
  assert.doesNotMatch(JSON.stringify(report), /private-hotspot-password|private-wireguard-key|private-script-comment|private-activation-code|private-browsing/);
  assert.deepEqual(f.data, before); assert.ok(f.requests.length >= 8);
});

test("diagnostics flag missing HTTPS exceptions, inactive tunnel routes and auth-only routing", async () => {
  const f = fixture(); f.data["ip/hotspot/walled-garden/ip"] = [{ action: "accept", "dst-host": "portal.example.test", server: "ndahi-hotspot" }];
  f.data["ip/route"].forEach((r) => { r.active = "false"; });
  f.data["ip/firewall/mangle"] = [{ action: "mark-routing", hotspot: "auth", "new-routing-mark": "paid-only" }];
  f.data["ipv6/nd"] = [{ interface: "vlan20-hotspot", disabled: "false" }];
  const report = await inspectPurchaseNetwork(f.router, env, { lookup });
  assert.ok(report.findings.some((f) => /Only a hostname/.test(f.detail)));
  assert.ok(report.findings.filter((f) => f.label.startsWith("Main route:")).every((f) => f.status === "review"));
  assert.ok(report.findings.some((f) => f.label === "Authentication-dependent routing"));
  assert.ok(report.findings.some((f) => f.label === "Guest IPv6"));
});

test("partial reads and DNS failures remain explicit and never forward raw provider errors", async () => {
  const f = fixture(), original = f.router.request;
  f.router.request = (path, method) => path === "ip/route" ? Promise.reject(Error("private-provider-error")) : original(path, method);
  const report = await inspectPurchaseNetwork(f.router, env, { lookup: async () => { throw Error("private-dns-error"); } });
  assert.ok(report.findings.some((f) => /could not resolve/.test(f.detail)));
  assert.ok(report.readings.some((r) => r.path === "ip/route" && r.error));
  assert.doesNotMatch(JSON.stringify(report), /private-provider-error|private-dns-error/);
});

test("invalid service origins cannot trigger router reads or expose URL credentials", async () => {
  const f = fixture();
  for (const origin of [undefined, "http://portal.example.test", "https://user@portal.example.test", "https://portal.example.test/path", "https://portal.example.test:8443"]) {
    await assert.rejects(inspectPurchaseNetwork(f.router, { ...env, CUSTOMER_APP_URL: origin }, { lookup }), /production HTTPS origins/);
  }
  const origin = new URL(env.CUSTOMER_APP_URL);
  origin.password = randomUUID();
  await assert.rejects(inspectPurchaseNetwork(f.router, { ...env, CUSTOMER_APP_URL: origin.href }, { lookup }), /production HTTPS origins/);
  assert.equal(f.requests.length, 0);
});

test("oversized readings are bounded and flagged for full inspection", async () => {
  const f = fixture(); f.data["routing/rule"] = Array.from({ length: 200 }, () => ({ action: "lookup", table: "main" }));
  const report = await inspectPurchaseNetwork(f.router, env, { lookup });
  assert.equal(report.readings.find((r) => r.path === "routing/rule").rows.length, 150);
  assert.ok(report.findings.some((f) => f.label === "routing/rule" && /truncated/.test(f.detail)));
});

test("the dashboard check uses only the saved live connection and works while live provisioning is disabled", async () => {
  const f = fixture(), store = createStore({ persistent: false });
  const service = createNetworkSetup({ store, env, routerFactory: () => f.router, purchaseLookup: lookup });
  await service.handle("connection", { kind: "router", mode: "live", url: "https://router.test", username: "service", password: "private-connection-password" }, "owner");
  const before = await store.snapshot();
  const result = await service.handle("purchase-access", { url: "https://untrusted.test", api: "https://untrusted.test" }, "owner");
  assert.equal(result.report.clientTestRequired, true);
  assert.ok(result.report.targets.every((t) => t.host.endsWith(".example.test")));
  assert.deepEqual(await store.snapshot(), before, "no provisioning jobs, settings or credentials change");
  assert.doesNotMatch(JSON.stringify(result), /private-connection-password/);
  const simulated = createNetworkSetup({ store: createStore({ persistent: false }), env });
  await simulated.handle("connection", { kind: "router", mode: "simulation" }, "owner");
  await assert.rejects(simulated.handle("purchase-access", {}, "owner"), /simulation cannot check/);
});

test("purchase diagnostics require owner authentication and CSRF, and return an uncached report", async (t) => {
  const f = fixture(), store = createStore({ persistent: false });
  const service = createNetworkSetup({ store, env, routerFactory: () => f.router });
  await service.handle("connection", { kind: "router", mode: "live", url: "https://router.test", username: "service", password: "private-connection-password" }, "owner");
  const server = createServer({ store, networkRouterFactory: () => f.router, networkPurchaseLookup: lookup, env: {
    ...env, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
    ADMIN_PIN: "9999", ADMIN_SESSION_SECRET: "diagnostics-test", BILLING_WORKER_ENABLED: "false", SESSION_COOKIE_SECURE: "false",
  } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "9999" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const dashboard = await (await fetch(base + "/api/admin/dashboard", { headers: { cookie } })).json();
  const path = base + "/api/admin/network/setup/purchase-access";
  const post = (headers = {}) => fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  assert.equal((await post()).status, 401);
  assert.equal((await post({ cookie })).status, 403); assert.equal(f.requests.length, 0);
  const allowed = await post({ cookie, "x-csrf-token": dashboard.csrfToken });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal((await allowed.json()).report.clientTestRequired, true);
  assert.equal((await fetch(path, { headers: { cookie } })).status, 405);
  await store.transaction((s) => { s.adminUsers.forEach((u) => { u.role = "operator"; }); s.adminSessions.forEach((s) => { s.role = "operator"; }); });
  const reads = f.requests.length;
  assert.equal((await post({ cookie, "x-csrf-token": dashboard.csrfToken })).status, 403);
  assert.equal(f.requests.length, reads);
});
