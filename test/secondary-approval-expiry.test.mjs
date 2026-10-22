import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, guestMac, mainMac } from "./helpers/wifi-pairing-fixture.mjs";
import { approveDevice, deviceGrant, deviceRevocation } from "../lib/wifi-approval.mjs";
import { observeSecondaryApprovals, approvalGeneration, secondaryApprovalGraceMs } from "../lib/secondary-approval-expiry.mjs";
import { enqueueRouterCommand, createRouterCommandProcessor } from "../lib/router-queue.mjs";
import { createUsageSyncScheduler } from "../lib/router-reconciliation.mjs";
import { notificationItems } from "../lib/notifications.mjs";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { blank } from "../lib/api/state.mjs";

async function fixture(t, options) {
  let f;
  const stamp = (rows, at) => rows.map((r) => ({ ...r, observation: { startedAt: at.toISOString(), completedAt: at.toISOString(), bootAt: "2029-12-01T00:00:00Z" } }));
  f = await pairingFixture({ ...options, env: { WIFI_SECONDARY_EXPIRY_ENABLED: "true", ...options?.env }, router: { ...options?.router,
    async readUsage() { const at = f.now(); return stamp(await (options?.router?.readUsage?.() || []), at); } } }); t.after(f.close);
  const boot = f.now();
  await f.store.transaction((s) => { approveDevice(s, "c1", { mac: guestMac }, f.now(), "test"); });
  async function observe(seconds = 0, readings = [{ voucherId: "v1", devices: [] }], processStartedAt = boot) {
    f.advance(seconds);
    return f.store.transaction((s) => observeSecondaryApprovals(s, stamp(readings, f.now()), f.now(), { processStartedAt, readStartedAt: f.now() }));
  }
  async function offlineMinutes(minutes) { for (let i = 0; i < minutes; i++) await observe(60); }
  const grant = async () => (await f.store.snapshot()).wifiDeviceGrants.find((g) => g.mac === guestMac);
  return { ...f, boot, observe, offlineMinutes, grant };
}

test("secondary approval expires once at 30:00, invalidates its app, cancels stale codes and retains scoped history", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.vouchers[0].wifiDevices.push({ mac: guestMac, address: "10.20.0.30", sessionId: "*guest", startedAt: f.now().toISOString() });
  });
  await f.call("/api/account/device-management/current/identify", { mac: guestMac, address: "10.20.0.30" });
  await f.observe(); await f.offlineMinutes(29); await f.observe(59);
  assert.equal((await f.grant()).status, "approved");
  assert.equal((await f.grant()).secondaryOffline.durationMs, secondaryApprovalGraceMs - 1000);
  await f.store.transaction((s) => s.wifiPairingRequests.push({ id: "old-code", customerId: "c1", mac: guestMac, status: "awaiting_code",
    expiresAt: new Date(+f.now() + 300000).toISOString(), codeHash: "unused", codeNonce: "unused" }));
  assert.equal(await f.observe(1), 1);
  const s = await f.store.snapshot(), g = await f.grant(), command = s.routerCommands.find((c) => c.id === g.revocationCommandId);
  assert.equal(g.status, "revoked"); assert.equal(command.kind, "wifi_approval_expiry");
  assert.equal(command.grantGeneration, approvalGeneration(g));
  assert.equal(s.dashboardSessions.find((a) => a.id === "main").currentWifi, undefined);
  assert.equal(s.wifiAppAssociations[0].candidate, undefined);
  assert.equal(s.wifiPairingRequests[0].status, "cancelled"); assert.equal(s.wifiPairingRequests[0].codeHash, undefined);
  assert.equal(await f.observe(60), 0);
  const own = notificationItems(await f.store.snapshot(), { type: "customer", id: "c1" }, f.now()).filter((n) => n.id.startsWith("approval-expiry:"));
  assert.equal(own.length, 1); assert.equal(own[0].pushEligible, false);
  assert.equal(notificationItems(await f.store.snapshot(), { type: "customer", id: "c2" }, f.now()).some((n) => n.id === own[0].id), false);
});

