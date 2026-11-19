// A bundle's speed limit, shared by all of a customer's devices on it (#263, owner
// decision 19 Nov). Vouchers keep the speed of the plan they were issued from; the
// router applies it as one simple queue per bundle whose targets are the devices
// online now, kept current by the usage sync. Off unless ROUTER_SPEED_LIMITS=on.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { createRouterCommandProcessor, enqueueRouterCommand } from "../lib/router-queue.mjs";
import { RouterHotspot } from "../lib/router-hotspot.mjs";
import { issueSpeedSnapshot, speedQueueTarget } from "../lib/bundle-speed-policy.mjs";
import { giftVoucher } from "../lib/gift-purchase.mjs";

const start = new Date("2030-08-01T10:00:00Z");
const voucher = (extra = {}) => ({ id: "v1", customerId: "c1", planId: "weekly", code: "NC-ABCD-2345", status: "active", activatedAt: start.toISOString(),
  expiresAt: new Date(+start + 7 * 864e5).toISOString(), quotaBytes: 5e9, usedBytes: 0, deviceLimit: 3,
  speedSnapshot: { downloadMbps: 10, uploadMbps: 2 }, ...extra });
const device = (n) => ({ mac: `AA:BB:CC:DD:EE:0${n}`, address: `10.20.0.${n}`, sessionId: `*${n}`, startedAt: start.toISOString(), usedBytes: 0 });

test("the queue target is the bundle's limit and the addresses of its devices online", () => {
  const target = speedQueueTarget(voucher({ wifiDevices: [device(7), device(5), { ...device(5) }, { mac: "AA:BB:CC:DD:EE:09", address: "not-an-ip" }] }));
  assert.deepEqual([target.uploadBps, target.downloadBps, target.addresses, target.limited], [2e6, 10e6, ["10.20.0.5", "10.20.0.7"], true]);
  // No limit, not active, or a Home allocation: no addresses, so no queue.
  assert.deepEqual(speedQueueTarget(voucher({ speedSnapshot: { downloadMbps: null, uploadMbps: null }, wifiDevices: [device(5)] })).addresses, []);
  assert.equal(speedQueueTarget(voucher({ speedSnapshot: undefined, wifiDevices: [device(5)] })).limited, false);
  assert.deepEqual(speedQueueTarget(voucher({ status: "exhausted", wifiDevices: [device(5)] })).addresses, []);
  assert.deepEqual(speedQueueTarget(voucher({ accessMode: "home", wifiDevices: [device(5)] })).addresses, []);
  assert.equal(speedQueueTarget(voucher({ speedSnapshot: { downloadMbps: -4, uploadMbps: 2 } })).limited, false, "an invalid snapshot never limits anyone");
});

test("vouchers keep the speed of the plan they were issued from", () => {
  assert.deepEqual(issueSpeedSnapshot({ downloadMbps: 12.5, uploadMbps: null }), { downloadMbps: 12.5, uploadMbps: null });
  assert.deepEqual(issueSpeedSnapshot({ id: "weekly", price: 1000 }), { downloadMbps: null, uploadMbps: null }, "a plan without limits is unlimited");
  // A paid gift keeps the speed recorded with its payment, not a later catalogue edit.
  const s = { customers: [{ id: "buyer", phone: "670000001" }], vouchers: [], payments: [] };
  const payment = { id: "pay-1", amount: 1000, gift: { recipientPhone: "670000099" }, planSnapshot: { id: "weekly", downloadMbps: 8, uploadMbps: 1 } };
  const v = giftVoucher(s, payment, s.customers[0], { id: "weekly", price: 1000, quotaGb: 5, deviceLimit: 2, validityHours: 168, downloadMbps: 50, uploadMbps: 50 }, start, () => "NC-GIFT-0001");
  assert.deepEqual(v.speedSnapshot, { downloadMbps: 8, uploadMbps: 1 });
});

class FakeRouter extends RouterHotspot {
  constructor(rows = []) { super({ url: "https://router.test", username: "u", password: "p" }); this.rows = rows; this.calls = []; }
  async request(path, method = "GET", body) {
    this.calls.push([method, path, body]);
    if (method === "GET") return this.rows;
    return {};
  }
}

