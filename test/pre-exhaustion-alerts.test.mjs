import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { enqueueRouterCommand, createRouterCommandProcessor } from "../lib/router-queue.mjs";
import { recordUsageAlerts, createUsageAlertSender, usageAllocation } from "../lib/usage-alerts.mjs";
import { dataWarning, formatDataBalance } from "../shared-app/data-usage.js";
import { notificationItems } from "../lib/notifications.mjs";
const now = () => new Date("2030-01-01T12:00:00Z");
const voucher = (overrides = {}) => ({ id: "v", customerId: "c", status: "active", quotaBytes: 1e9, usedBytes: 0, activatedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-02-01T00:00:00Z", ...overrides });

test("90 percent and a positive 2MB balance warn without exhausting or reducing usable quota", () => {
  const v = voucher({ usedBytes: 899999999 }); assert.equal(recordUsageAlerts(v, now), false);
  v.usedBytes = 900000000; assert.equal(recordUsageAlerts(v, now), true); assert.equal(v.usageAlerts[90].status, "pending");
  v.usedBytes = 998000000; assert.equal(recordUsageAlerts(v, now), true); assert.equal(v.usageAlerts.low.status, "pending");
  assert.equal(v.usageAlerts.low.remainingBytes, 2000000); assert.equal(v.usageAlerts[90].status, "superseded");
  assert.equal(v.status, "active"); assert.equal(v.quotaBytes, 1e9); assert.equal(v.usageAlerts[100], undefined); assert.equal(recordUsageAlerts(v, now), false);
});

test("counter jumps record only the highest useful pending warning and zero never claims remaining 2MB", () => {
  const low = voucher({ usedBytes: 999000000 }); recordUsageAlerts(low, now);
  assert.equal(low.usageAlerts[90].status, "skipped"); assert.equal(low.usageAlerts.low.status, "pending");
  const empty = voucher({ usedBytes: 1e9 }); recordUsageAlerts(empty, now);
  assert.equal(empty.usageAlerts[100].status, "pending"); assert.equal(empty.usageAlerts.low, undefined);
  assert.equal(dataWarning(empty), "100");
});

test("small balances stay meaningful in decimal MB and unlimited bundles create no quota warning", () => {
  assert.equal(formatDataBalance(2000000), "2 MB"); assert.equal(formatDataBalance(1000), "0.001 MB"); assert.equal(formatDataBalance(1), "<0.001 MB"); assert.equal(formatDataBalance(0), "0 MB");
  const unlimited = voucher({ quotaBytes: null, usedBytes: 2e12 }); assert.equal(recordUsageAlerts(unlimited, now), false); assert.equal(dataWarning(unlimited), null);
  const small = voucher({ quotaBytes: 1000000, usedBytes: 1 }); recordUsageAlerts(small, now); assert.equal(small.usageAlerts.low.status, "pending"); assert.equal(small.status, "active");
});

test("renewing a reused voucher record creates a fresh allocation and preserves old history with distinct IDs", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c" }); const v = voucher({ usedBytes: 998000000 }); s.vouchers.push(v); recordUsageAlerts(v, now);
  });
  const first = notificationItems(await store.snapshot(), { type: "customer", id: "c" }, now()).find((n) => n.title === "Low-data warning");
  await store.transaction((s) => { const v = s.vouchers[0]; v.usedBytes = 0; v.expiresAt = "2030-03-01T00:00:00Z"; v.activatedAt = now().toISOString(); recordUsageAlerts(v, now); v.usedBytes = 998000000; recordUsageAlerts(v, now); });
  const s = await store.snapshot(), low = notificationItems(s, { type: "customer", id: "c" }, now()).filter((n) => n.title === "Low-data warning");
  assert.equal(low.length, 2); assert.equal(new Set(low.map((n) => n.id)).size, 2); assert.ok(low.some((n) => n.id === first.id));
  assert.equal(s.vouchers[0].usageAlertCycle, usageAllocation(s.vouchers[0]));
});

