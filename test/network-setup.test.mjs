import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createServer } from "../server.mjs";
import { seal, unseal, allowedEndpoint } from "../lib/network-secrets.mjs";
import { createNetworkSetup, SimulatedRouter } from "../lib/network-setup.mjs";
import { routerPlan, validateRouterConfig, RouterRest, quoteRouter } from "../lib/network-router.mjs";
import { OmadaProvisioner } from "../lib/network-omada.mjs";

const config = { wan: "ether1", apPort: "ether2", gateway: "10.20.0.1/22", poolStart: "10.20.0.20", poolEnd: "10.20.3.250", dns: "1.1.1.1,8.8.8.8", hotspotName: "connect.ndahi.local" };
const env = { NODE_ENV: "test", NETWORK_CONFIG_KEY: "a".repeat(64), NETWORK_ALLOWED_ORIGINS: "https://router.test,https://omada.test", NETWORK_PROVISIONING_ENABLED: "true" };
async function fixture({ adapter = new SimulatedRouter(), overrides = {}, now } = {}) {
  const store = createStore({ persistent: false });
  const service = createNetworkSetup({ store, env: { ...env, ...overrides }, now, routerFactory: () => adapter });
  const call = (action, input = {}) => service.handle(action, input, "owner");
  await call("connection", { kind: "router", mode: "live", url: "https://router.test", username: "service-user", password: "private-router-password" });
  return { store, service, call, adapter };
}
test("network encryption authenticates ciphertext and never stores plaintext", () => {
  const encrypted = seal({ password: "sensitive" }, env);
  assert.doesNotMatch(JSON.stringify(encrypted), /sensitive/);
  assert.deepEqual(unseal(encrypted, env), { password: "sensitive" });
  assert.throws(() => unseal({ ...encrypted, tag: Buffer.alloc(16).toString("base64") }, env));
  assert.throws(() => seal({}, {}), /NETWORK_CONFIG_KEY/);
});
test("management origins reject SSRF targets, URL credentials, and redirect-capable paths", () => {
  assert.equal(allowedEndpoint("https://router.test", env), "https://router.test");
  for (const value of ["http://router.test", "https://evil.test", "https://u:p@router.test", "https://router.test/rest", "https://router.test/?next=evil", "https://router.test/#x"]) assert.throws(() => allowedEndpoint(value, env));
});
test("router planner rejects invalid addressing and identifies existing configuration conflicts", async () => {
  for (const values of [{ poolStart: "10.20.0.1" }, { poolEnd: "10.21.0.1" }, { wan: "ether2" }, { gateway: "8.8.8.1/24" }, { gateway: "10.20.0.1/8", poolStart: "10.0.0.0" }, { dns: "999.1.1.1" }]) assert.throws(() => validateRouterConfig({ ...config, ...values }));
  const inventory = await new SimulatedRouter().discover();
  inventory.tables["interface/bridge/port"].push({ interface: "ether2", bridge: "existing-lan" });
  inventory.tables["ip/address"].push({ address: "10.20.0.5/24", interface: "ether3" });
  const plan = routerPlan(config, inventory);
  assert.ok(plan.conflicts.some((v) => v.includes("existing-lan")));
  assert.ok(plan.conflicts.some((v) => v.includes("overlaps")));
});
test("router REST rejects redirects and failed responses without leaking provider payloads", async () => {
  const router = new RouterRest({ url: "https://router.test", username: "u", password: "secret" }, async (_, options) => {
    assert.equal(options.redirect, "error");
    return new Response('{"password":"secret"}', { status: 403 });
  });
  await assert.rejects(router.discover(), /Router request failed \(403\)/);
  assert.equal(quoteRouter('$x"\\'), '"\\$x\\"\\\\"');
});
test("preview, apply, read-back, owner confirmation and idempotent repeat", async () => {
  const f = await fixture();
  const { job } = await f.call("preview", { kind: "router", config });
  assert.ok(job.plan.operations.length > 5);
  assert.equal(job.secret, undefined);
  await assert.rejects(f.call("apply", { jobId: job.id }), /Review/);
  await f.call("apply", { jobId: job.id, reviewed: true });
  await f.call("apply", { jobId: job.id, reviewed: true });
  await f.service.idle();
  let status = await f.call("status");
  assert.equal(status.jobs[0].status, "awaiting_confirmation");
  await assert.rejects(f.call("confirm", { jobId: job.id }), /testing/);
  await f.call("confirm", { jobId: job.id, tested: true });
  assert.equal((await f.call("status")).jobs[0].status, "completed");
  const second = await f.call("preview", { kind: "router", config });
  assert.equal(second.job.plan.operations.length, 0);
  assert.doesNotMatch(JSON.stringify(await f.store.snapshot()), /private-router-password/);
  assert.doesNotMatch(JSON.stringify(status), /private-router-password|service-user|"secret"/);
});
test("connection changes are blocked during active jobs and rollback restores prior state", async () => {
  const f = await fixture(), before = await f.adapter.discover();
  const { job } = await f.call("preview", { kind: "router", config });
  await f.call("apply", { jobId: job.id, reviewed: true }); await f.service.idle();
  await assert.rejects(f.call("connection", { kind: "router", mode: "live", url: "https://router.test", username: "other", password: "secret" }), /active provisioning job/);
  await f.call("rollback", { jobId: job.id });
  assert.deepEqual((await f.adapter.discover()).tables, before.tables);
  assert.equal((await f.call("status")).jobs[0].status, "rolled_back");
});
test("partial failures retain rollback and block further changes until recovery", async () => {
  const adapter = new SimulatedRouter(), original = adapter.applyOperation.bind(adapter);
  let calls = 0;
  adapter.applyOperation = async (op) => { if (++calls === 3) throw Error("secret device response"); return original(op); };
  const f = await fixture({ adapter });
  const { job } = await f.call("preview", { kind: "router", config });
  await f.call("apply", { jobId: job.id, reviewed: true }); await f.service.idle();
  const status = await f.call("status");
  assert.equal(status.jobs[0].status, "recovery_required");
  assert.doesNotMatch(JSON.stringify(status), /secret device response/);
  await assert.rejects(f.call("preview", { kind: "router", config }), /active job/);
  await f.call("rollback", { jobId: job.id });
  assert.equal((await f.call("status")).jobs[0].status, "rolled_back");
});
test("stale router preview never mutates hardware", async () => {
  const f = await fixture();
  const { job } = await f.call("preview", { kind: "router", config });
  f.adapter.tables["ip/address"].push({ address: "10.20.0.2/24", interface: "ether3" });
  await f.call("apply", { jobId: job.id, reviewed: true }); await f.service.idle();
  assert.equal((await f.call("status")).jobs[0].status, "failed");
  assert.equal(f.adapter.guards.size, 0);
});
test("expired previews and disabled live provisioning fail closed", async () => {
  let time = new Date("2026-01-01T00:00:00Z");
  const f = await fixture({ now: () => time });
  const { job } = await f.call("preview", { kind: "router", config });
  time = new Date(+time + 16 * 60000);
  await assert.rejects(f.call("apply", { jobId: job.id, reviewed: true }), /fresh/);
  const g = await fixture({ overrides: { NETWORK_PROVISIONING_ENABLED: "false" } });
  const preview = await g.call("preview", { kind: "router", config });
  await assert.rejects(g.call("apply", { jobId: preview.job.id, reviewed: true }), /disabled/);
});
test("Omada uses client credentials, correct access-token header, and application error checking", async () => {
  const requests = [];
  const adapter = new OmadaProvisioner({ url: "https://omada.test", controllerId: "controller", siteId: "site", wlanId: "wlan", clientId: "client", clientSecret: "private" }, {
    fetcher: async (url, options) => {
      requests.push({ url, options });
      return Response.json(url.includes("authorize") ? { errorCode: 0, result: { accessToken: "token", expiresIn: 7200 } } : { errorCode: 0, result: { data: [], totalRows: 0 } });
    },
  });
  const d = await adapter.discover();
  assert.equal(d.capabilities.configureSsid, false);
  assert.equal(requests.find((r) => !r.url.includes("authorize")).options.headers.authorization, "AccessToken=token");
  await assert.rejects(adapter.preview({}), /version/);
  adapter.fetcher = async () => Response.json({ errorCode: -1, msg: "private" });
  await assert.rejects(adapter.inventory(), /Omada rejected/);
});