test("returning before expiry resets accumulated absence; main approval is exempt", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => approveDevice(s, "c1", { mac: mainMac }, f.now(), "test"));
  await f.observe(); await f.offlineMinutes(29);
  await f.observe(59, [{ voucherId: "v1", devices: [{ mac: guestMac }] }]);
  assert.equal((await f.grant()).secondaryOffline, undefined);
  await f.observe(60); await f.offlineMinutes(29);
  assert.equal((await f.grant()).status, "approved");
  await f.observe(60);
  const main = (await f.store.snapshot()).wifiDeviceGrants.find((g) => g.mac === mainMac);
  assert.equal(main.status, "approved"); assert.equal(main.secondaryOffline, undefined);
});

test("outages, partial/invalid/duplicate/missing reads and restart gaps never accrue offline duration", async (t) => {
  const f = await fixture(t);
  await f.observe(); await f.offlineMinutes(10);
  const duration = (await f.grant()).secondaryOffline.durationMs;
  await f.observe(3600); assert.equal((await f.grant()).secondaryOffline.durationMs, duration);
  for (const readings of [[], [{ voucherId: "v1" }], [{ voucherId: "v1", devices: [{ mac: "invalid" }] }],
    [{ voucherId: "v1", devices: [] }, { voucherId: "v1", devices: [] }]]) {
    await f.observe(20, readings); await f.observe(20);
    assert.equal((await f.grant()).secondaryOffline.durationMs, duration);
  }
  f.advance(20); const restartedAt = f.now(); await f.observe(20, undefined, restartedAt);
  assert.equal((await f.grant()).secondaryOffline.durationMs, duration);
  await f.observe(60, undefined, restartedAt);
  assert.equal((await f.grant()).secondaryOffline.durationMs, duration + 60000);
  assert.equal((await f.grant()).status, "approved");
});

test("all relevant account voucher readings must be complete; missing another bundle freezes counting", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => s.vouchers.push({ ...s.vouchers[0], id: "v2" }));
  await f.observe(); await f.offlineMinutes(31);
  assert.equal((await f.grant()).secondaryOffline, undefined);
  assert.equal((await f.grant()).status, "approved");
});

test("queued or processing access cannot be expired, and main selection at the boundary is exempt", async (t) => {
  for (const mode of ["queued", "processing", "request", "main"]) {
    const f = await fixture(t); await f.observe(); await f.offlineMinutes(29);
    await f.store.transaction((s) => {
      if (mode === "main") s.customers[0].wifiMainDevice.mac = guestMac;
      else if (mode === "request") s.wifiPairingRequests.push({ id: "connecting", customerId: "c1", mac: guestMac, status: "connecting" });
      else s.routerCommands.push({ id: "in-flight-connect", action: "connect_wifi_device", customerId: "c1", status: mode, device: { voucherId: "v1", mac: guestMac } });
    });
    await f.observe(60); assert.equal((await f.grant()).status, "approved");
  }
});

test("renewed generation and router changes fence delayed cleanup before any router call", async (t) => {
  for (const mode of ["renewed", "router", "main"]) {
    let removals = 0;
    const f = await fixture(t, { router: { async revokeWifiDevice() { removals++; return { confirmed: true }; } } });
    await f.observe(); await f.offlineMinutes(30); const expired = await f.grant();
    await f.store.transaction((s) => {
      const g = s.wifiDeviceGrants.find((g) => g.id === expired.id);
      if (mode === "renewed") { g.generation = "renewed-generation"; g.status = "approved"; }
      if (mode === "router") s.networkSetup.connections.router.revision = "new-router";
      if (mode === "main") s.customers[0].wifiMainDevice.mac = guestMac;
    });
    assert.equal((await f.handler.routerProcessor.process(expired.revocationCommandId)).skipped, true);
    assert.equal(removals, 0);
  }
});

test("router cleanup is leased, scoped, blocks reapproval until confirmed, and cannot affect another customer", async (t) => {
  const removals = [];
  const f = await fixture(t, { router: { async revokeWifiDevice(device) { removals.push(device); return { confirmed: true, outcome: "revoked" }; } } });
  await f.observe(); await f.offlineMinutes(30);
  const g = await f.grant();
  await f.store.transaction((s) => { approveDevice(s, "c1", { mac: guestMac }, f.now(), "new_approval"); });
  assert.equal((await f.grant()).status, "revoked");
  await Promise.all([f.handler.routerProcessor.process(g.revocationCommandId), f.handler.routerProcessor.process(g.revocationCommandId)]);
  assert.equal(removals.length, 1); assert.equal(removals[0].mac, guestMac);
  assert.deepEqual(removals[0].targets.map((v) => v.voucherId), ["v1"]);
  assert.ok((await f.grant()).expiries[0].routerConfirmedAt);
  await f.store.transaction((s) => { assert.equal(deviceRevocation(s, "c1", guestMac), undefined); approveDevice(s, "c1", { mac: guestMac }, f.now(), "new_approval"); });
  assert.equal((await f.grant()).status, "approved"); assert.notEqual(approvalGeneration(await f.grant()), approvalGeneration(g));
  assert.equal((await f.grant()).expiries.length, 1);
});