async function senderFixture() {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c", pushSubscriptions: [{ endpoint: "https://fcm.googleapis.com/fixture", keys: { p256dh: "fixture", auth: "fixture" } }] });
    s.vouchers.push(voucher({ usedBytes: 998000000, lastUsageSyncAt: now().toISOString() })); recordUsageAlerts(s.vouchers[0], now);
  });
  return store;
}
const config = { enabled: true, subject: "mailto:fixture@example.test", publicKey: "fixture", privateKey: "fixture" };

test("critical delivery is shared, short lived, consent scoped and deduplicated by allocation", async () => {
  const store = await senderFixture(), calls = [], send = async (_s, text, options) => calls.push({ payload: JSON.parse(text), options });
  await Promise.all([createUsageAlertSender({ store, config, now, send })(), createUsageAlertSender({ store, config, now, send })()]);
  assert.equal(calls.length, 1); assert.match(calls[0].payload.body, /2 MB left/); assert.equal(calls[0].payload.url, "/dashboard#bundles"); assert.equal(calls[0].options.TTL, 60);
  assert.doesNotMatch(JSON.stringify(calls), /NC-|pin|code|customerId/);
});

test("pending warnings from the superseded 50/75 percent policy are cancelled without sending", async () => {
  const store = await senderFixture(), calls = [];
  await store.transaction((s) => { delete s.vouchers[0].usageAlertCycle; s.vouchers[0].usedBytes = 750000000; s.vouchers[0].usageAlerts = { 50: { status: "pending" }, 75: { status: "pending" } }; });
  await createUsageAlertSender({ store, config, now, send: async (...args) => calls.push(args) })();
  assert.equal(calls.length, 0); assert.equal((await store.snapshot()).vouchers[0].usageAlerts[75].status, "cancelled");
});

for (const [label, change] of [
  ["renewed allocation", (s) => { s.vouchers[0].expiresAt = "2030-03-01T00:00:00Z"; s.vouchers[0].usedBytes = 0; }],
  ["already exhausted", (s) => { s.vouchers[0].usedBytes = 1e9; }],
  ["stale confirmed reading", (s) => { s.vouchers[0].lastUsageSyncAt = "2030-01-01T11:50:00Z"; }],
  ["disabled usage consent", (s) => { s.notificationStates.push({ id: "preferences:customer:c", actor: "customer:c", usagePush: false }); }],
]) test(`delayed critical push is cancelled for ${label}`, async () => {
  const actual = await senderFixture(), calls = [];
  const store = { snapshot: async () => { const old = await actual.snapshot(); await actual.transaction(change); return old; }, transaction: (...args) => actual.transaction(...args) };
  await createUsageAlertSender({ store, config, now, send: async (...args) => calls.push(args) })(); assert.equal(calls.length, 0);
});

test("router shared usage warns at 2MB while every remaining byte remains usable; only zero queues disconnection", async () => {
  const store = createStore({ persistent: false }); let usedBytes = 998000000;
  await store.transaction((s) => { s.customers.push({ id: "c" }); s.vouchers.push(voucher({ deviceLimit: 2 })); enqueueRouterCommand(s, { action: "sync_usage" }, now); });
  const processor = createRouterCommandProcessor({ store, now, router: { readUsage: async () => [{ voucherId: "v", usedBytes, devices: [] }] } });
  await processor.process(); let s = await store.snapshot(); assert.equal(s.vouchers[0].status, "active"); assert.equal(s.routerCommands.some((c) => c.action === "disconnect_voucher"), false);
  assert.equal(s.vouchers[0].usageAlerts.low.remainingBytes, 2000000);
  usedBytes = 1e9; await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, now)); await processor.process("router:sync_usage:global");
  s = await store.snapshot(); assert.equal(s.vouchers[0].status, "exhausted"); assert.equal(s.vouchers[0].usageAlerts[100].status, "pending"); assert.equal(s.routerCommands.some((c) => c.action === "disconnect_voucher"), true);
});
