// Usage tracking survives the router's counters restarting (reboot, power cut, a
// re-created hotspot user) and failed usage reads. Before, recorded usage froze
// until the new counters passed it, the router allowed the whole quota again,
// and a usage read that failed for about an hour stopped all counting until an
// operator replayed it.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { createRouterCommandProcessor, enqueueRouterCommand } from "../lib/router-queue.mjs";
import { createUsageSyncScheduler, usageReadCooldownMs } from "../lib/router-reconciliation.mjs";
import { routerVoucherPayload } from "../lib/routeros.mjs";
import { RouterHotspot } from "../lib/router-hotspot.mjs";

const start = new Date("2030-08-01T10:00:00Z");
const voucher = (extra = {}) => ({ id: "v1", customerId: "c1", planId: "weekly", code: "NC-ABCD-2345", status: "active",
  activatedAt: start.toISOString(), expiresAt: new Date(+start + 7 * 864e5).toISOString(), quotaBytes: 5000, usedBytes: 0, deviceLimit: 2, ...extra });

// One usage read per call to read(), at the given second, returning these router readings.
async function fixture(initial) {
  let now = start, readings = [];
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher(initial)); });
  const processor = createRouterCommandProcessor({ store, now: () => now, router: { readUsage: async () => readings } });
  const read = async (seconds, reading) => {
    now = new Date(+start + seconds * 1000);
    readings = [{ voucherId: "v1", devices: [], ...reading }];
    await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, () => now));
    await processor.process();
    return (await store.snapshot()).vouchers[0];
  };
  return { store, read };
}

test("usage keeps counting across a router counter restart, and the router gets only the data left", async () => {
  const f = await fixture();
  let v = await f.read(0, { usedBytes: 1500, counterBytes: 1200 });
  assert.deepEqual([v.usedBytes, v.routerCounter.bytes], [1500, 1200]);
  // The router rebooted: its counters start again from zero.
  v = await f.read(60, { usedBytes: 200, counterBytes: 0 });
  assert.equal(v.usedBytes, 1700, "usage before the restart is kept and new usage is added");
  assert.equal(v.routerUsageOffset, 1500);
  assert.equal(v.routerCountersRestartedAt, new Date(+start + 60000).toISOString());
  const s = await f.store.snapshot();
  assert.ok(s.routerCommands.some((c) => c.id === "router:sync_voucher:v1" && c.status === "queued"), "the router's limit is refreshed");
  assert.equal(routerVoucherPayload(v).limitBytesTotal, 5000 - 1500, "the router allows only what is left");
  assert.ok(s.events.some((e) => e.type === "network.usage_counters_restarted" && e.meta.voucherId === "v1"));
  // Later readings count on from there, up to the quota.
  v = await f.read(120, { usedBytes: 900, counterBytes: 900 });
  assert.equal(v.usedBytes, 2400);
  v = await f.read(180, { usedBytes: 3600, counterBytes: 3600 });
  assert.deepEqual([v.usedBytes, v.status], [5100, "exhausted"]);
});

test("one lower reading (a session ending between the router's two reads) is not a restart", async () => {
  const f = await fixture();
  await f.read(0, { usedBytes: 1500, counterBytes: 1000 });
  let v = await f.read(60, { usedBytes: 1000, counterBytes: 1000 });
  assert.equal(v.usedBytes, 1500, "a brief dip never lowers recorded usage");
  assert.equal(v.routerUsageOffset, undefined);
  assert.ok(v.routerCounter.lowerSince);
  // The ended session reaches the user's counters: the reading recovers.
  v = await f.read(120, { usedBytes: 1600, counterBytes: 1600 });
  assert.deepEqual([v.usedBytes, v.routerUsageOffset, v.routerCounter.lowerSince], [1600, undefined, undefined], "nothing counted twice");
});

test("counters that restarted before this check existed are found when readings stay lower", async () => {
  // Recorded usage is 3000 but the router restarted earlier and now reports 400.
  const f = await fixture({ usedBytes: 3000 });
  let v = await f.read(0, { usedBytes: 400, counterBytes: 400 });
  assert.equal(v.usedBytes, 3000, "a first lower reading waits");
  v = await f.read(30, { usedBytes: 450, counterBytes: 450 });
  assert.equal(v.usedBytes, 3000, "still under 45 seconds");
  v = await f.read(60, { usedBytes: 500, counterBytes: 500 });
  assert.deepEqual([v.usedBytes, v.routerUsageOffset], [3500, 3000], "usage since the restart is added");
  // Without the router's own counters (an older bridge), the same rule applies.
  const g = await fixture({ usedBytes: 3000 });
  await g.read(0, { usedBytes: 100 });
  v = await g.read(60, { usedBytes: 150 });
  assert.equal(v.usedBytes, 3150);
});