test("actual sync worker failure pauses even a short outage and backend restart establishes a baseline", async (t) => {
  let online = true;
  const f = await fixture(t, { router: { async readUsage() { if (!online) throw Error("offline"); return [{ voucherId: "v1", usedBytes: 20, devices: [] }]; } } });
  async function sync(seconds, processor = f.handler.routerProcessor) {
    f.advance(seconds); await f.store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, f.now));
    return processor.process("router:sync_usage:global");
  }
  await sync(0); await sync(60);
  assert.equal((await f.grant()).secondaryOffline.durationMs, 60000);
  online = false; await sync(20); online = true; await sync(30);
  assert.equal((await f.grant()).secondaryOffline.durationMs, 60000);
  f.advance(1);
  const restarted = createRouterCommandProcessor({ store: f.store, secondaryApprovalExpiry: true, router: { async readUsage() { return [{ voucherId: "v1", usedBytes: 20, devices: [], observation: { startedAt: f.now().toISOString(), completedAt: f.now().toISOString(), bootAt: "2029-12-01T00:00:00Z" } }]; } }, now: f.now });
  await sync(20, restarted); assert.equal((await f.grant()).secondaryOffline.durationMs, 60000);
  await sync(60, restarted); assert.equal((await f.grant()).secondaryOffline.durationMs, 120000);
});

test("approved reconnect keeps its generation and an expired-only bundle still schedules observation", async (t) => {
  const f = await fixture(t), old = await f.grant();
  await f.store.transaction((s) => { approveDevice(s, "c1", { mac: guestMac }, f.now(), "reconnect"); s.vouchers[0].status = "expired"; });
  assert.equal(approvalGeneration(await f.grant()), approvalGeneration(old));
  const schedule = createUsageSyncScheduler({ store: f.store, env: { WIFI_SECONDARY_EXPIRY_ENABLED: "true" }, now: f.now });
  assert.equal((await schedule()).queued, true);
  await f.observe(); await f.offlineMinutes(30);
  assert.equal((await f.grant()).status, "revoked");
});

test("a confirmed explicit session disconnect starts absence, while uncertain cleanup stays pending", async (t) => {
  const f = await fixture(t, { router: { async disconnectWifiDevice() { return { confirmed: true, outcome: "disconnected" }; },
    async revokeWifiDevice() { return { confirmed: false }; } } });
  const device = { mac: guestMac, address: "10.20.0.30", sessionId: "*guest", startedAt: f.now().toISOString() };
  await f.store.transaction((s) => s.vouchers[0].wifiDevices.push(device));
  const request = await f.call("/api/account/wifi-devices/disconnect", { ...device, retainApproval: true });
  assert.equal(request.status, 202); assert.equal((await f.grant()).secondaryOffline, undefined);
  await f.handler.routerProcessor.process(request.body.operation.id);
  assert.equal((await f.grant()).secondaryOffline.durationMs, 0);
  await f.observe(); await f.offlineMinutes(30); const g = await f.grant();
  await f.handler.routerProcessor.process(g.revocationCommandId);
  const s = await f.store.snapshot(), job = s.routerCommands.find((c) => c.id === g.revocationCommandId);
  assert.equal(job.status, "retry"); assert.equal((await f.grant()).revocationConfirmedAt, undefined);
  await f.store.transaction((s) => assert.ok(deviceRevocation(s, "c1", guestMac)));
  assert.equal((await f.grant()).expiries.length, 1);
});

test("rollout disable prevents automatic expiry while normal complete usage synchronization continues", async (t) => {
  const f = await fixture(t); await f.observe(); await f.offlineMinutes(29);
  const processor = createRouterCommandProcessor({ store: f.store, now: f.now, secondaryApprovalExpiry: false,
    router: { async readUsage() { return [{ voucherId: "v1", usedBytes: 20, devices: [] }]; } } });
  f.advance(60); await f.store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, f.now));
  await processor.process("router:sync_usage:global");
  assert.equal((await f.grant()).status, "approved"); assert.equal((await f.grant()).secondaryOffline.observedAt, null);
});