test("the router adapter creates, updates and removes one managed queue per bundle", async () => {
  let router = new FakeRouter();
  await router.syncSpeedQueue({ voucherId: "v1", uploadBps: 2e6, downloadBps: 10e6, addresses: ["10.20.0.5", "10.20.0.7"] });
  assert.deepEqual(router.calls.at(-1), ["PUT", "queue/simple", { name: "ndahi-speed-v1", comment: "ndahi:speed:v1", target: "10.20.0.5/32,10.20.0.7/32", "max-limit": "2000000/10000000" }]);
  router = new FakeRouter([{ ".id": "*A", name: "ndahi-speed-v1", comment: "ndahi:speed:v1" }]);
  await router.syncSpeedQueue({ voucherId: "v1", uploadBps: 2e6, downloadBps: 10e6, addresses: ["10.20.0.5"] });
  assert.deepEqual(router.calls.at(-1).slice(0, 2), ["PATCH", "queue/simple/*A"]);
  await router.syncSpeedQueue({ voucherId: "v1", uploadBps: 2e6, downloadBps: 10e6, addresses: [] });
  assert.deepEqual(router.calls.at(-1).slice(0, 2), ["DELETE", "queue/simple/*A"], "no device online: the queue goes");
  // Never touches a queue NDAHI did not create, and rejects malformed input.
  router = new FakeRouter([{ ".id": "*B", name: "ndahi-speed-v1", comment: "someone else's" }]);
  await assert.rejects(router.syncSpeedQueue({ voucherId: "v1", uploadBps: 1, downloadBps: 1, addresses: ["10.20.0.5"] }), /Conflicting unmanaged queue/);
  assert.equal(router.calls.filter(([method]) => method !== "GET").length, 0);
  for (const bad of [{ voucherId: "v 1", uploadBps: 1, downloadBps: 1, addresses: [] }, { voucherId: "v1", uploadBps: -1, downloadBps: 1, addresses: [] },
    { voucherId: "v1", uploadBps: 1, downloadBps: 1, addresses: ["10.20.0.5; /system reset"] }])
    await assert.rejects(new FakeRouter().syncSpeedQueue(bad), /Invalid bundle speed queue/);
});

async function fixture({ speedLimits, extra } = {}) {
  let now = start, readings = [];
  const store = createStore({ persistent: false }), queues = [];
  await store.transaction((s) => { s.vouchers.push(voucher(extra)); });
  const router = { readUsage: async () => readings, syncSpeedQueue: async (input) => { queues.push(input); return { synchronized: true }; } };
  const processor = createRouterCommandProcessor({ store, now: () => now, router, speedLimits });
  const read = async (devices, seconds) => {
    now = new Date(+start + seconds * 1000);
    readings = [{ voucherId: "v1", usedBytes: 0, counterBytes: 0, devices }];
    await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, () => now));
    while (!(await processor.process()).idle);
    return store.snapshot();
  };
  return { read, queues };
}

test("with ROUTER_SPEED_LIMITS on, the usage sync keeps the shared queue on the devices online", async () => {
  const f = await fixture({ speedLimits: true });
  let s = await f.read([device(5), device(7)], 0);
  assert.deepEqual(f.queues, [{ voucherId: "v1", uploadBps: 2e6, downloadBps: 10e6, addresses: ["10.20.0.5", "10.20.0.7"] }]);
  assert.equal(s.vouchers[0].speedQueue.devices, 2);
  // The same devices: nothing to change.
  await f.read([device(7), device(5)], 60);
  assert.equal(f.queues.length, 1);
  // One leaves, then all leave: the targets follow, and the queue is removed.
  await f.read([device(7)], 120);
  assert.deepEqual(f.queues.at(-1).addresses, ["10.20.0.7"]);
  s = await f.read([], 180);
  assert.deepEqual(f.queues.at(-1).addresses, []);
  assert.equal(s.vouchers[0].speedQueue.devices, 0);
});

test("with the setting off, or for an unlimited bundle, the router queue is never touched", async () => {
  const off = await fixture({ speedLimits: false });
  await off.read([device(5)], 0);
  assert.equal(off.queues.length, 0);
  const unlimited = await fixture({ speedLimits: true, extra: { speedSnapshot: { downloadMbps: null, uploadMbps: null } } });
  const s = await unlimited.read([device(5)], 0);
  assert.equal(unlimited.queues.length, 0);
  assert.equal(s.routerCommands.some((c) => c.action === "sync_speed"), false);
});
