import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore, blank } from "../server.mjs";
import { dashboardTotals, queryRecords } from "../lib/admin-records.mjs";
import { adminWifiSummary, requestWifiRefresh, requestWifiDisconnect } from "../lib/wifi-devices.mjs";
import { enqueueRouterCommand, scheduleRouterCommandReplay, resolveObsoleteRouterCommand, routerQueueSummary, createRouterCommandProcessor } from "../lib/router-queue.mjs";
import { createRouterReconciler } from "../lib/router-reconciliation.mjs";
import { hashSecret } from "../lib/security.mjs";

const at = new Date("2030-01-01T08:00:00Z");
const device = { mac: "AA:BB:CC:DD:EE:01", sessionId: "*A", startedAt: "2030-01-01T07:55:00.000Z" };
function state() {
  const s = blank();
  s.networkSetup = { runtimeRouterEnabled: true };
  s.vouchers = [{ id: "v1", customerId: "c1", code: "NC-FIXTURE", status: "active", usedBytes: 0, quotaBytes: null,
    expiresAt: "2030-01-02T08:00:00Z", wifiDevicesAt: at.toISOString(), wifiDevices: [device, { ...device, mac: "AA:BB:CC:DD:EE:02", sessionId: "*B" }, device] }];
  return s;
}
const legacy = (s) => {
  const c = enqueueRouterCommand(s, { action: "disconnect_device", targetId: "legacy-browser-uuid" }, () => at);
  Object.assign(c, { status: "dead_letter", attempts: 1, totalAttempts: 49, lastError: "Legacy device disconnection needs a fresh router session mapping." });
  return c;
};
test("admin live counts and rows share deduplicated router observations instead of browser sessions", () => {
  const s = state();
  assert.equal(dashboardTotals(s, { live: true, now: at }).activeSessions, 2);
  const rows = queryRecords(s, { collection: "wifiDevices", status: "connected" }, { now: at });
  assert.equal(rows.total, 2);
  assert.equal(adminWifiSummary(s, at).activeCount, 2);
  assert.equal(queryRecords(s, { collection: "sessions" }).total, 0);
  s.sessions.push({ status: "online" });
  assert.equal(dashboardTotals(s, { live: true, now: at }).activeSessions, 2);
});
test("stale or failed readings retain observed devices without presenting them as confirmed current", () => {
  const s = state(), later = new Date(+at + 121000);
  assert.equal(adminWifiSummary(s, later).state, "stale");
  assert.equal(adminWifiSummary(s, later).activeCount, 0);
  assert.equal(adminWifiSummary(s, later).staleCount, 2);
  assert.equal(queryRecords(s, { collection: "wifiDevices", status: "stale" }, { now: later }).total, 2);
  const read = enqueueRouterCommand(s, { action: "sync_usage" }, () => at);
  Object.assign(read, { status: "dead_letter", lastError: "router unreachable" });
  assert.equal(adminWifiSummary(s, later).state, "failed");
  assert.equal(requestWifiRefresh(s, () => later).status, 409);
  assert.equal(s.vouchers[0].wifiDevices.length, 3);
});
test("refresh requests coalesce and a successful empty read clears devices and the count", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => Object.assign(s, state()));
  await store.transaction((s) => { assert.equal(requestWifiRefresh(s, () => at).status, 202); requestWifiRefresh(s, () => at); });
  assert.equal((await store.snapshot()).routerCommands.length, 1);
  await createRouterCommandProcessor({ store, now: () => at, router: { readUsage: async () => [{ voucherId: "v1", usedBytes: 0, devices: [] }] } }).process();
  const s = await store.snapshot();
  assert.equal(adminWifiSummary(s, at).activeCount, 0);
  assert.equal(adminWifiSummary(s, at).state, "ready");
  assert.equal(queryRecords(s, { collection: "wifiDevices" }, { now: at }).total, 0);
  assert.equal(requestWifiRefresh(s, () => at).status, 200, "recent successful readings are not repeatedly requeued");
});
test("obsolete jobs reject replay and resolve idempotently while preserving failure and attempt history", () => {
  const s = state(), c = legacy(s);
  assert.equal(routerQueueSummary(s).commands[0].canReplay, false);
  assert.equal(routerQueueSummary(s).commands[0].canResolve, true);
  assert.equal(scheduleRouterCommandReplay(s, c.id, () => at).status, 409);
  assert.equal(c.totalAttempts, 49);
  assert.equal(resolveObsoleteRouterCommand(s, c.id, () => at).status, 200);
  assert.equal(resolveObsoleteRouterCommand(s, c.id, () => at).status, 200);
  assert.equal(c.totalAttempts, 49); assert.match(c.lastError, /Legacy/);
  assert.equal(c.status, "resolved"); assert.equal(routerQueueSummary(s).deadLetters, 0);
  assert.equal(routerQueueSummary(s).commands.length, 0);
  assert.equal(s.vouchers[0].wifiDevices.length, 3, "resolving history does not disconnect a device");
  const read = enqueueRouterCommand(s, { action: "sync_usage" }, () => at);
  read.status = "dead_letter";
  assert.equal(resolveObsoleteRouterCommand(s, read.id, () => at).status, 409);
  assert.equal(scheduleRouterCommandReplay(s, read.id, () => at).status, 202);
});
test("live reconciliation cannot create an unscoped disconnect from a legacy session", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => { Object.assign(s, state()); s.sessions.push({ id: "old", deviceId: "browser-uuid", status: "disconnected" }); });
  await createRouterReconciler({ store, now: () => at, router: { readState: async () => ({ vouchers: [{ voucherId: "v1", enabled: true }], sessions: [{ deviceId: "browser-uuid", active: true }] }) } })();
  assert.equal((await store.snapshot()).routerCommands.length, 0);
});
test("a refreshed device with a reused router ID cannot be disconnected using an older observed start", () => {
  const s = state();
  assert.equal(requestWifiDisconnect(s, s.vouchers[0], { mac: device.mac, sessionId: device.sessionId, startedAt: "2030-01-01T07:50:00Z" }, () => at).status, 404);
  assert.equal(s.routerCommands.length, 0);
});
test("live-device endpoints enforce roles, origin/CSRF, audit and preserve the legacy job on replay rejection", async (t) => {
  let current = at;
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    Object.assign(s, state()); legacy(s);
    for (const role of ["owner", "operator", "auditor", "reseller"]) s.adminSessions.push({ tokenHash: hashSecret(role, "fixture-admin-secret"), role, csrfToken: "fixture-csrf", expiresAt: "2030-01-02T08:00:00Z" });
  });
  const server = createServer({ store, now: () => current, validateConfig: false, env: { NODE_ENV: "production", BOOTSTRAP_MODE: "false", PAYMENT_MODE: "mock", MIKROTIK_MODE: "live", ADMIN_SESSION_SECRET: "fixture-admin-secret", ADMIN_APP_URL: "https://admin.test", ALLOWED_ADMIN_ORIGINS: "https://admin.test", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, role = "owner", body, csrf = "fixture-csrf", origin = "https://admin.test") => {
    const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { cookie: `admin_session=${role}`, origin, "x-csrf-token": csrf, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call("/api/admin/dashboard")).body.metrics.activeSessions, 2);
  assert.equal((await call("/api/admin/records?collection=wifiDevices")).body.total, 2);
  assert.equal((await call("/api/admin/wifi-devices")).body.activeCount, 2);
  const commandId = (await store.snapshot()).routerCommands[0].id;
  assert.equal((await call("/api/admin/network/commands/replay", "owner", { commandId })).status, 409);
  for (const role of ["auditor", "reseller"]) {
    assert.equal((await call("/api/admin/network/commands/resolve", role, { commandId })).status, 403);
    assert.equal((await call("/api/admin/wifi-devices/refresh", role, {})).status, 403);
  }
  assert.equal((await call("/api/admin/network/commands/resolve", "owner", { commandId }, "wrong")).status, 403);
  assert.equal((await call("/api/admin/network/commands/resolve", "owner", { commandId }, "fixture-csrf", "https://evil.test")).status, 403);
  assert.equal((await call("/api/admin/network/commands/resolve", "operator", { commandId })).status, 200);
  assert.equal((await call("/api/admin/network/commands/resolve", "operator", { commandId })).status, 200);
  const s = await store.snapshot();
  assert.equal(s.routerCommands[0].totalAttempts, 49);
  assert.equal(s.auditLogs.filter((a) => a.action === "network.command_resolved").length, 1);
  current = new Date(+at + 121000);
  assert.equal((await call("/api/admin/dashboard")).body.metrics.activeSessions, null, "an unknown count is not zero");
  assert.equal((await call("/api/admin/records?collection=wifiDevices&status=stale")).body.total, 2);
});