test("setup API enforces owner authorization, CSRF, and no-store responses", async (t) => {
  const store = createStore({ persistent: false });
  const server = createServer({ store, env: { ...env, ADMIN_PIN: "9999", ADMIN_SESSION_SECRET: "test-secret", SECRET_PEPPER: "test-pepper", PAYMENT_MODE: "mock", SESSION_COOKIE_SECURE: "false" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "9999" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const dashboard = await (await fetch(base + "/api/admin/dashboard", { headers: { cookie } })).json();
  const post = (csrf) => fetch(base + "/api/admin/network/setup/connection", { method: "POST", headers: { cookie, "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify({ kind: "router", mode: "simulation" }) });
  assert.equal((await post()).status, 403);
  assert.equal((await post(dashboard.csrfToken)).status, 200);
  const status = await fetch(base + "/api/admin/network/setup/status", { headers: { cookie } });
  assert.equal(status.headers.get("cache-control"), "no-store");
  await store.transaction((s) => { s.adminUsers.forEach((u) => { u.role = "operator"; }); s.adminSessions.forEach((v) => { v.role = "operator"; }); });
  assert.equal((await fetch(base + "/api/admin/network/setup/status", { headers: { cookie } })).status, 403);
  assert.equal((await fetch(base + "/api/admin/network/setup/status")).status, 401);
});


test("orphan watchdogs block provisioning until physical recovery", async () => {
  const discovery = await new SimulatedRouter().discover();
  discovery.guards = ["ndahi-rollback-old-job"];
  const plan = routerPlan(config, discovery);
  assert.ok(plan.conflicts.some((v) => v.includes("watchdog")));
  assert.equal(routerPlan(config, discovery, { ignoreGuard: "old-job" }).conflicts.length, 0);
});

test("restart recovery does not replay an uncertain running mutation", async () => {
  const f = await fixture();
  const { job } = await f.call("preview", { kind: "router", config });
  await f.store.transaction((s) => {
    const j = s.networkSetupJobs.find((v) => v.id === job.id);
    j.status = "running"; j.startedAt = new Date(Date.now() - 11 * 60000).toISOString();
  });
  const restarted = createNetworkSetup({ store: f.store, env, routerFactory: () => { throw Error("Must not contact the router"); } });
  const status = await restarted.handle("status", {}, "owner");
  assert.equal(status.jobs[0].status, "recovery_required");
});

test("restart honors a disabled live-write gate and permits cancelling a queued job", async () => {
  const f = await fixture();
  const { job } = await f.call("preview", { kind: "router", config });
  await f.store.transaction((s) => { s.networkSetupJobs[0].status = "queued"; });
  const restarted = createNetworkSetup({ store: f.store, env: { ...env, NETWORK_PROVISIONING_ENABLED: "false" }, routerFactory: () => { throw Error("Must not contact the router"); } });
  await restarted.handle("status", {}, "owner"); await restarted.idle();
  assert.equal((await restarted.handle("status", {}, "owner")).jobs[0].status, "queued");
  const result = await restarted.handle("cancel", { jobId: job.id }, "owner");
  assert.equal(result.job.status, "cancelled");
});

test("saved-router enforcement activation requires a completed live job", async () => {
  const f = await fixture();
  await assert.rejects(f.call("activate", { tested: true }), /hotspot/);
  const { job } = await f.call("preview", { kind: "router", config });
  await f.call("apply", { jobId: job.id, reviewed: true }); await f.service.idle();
  await assert.rejects(f.call("activate", { tested: true }), /outstanding/);
  await f.call("confirm", { jobId: job.id, tested: true });
  await f.call("activate", { tested: true });
  assert.equal((await f.call("status")).runtimeRouterEnabled, true);
});