test("PostgreSQL persists offline duration across restart and two workers lease one cleanup", { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not set" }, async (t) => {
  const schema = `ndahi_secondary_expiry_${process.pid}`, admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) await pool.query(await readFile(new URL(file, directory), "utf8"));
  const f = await fixture(t), initial = createPostgresStore({ pool, initialState: blank });
  await initial.transaction(async (s) => Object.assign(s, await f.store.snapshot()));
  let store = initial, boot = f.now();
  const observe = async (seconds) => { f.advance(seconds); await store.transaction((s) => observeSecondaryApprovals(s,
    [{ voucherId: "v1", devices: [], observation: { startedAt: f.now().toISOString(), completedAt: f.now().toISOString(), bootAt: "2029-12-01T00:00:00Z" } }], f.now(), { processStartedAt: boot, readStartedAt: f.now() })); };
  await observe(0); for (let i = 0; i < 10; i++) await observe(60);
  f.advance(5); boot = f.now(); store = createPostgresStore({ pool, initialState: blank });
  await observe(30); assert.equal((await store.snapshot()).wifiDeviceGrants[0].secondaryOffline.durationMs, 600000);
  for (let i = 0; i < 19; i++) await observe(60);
  f.advance(60);
  const boundary = (s) => observeSecondaryApprovals(s, [{ voucherId: "v1", devices: [], observation: {
    startedAt: f.now().toISOString(), completedAt: f.now().toISOString(), bootAt: "2029-12-01T00:00:00Z" } }], f.now(), { processStartedAt: boot, readStartedAt: f.now() });
  await assert.rejects(store.transaction((s) => { boundary(s); throw Error("synthetic crash before expiry commit"); }));
  assert.equal((await initial.snapshot()).wifiDeviceGrants[0].status, "approved");
  await Promise.all([store.transaction(boundary), initial.transaction(boundary)]);
  assert.equal((await store.snapshot()).routerCommands.filter((c) => c.kind === "wifi_approval_expiry").length, 1);
  const g = (await store.snapshot()).wifiDeviceGrants[0]; assert.equal(g.status, "revoked");
  let release, started, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; }), ready = new Promise((resolve) => { started = resolve; });
  const router = { async revokeWifiDevice() { calls++; started(); await gate; return { confirmed: true, outcome: "revoked" }; } };
  const first = createRouterCommandProcessor({ store, router, now: f.now }), second = createRouterCommandProcessor({ store: initial, router, now: f.now });
  const running = first.process(g.revocationCommandId);
  await ready;
  try { assert.equal((await second.process(g.revocationCommandId)).idle, true); } finally { release(); }
  await running;
  const persisted = (await initial.snapshot()).wifiDeviceGrants[0];
  assert.equal(calls, 1); assert.equal(persisted.expiries.length, 1); assert.ok(persisted.expiries[0].routerConfirmedAt);
  // A lost completion transaction retains the durable lease/barrier. After
  // restart a retry confirms idempotent cleanup without a second event.
  await store.transaction((s) => { const grant = s.wifiDeviceGrants[0], job = s.routerCommands.find((c) => c.id === g.revocationCommandId);
    delete grant.revocationConfirmedAt; delete grant.expiries[0].routerConfirmedAt; job.status = "queued"; job.nextAttemptAt = f.now().toISOString(); });
  const failing = { snapshot: () => store.snapshot(), transaction: (fn) => store.transaction(async (s) => {
    const result = await fn(s); if (s.routerCommands.some((c) => c.id === g.revocationCommandId && c.status === "processed")) throw Error("synthetic completion rollback"); return result;
  }) };
  await assert.rejects(createRouterCommandProcessor({ store: failing, router, now: f.now }).process(g.revocationCommandId), /completion rollback/);
  assert.equal((await initial.snapshot()).routerCommands.find((c) => c.id === g.revocationCommandId).status, "processing");
  f.advance(31); await second.process(g.revocationCommandId);
  assert.equal((await initial.snapshot()).wifiDeviceGrants[0].expiries.length, 1);
  assert.ok((await initial.snapshot()).wifiDeviceGrants[0].expiries[0].routerConfirmedAt);
});
