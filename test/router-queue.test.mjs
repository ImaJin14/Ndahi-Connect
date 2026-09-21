import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import {
  createRouterCommandProcessor,
  enqueueRouterCommand,
  routerQueueSummary,
  scheduleRouterCommandReplay,
} from "../lib/router-queue.mjs";

const baseTime = new Date("2026-09-21T12:00:00Z");
const voucher = (overrides = {}) => ({
  id: "v1", customerId: "c1", planId: "weekly", code: "NC-ABCD-2345",
  status: "active", activatedAt: baseTime.toISOString(),
  expiresAt: new Date(+baseTime + 3600000).toISOString(),
  quotaBytes: 1000, usedBytes: 0, deviceLimit: 1, ...overrides,
});

test("enqueue is idempotent for an unresolved command and requeues a resolved one for a fresh cycle", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher()); });
  const first = await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_voucher", targetId: "v1" }, () => baseTime));
  const second = await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_voucher", targetId: "v1" }, () => baseTime));
  assert.equal(first.id, second.id);
  assert.equal((await store.snapshot()).routerCommands.length, 1);
  const processor = createRouterCommandProcessor({ store, now: () => baseTime,
    router: { syncVoucher: async () => {} } });
  await processor.process(first.id);
  assert.equal((await store.snapshot()).routerCommands[0].status, "processed");
  const requeued = await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_voucher", targetId: "v1" }, () => baseTime));
  assert.equal(requeued.id, first.id);
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.attempts, 0);
});

test("a synced or disconnected voucher records status; a failing command retries with bounded exponential backoff", async () => {
  let time = baseTime, fail = true;
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher()); });
  await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_voucher", targetId: "v1" }, () => time));
  const processor = createRouterCommandProcessor({ store, now: () => time, maxAttempts: 100,
    router: { syncVoucher: async () => { if (fail) throw new Error("router unreachable"); } } });
  await processor.process();
  let s = await store.snapshot();
  assert.equal(s.routerCommands[0].status, "retry");
  assert.equal(s.vouchers[0].routerSyncStatus, "pending");
  assert.equal(s.vouchers[0].routerError, "router unreachable");
  const backoffs = [];
  for (let i = 0; i < 4; i++) {
    const before = Date.parse((await store.snapshot()).routerCommands[0].nextAttemptAt);
    time = new Date(before);
    await processor.process();
    backoffs.push(Date.parse((await store.snapshot()).routerCommands[0].nextAttemptAt) - before);
  }
  assert.deepEqual(backoffs, [60000, 120000, 240000, 480000]);
  // Many more failures cap the delay instead of growing unbounded.
  for (let i = 0; i < 10; i++) {
    time = new Date((await store.snapshot()).routerCommands[0].nextAttemptAt);
    await processor.process();
  }
  const capped = await store.snapshot();
  assert.equal(Date.parse(capped.routerCommands[0].nextAttemptAt) - +time, 3600000);
  fail = false;
  time = new Date(capped.routerCommands[0].nextAttemptAt);
  await processor.process();
  s = await store.snapshot();
  assert.equal(s.routerCommands[0].status, "processed");
  assert.equal(s.vouchers[0].routerSyncStatus, "synchronized");
  assert.equal(s.vouchers[0].routerError, undefined);
});

test("a claim that never reaches the completion transaction survives a restart and recovers once its lease expires", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ndahi-router-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.json"), store = createStore({ file });
  await store.transaction((s) => { s.vouchers.push(voucher()); });
  // Simulate a worker that claimed the command (set status/lease) and then
  // crashed before the network call or completion transaction ran.
  const claim = await store.transaction((s) => {
    const command = enqueueRouterCommand(s, { action: "sync_voucher", targetId: "v1" }, () => baseTime);
    command.status = "processing";
    command.attempts = 1;
    command.totalAttempts = 1;
    command.leaseToken = "stuck-worker";
    command.leaseUntil = new Date(+baseTime + 60000).toISOString();
    return command;
  });
  const restarted = createStore({ file });
  assert.equal((await restarted.snapshot()).routerCommands[0].status, "processing");
  const stillLeased = createRouterCommandProcessor({ store: restarted, now: () => baseTime,
    router: { syncVoucher: async () => { throw new Error("must not run before the lease expires"); } } });
  assert.deepEqual(await stillLeased.process(claim.id), { idle: true });
  const afterLease = createRouterCommandProcessor({ store: restarted, now: () => new Date(+baseTime + 61000),
    router: { syncVoucher: async () => {} } });
  await afterLease.process(claim.id);
  const snapshot = await restarted.snapshot();
  assert.equal(snapshot.routerCommands[0].status, "processed");
  assert.equal(snapshot.vouchers[0].routerSyncStatus, "synchronized");
});

