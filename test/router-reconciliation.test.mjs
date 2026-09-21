import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { createRouterReconciler, routerReconciliationConfig } from "../lib/router-reconciliation.mjs";
import { enqueueRouterCommand } from "../lib/router-queue.mjs";

const baseTime = new Date("2026-09-21T12:00:00Z");
const voucher = (overrides = {}) => ({
  id: "v1", customerId: "c1", planId: "weekly", code: "NC-ABCD-2345",
  status: "active", activatedAt: baseTime.toISOString(),
  expiresAt: new Date(+baseTime + 3600000).toISOString(),
  quotaBytes: 1000, usedBytes: 0, deviceLimit: 1, ...overrides,
});

test("reconciliation config defaults off outside production and reads env overrides", () => {
  assert.equal(routerReconciliationConfig({ NODE_ENV: "test" }).enabled, false);
  assert.equal(routerReconciliationConfig({ NODE_ENV: "production" }).enabled, true);
  assert.equal(routerReconciliationConfig({ NODE_ENV: "production", BOOTSTRAP_MODE: "true" }).enabled, false);
  assert.equal(routerReconciliationConfig({ NODE_ENV: "test", NETWORK_RECONCILIATION_ENABLED: "true" }).enabled, true);
  assert.equal(routerReconciliationConfig({ NODE_ENV: "production", NETWORK_RECONCILIATION_ENABLED: "false" }).enabled, false);
});

test("a voucher active locally but missing on the router is reported and repaired with a durable sync", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher()); });
  const reconcile = createRouterReconciler({
    store, now: () => baseTime,
    router: { readState: async () => ({ vouchers: [], sessions: [] }) },
  });
  const result = await reconcile();
  assert.equal(result.issues, 1);
  const s = await store.snapshot();
  assert.equal(s.vouchers[0].networkReconciliation.issue, "missing_on_router");
  assert.equal(s.routerCommands.length, 1);
  assert.equal(s.routerCommands[0].action, "sync_voucher");
  assert.equal(s.routerCommands[0].targetId, "v1");
  assert.ok(s.events.some((e) => e.type === "network.reconciliation_issue" && e.meta.voucherId === "v1"));
});

test("a revoked voucher still enabled on the router is reported and disconnected, then resolution is logged", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher({ status: "revoked" })); });
  let enabled = true;
  const reconcile = createRouterReconciler({
    store, now: () => baseTime,
    router: { readState: async () => ({ vouchers: [{ voucherId: "v1", enabled }], sessions: [] }) },
  });
  await reconcile();
  let s = await store.snapshot();
  assert.equal(s.vouchers[0].networkReconciliation.issue, "still_enabled_on_router");
  assert.equal(s.routerCommands[0].action, "disconnect_voucher");
  enabled = false;
  await reconcile();
  s = await store.snapshot();
  assert.equal(s.vouchers[0].networkReconciliation.issue, null);
  assert.ok(s.events.some((e) => e.type === "network.reconciliation_resolved" && e.meta.voucherId === "v1"));
});

test("a dead-lettered command is left alone rather than silently reset, so its alert is not suppressed on the next pass", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.vouchers.push(voucher());
    enqueueRouterCommand(s, { action: "sync_voucher", targetId: "v1" }, () => baseTime);
    Object.assign(s.routerCommands[0], { status: "dead_letter", attempts: 8, totalAttempts: 8,
      deadLetteredAt: baseTime.toISOString(), lastError: "router unreachable" });
  });
  const reconcile = createRouterReconciler({
    store, now: () => baseTime,
    router: { readState: async () => ({ vouchers: [], sessions: [] }) },
  });
  await reconcile();
  const s = await store.snapshot();
  assert.equal(s.routerCommands.length, 1);
  assert.equal(s.routerCommands[0].status, "dead_letter", "reconciliation must not requeue a command awaiting operator replay");
  assert.equal(s.routerCommands[0].attempts, 8);
  assert.equal(s.vouchers[0].networkReconciliation.issue, "missing_on_router");
});

test("a session already handled by an in-flight disconnect command is not reported twice", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.sessions.push({ id: "sess1", voucherId: "v1", deviceId: "device-1", status: "disconnected" });
    enqueueRouterCommand(s, { action: "disconnect_device", targetId: "device-1" }, () => baseTime);
  });
  const reconcile = createRouterReconciler({
    store, now: () => baseTime,
    router: { readState: async () => ({ vouchers: [], sessions: [{ deviceId: "device-1", active: true }] }) },
  });
  await reconcile();
  const s = await store.snapshot();
  assert.equal(s.routerCommands.length, 1, "the existing in-flight command must not be duplicated");
});

test("a session the router no longer has active is corrected locally without a network command", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.sessions.push({ id: "sess1", voucherId: "v1", deviceId: "device-1", status: "online" });
  });
  const reconcile = createRouterReconciler({
    store, now: () => baseTime,
    router: { readState: async () => ({ vouchers: [], sessions: [] }) },
  });
  const result = await reconcile();
  assert.equal(result.issues, 1);
  const s = await store.snapshot();
  assert.equal(s.sessions[0].status, "inactive");
  assert.equal(s.routerCommands.length, 0, "nothing to tell the router, it already agrees");
});

test("a matched voucher and session produce no findings and no commands", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.vouchers.push(voucher());
    s.sessions.push({ id: "sess1", voucherId: "v1", deviceId: "device-1", status: "online" });
  });
  const reconcile = createRouterReconciler({
    store, now: () => baseTime,
    router: { readState: async () => ({
      vouchers: [{ voucherId: "v1", enabled: true }],
      sessions: [{ deviceId: "device-1", active: true }],
    }) },
  });
  const result = await reconcile();
  assert.equal(result.issues, 0);
  const s = await store.snapshot();
  assert.equal(s.vouchers[0].networkReconciliation.issue, null);
  assert.equal(s.routerCommands.length, 0);
});

test("an adapter without readState is skipped rather than treated as total drift", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher()); });
  const reconcile = createRouterReconciler({ store, now: () => baseTime, router: {} });
  const result = await reconcile();
  assert.equal(result.skipped, true);
  const s = await store.snapshot();
  assert.equal(s.vouchers[0].networkReconciliation, undefined);
  assert.equal(s.routerCommands.length, 0);
});

test("concurrent reconciliation passes coalesce into one run", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher()); });
  let calls = 0;
  const reconcile = createRouterReconciler({
    store, now: () => baseTime,
    router: { readState: async () => { calls++; return { vouchers: [], sessions: [] }; } },
  });
  await Promise.all([reconcile(), reconcile(), reconcile()]);
  assert.equal(calls, 1);
});