test("a router usage offset is validated and lowers the router limit", () => {
  assert.equal(routerVoucherPayload(voucher({ usedBytes: 2000, routerUsageOffset: 1500 })).limitBytesTotal, 3500);
  assert.equal(routerVoucherPayload(voucher({ usedBytes: 6000, routerUsageOffset: 6000 })).limitBytesTotal, 0);
  assert.equal(routerVoucherPayload(voucher({ quotaBytes: null, usedBytes: 2000, routerUsageOffset: 1500 })).limitBytesTotal, null);
  for (const routerUsageOffset of [-1, 1.5, 2001]) {
    assert.throws(() => routerVoucherPayload(voucher({ usedBytes: 2000, routerUsageOffset })), /Router usage offset is invalid/);
  }
  assert.throws(() => routerVoucherPayload(voucher({ usedBytes: 2000, directUsageOffset: 1500, routerUsageOffset: 600 })), /Router usage offset is invalid/);
});

test("a failing usage read retries at most every five minutes, and resumes by itself after dead-lettering", async () => {
  let now = start;
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.vouchers.push(voucher()); s.networkSetup = { runtimeRouterEnabled: true }; });
  const processor = createRouterCommandProcessor({ store, now: () => now, maxAttempts: 8, router: { readUsage: async () => { throw Error("router unreachable"); } } });
  const schedule = createUsageSyncScheduler({ store, now: () => now });
  assert.equal((await schedule()).queued, true);
  const waits = [];
  for (let attempt = 1; attempt <= 8; attempt++) {
    await processor.process();
    const command = (await store.snapshot()).routerCommands[0];
    if (command.status === "retry") { waits.push((Date.parse(command.nextAttemptAt) - +now) / 1000); now = new Date(command.nextAttemptAt); }
  }
  assert.deepEqual(waits, [30, 60, 120, 240, 300, 300, 300]);
  let command = (await store.snapshot()).routerCommands[0];
  assert.equal(command.status, "dead_letter");
  // Nothing re-queues it during the cool-down...
  now = new Date(+now + usageReadCooldownMs - 1000);
  assert.equal((await schedule()).queued, false);
  // ...then the next scheduled read tries again with a fresh set of attempts.
  now = new Date(+now + 2000);
  assert.equal((await schedule()).queued, true);
  const s = await store.snapshot();
  command = s.routerCommands[0];
  assert.deepEqual([command.status, command.attempts], ["queued", 0]);
  assert.ok(s.events.some((e) => e.type === "network.usage_read_resumed"));
  // Other commands keep the hour-long ceiling.
  const other = createStore({ persistent: false });
  await other.transaction((s) => { s.vouchers.push(voucher()); enqueueRouterCommand(s, { action: "sync_voucher", targetId: "v1" }, () => start); });
  let at = start;
  const failing = createRouterCommandProcessor({ store: other, now: () => at, router: { syncVoucher: async () => { throw Error("down"); } } });
  for (let i = 0; i < 7; i++) { await failing.process(); const c = (await other.snapshot()).routerCommands[0]; if (c.nextAttemptAt) at = new Date(c.nextAttemptAt); }
  const sync = (await other.snapshot()).routerCommands[0];
  assert.equal((Date.parse(sync.nextAttemptAt) - +at) / 1000 >= 0, true);
  assert.ok(sync.attempts === 7 && Date.parse(sync.nextAttemptAt) - Date.parse(sync.lastAttemptAt) === 1920000, "sync_voucher still backs off to 32 minutes");
});

test("the router adapter reports each user's own counters beside the live total", async () => {
  const rows = {
    "ip/hotspot/user": [{ name: "NC-ABCD-2345", comment: "ndahi:voucher:v1", "bytes-in": "300", "bytes-out": "200" },
      { name: "staff", comment: "not ours", "bytes-in": "9", "bytes-out": "9" }],
    "ip/hotspot/active": [{ user: "NC-ABCD-2345", "mac-address": "aa:bb:cc:dd:ee:01", address: "10.20.0.5", uptime: "5m", "bytes-in": "40", "bytes-out": "60", ".id": "*1" }],
    "ip/dhcp-server/lease": [],
  };
  class Fake extends RouterHotspot { async request(path) { return rows[path] || []; } }
  const [reading] = await new Fake({ now: () => start }).readUsage();
  assert.deepEqual([reading.voucherId, reading.usedBytes, reading.counterBytes], ["v1", 600, 500]);
  assert.equal(reading.devices[0].usedBytes, 100);
});