test("expiry and quota exhaustion enqueue durable disconnect commands instead of blocking on the router", async (t) => {
  let routerCalls = 0, release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const router = {
    syncVoucher: async () => {},
    disconnectVoucher: async () => { routerCalls++; await blocked; },
    disconnectDevice: async () => {},
    markInactive: async () => {},
  };
  const store = createStore({ persistent: false });
  const server = createServer({
    store, router, now: () => baseTime, validateConfig: false,
    env: { NODE_ENV: "test", BOOTSTRAP_MODE: "false", PAYMENT_MODE: "mock",
      ADMIN_SESSION_SECRET: "test-admin-secret", NETWORK_QUEUE_ENABLED: "false" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { release(); return new Promise((resolve) => server.close(resolve)); });
  await store.transaction((s) => {
    s.customers.push({ id: "c1", phone: "670000001", name: "Customer" });
    s.vouchers.push(voucher({ expiresAt: new Date(+baseTime - 1000).toISOString() }));
  });
  // Any mutate() call runs clean(), which used to await the router directly;
  // it must now enqueue and return immediately even though the router hangs.
  const start = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/plans`);
  assert.equal(response.status, 200);
  assert.ok(Date.now() - start < 1000, "clean() must not block on a hanging router call");
  assert.equal(routerCalls, 0, "the disconnect must not fire inline during the request");
  const s = await store.snapshot();
  assert.equal(s.vouchers[0].status, "expired");
  assert.equal(s.routerCommands.length, 1);
  assert.equal(s.routerCommands[0].action, "disconnect_voucher");
});

test("server startup drains router commands enqueued before a restart", async (t) => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.vouchers.push(voucher());
    enqueueRouterCommand(s, { action: "sync_voucher", targetId: "v1" }, () => baseTime);
  });
  const router = { syncVoucher: async () => {}, disconnectVoucher: async () => {},
    disconnectDevice: async () => {}, markInactive: async () => {}, readUsage: async () => [] };
  const server = createServer({
    store, router, now: () => baseTime, validateConfig: false,
    env: { NODE_ENV: "test", BOOTSTRAP_MODE: "false", PAYMENT_MODE: "mock",
      ADMIN_SESSION_SECRET: "test-admin-secret", PAYMENT_WEBHOOK_REPLAY_ENABLED: "false",
      NETWORK_QUEUE_INTERVAL_SECONDS: "3600" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (let i = 0; i < 100 && (await store.snapshot()).routerCommands[0].status !== "processed"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await store.snapshot()).routerCommands[0].status, "processed");
  assert.equal((await store.snapshot()).vouchers[0].routerSyncStatus, "synchronized");
});

test("a command that keeps failing dead-letters after its attempt limit, alerts once, and can be replayed by an operator", async (t) => {
  let time = baseTime;
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher()); });
  await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_voucher", targetId: "v1" }, () => time));
  const alerts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { alerts.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  t.after(() => { globalThis.fetch = originalFetch; });
  const processor = createRouterCommandProcessor({ store, now: () => time, maxAttempts: 3,
    alertWebhookUrl: "https://hooks.example/alert",
    router: { syncVoucher: async () => { throw new Error("router unreachable"); } } });
  for (let i = 0; i < 3; i++) {
    time = new Date((await store.snapshot()).routerCommands[0]?.nextAttemptAt || time);
    await processor.process();
  }
  const s = await store.snapshot();
  assert.equal(s.routerCommands[0].status, "dead_letter");
  assert.equal(s.routerCommands[0].attempts, 3);
  assert.equal(s.routerCommands[0].nextAttemptAt, null);
  assert.ok(s.routerCommands[0].deadLetteredAt);
  assert.equal(s.vouchers[0].routerSyncStatus, "dead_letter");
  assert.equal(alerts.length, 1, "exactly one alert must fire, on the transition into dead_letter");
  assert.match(alerts[0].body.text, /sync_voucher/);
  assert.match(alerts[0].body.text, /v1/);
  assert.equal(alerts[0].url, "https://hooks.example/alert");
  const summary = routerQueueSummary(s);
  assert.equal(summary.deadLetters, 1);
  assert.equal(summary.commands[0].status, "dead_letter");
  await store.transaction((s) => {
    const replay = scheduleRouterCommandReplay(s, s.routerCommands[0].id, () => time);
    assert.equal(replay.status, 202);
  });
  const replayed = await store.snapshot();
  assert.equal(replayed.routerCommands[0].status, "queued");
  assert.equal(replayed.routerCommands[0].attempts, 0);
  assert.equal(replayed.routerCommands[0].totalAttempts, 3);
  assert.equal(replayed.routerCommands[0].replays, 1);
});

test("a missing voucher is a permanent failure that dead-letters on the first attempt", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_voucher", targetId: "missing" }, () => baseTime));
  const processor = createRouterCommandProcessor({ store, now: () => baseTime,
    router: { syncVoucher: async () => { throw new Error("must not be called"); } } });
  await processor.process();
  const s = await store.snapshot();
  assert.equal(s.routerCommands[0].status, "dead_letter");
  assert.equal(s.routerCommands[0].attempts, 1);
  assert.equal(s.routerCommands[0].lastError, "voucher_not_found");
});

test("replay is rejected for a healthy command and for one that does not exist", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => enqueueRouterCommand(s, { action: "disconnect_device", targetId: "device-1" }, () => baseTime));
  await store.transaction((s) => {
    assert.equal(scheduleRouterCommandReplay(s, s.routerCommands[0].id, () => baseTime).status, 409);
    assert.equal(scheduleRouterCommandReplay(s, "router:disconnect_device:missing", () => baseTime).status, 404);
  });
});

test("alert delivery failure never blocks the completion transaction", async (t) => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => enqueueRouterCommand(s, { action: "disconnect_device", targetId: "device-1" }, () => baseTime));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("alert endpoint unreachable"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const processor = createRouterCommandProcessor({ store, now: () => baseTime, maxAttempts: 1,
    alertWebhookUrl: "https://hooks.example/alert",
    router: { disconnectDevice: async () => { throw new Error("router unreachable"); } } });
  const outcome = await processor.process();
  assert.equal(outcome.deadLettered, true);
  const s = await store.snapshot();
  assert.equal(s.routerCommands[0].status, "dead_letter");
});

test("HTTP replay endpoint enforces operator role, production CSRF, and records an audit entry", async (t) => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    enqueueRouterCommand(s, { action: "disconnect_device", targetId: "device-1" }, () => baseTime);
    s.routerCommands[0].status = "dead_letter";
    s.routerCommands[0].deadLetteredAt = baseTime.toISOString();
    for (const role of ["owner", "operator", "auditor", "reseller"]) s.adminSessions.push({
      tokenHash: hashSecret(role, "test-admin-secret"), role, csrfToken: "csrf", expiresAt: "2026-09-22T12:00:00Z",
    });
  });
  const server = createServer({
    store, now: () => baseTime, validateConfig: false,
    router: { disconnectDevice: async () => {} },
    env: { NODE_ENV: "production", BOOTSTRAP_MODE: "false", PAYMENT_MODE: "mock",
      ADMIN_SESSION_SECRET: "test-admin-secret", CUSTOMER_APP_URL: "https://customer.test",
      ADMIN_APP_URL: "https://admin.test", ALLOWED_ADMIN_ORIGINS: "https://admin.test",
      PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false",
      NETWORK_RECONCILIATION_ENABLED: "false" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const id = (await store.snapshot()).routerCommands[0].id;
  const replay = (role, csrf = "csrf", origin = "https://admin.test") => fetch(base + "/api/admin/network/commands/replay", {
    method: "POST", headers: { cookie: `admin_session=${role}`, origin, "x-csrf-token": csrf, "content-type": "application/json" },
    body: JSON.stringify({ commandId: id }),
  });
  assert.equal((await replay("owner", "bad")).status, 403);
  assert.equal((await replay("owner", "csrf", "https://evil.test")).status, 403);
  assert.equal((await replay("auditor")).status, 403);
  assert.equal((await replay("reseller")).status, 403);
  assert.equal((await replay("missing")).status, 401);
  assert.equal((await replay("operator")).status, 202);
  assert.equal((await replay("operator")).status, 409);
  const s = await store.snapshot();
  assert.ok(s.auditLogs.some((a) => a.action === "network.command_replay_requested" && a.meta.commandId === id));
  assert.equal(s.routerCommands[0].status, "queued");
});
