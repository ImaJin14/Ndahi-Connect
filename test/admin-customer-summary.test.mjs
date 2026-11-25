// Customer list summary for the redesigned admin Customers screen: current
// bundle, waiting payment and store order count, read-only and computed once.
import test from "node:test";
import assert from "node:assert/strict";
import { queryRecords } from "../lib/admin-records.mjs";

const state = () => ({
  customers: [
    { id: "c1", name: "Amina", phone: "670000001", status: "active", pinHash: "secret", totpSecret: "secret" },
    { id: "c2", name: "Fon", phone: "670000002", status: "suspended" },
    { id: "c3", name: "Grace", phone: "670000003" },
  ],
  vouchers: [
    // Newest first, as the store keeps them.
    { id: "v-new-expired", customerId: "c1", status: "expired", code: "NC-OLD", planId: "daily", deviceLimit: 1 },
    { id: "v-active", customerId: "c1", status: "active", code: "NC-LIVE", planId: "weekly", quotaBytes: 5e9, usedBytes: 1e9, expiresAt: "2030-01-08T00:00:00Z", deviceLimit: 3 },
    { id: "v-c2-new", customerId: "c2", status: "expired", code: "NC-C2B", planId: "daily", deviceLimit: 1 },
    { id: "v-c2-old", customerId: "c2", status: "revoked", code: "NC-C2A", planId: "weekly", deviceLimit: 1 },
    { id: "v-stock", status: "available", code: "NC-STOCK", planId: "daily" },
  ],
  payments: [
    { id: "p1", customerId: "c3", status: "pending", amount: 1000 },
    { id: "p2", customerId: "c1", status: "paid", amount: 1000 },
  ],
  storeOrders: [{ id: "o1", customerId: "c1" }, { id: "o2", customerId: "c1" }, { id: "o3", customerId: "c2" }],
  sessions: [],
});

const view = (v) => ({ id: v.id, status: v.status, plan: { name: v.planId === "weekly" ? "Weekly" : "Daily" }, quotaBytes: v.quotaBytes ?? null,
  remainingBytes: v.quotaBytes == null ? null : v.quotaBytes - v.usedBytes, usedBytes: v.usedBytes, expiresAt: v.expiresAt ?? null, activeDevices: 2, deviceLimit: v.deviceLimit, code: v.code });

test("each customer row carries its current bundle, waiting payment and store order count", () => {
  const { items } = queryRecords(state(), { collection: "customers" }, { voucherView: view });
  const byId = Object.fromEntries(items.map((c) => [c.id, c]));
  // An active bundle wins over a newer expired one.
  assert.deepEqual(byId.c1.summary, {
    bundle: { id: "v-active", name: "Weekly", status: "active", quotaBytes: 5e9, remainingBytes: 4e9, usedBytes: 1e9, expiresAt: "2030-01-08T00:00:00Z", activeDevices: 2, deviceLimit: 3 },
    paymentWaiting: false, storeOrders: 2,
  });
  // Without an active bundle, the newest one is shown.
  assert.equal(byId.c2.summary.bundle.id, "v-c2-new");
  assert.equal(byId.c2.summary.storeOrders, 1);
  assert.deepEqual(byId.c3.summary, { bundle: null, paymentWaiting: true, storeOrders: 0 });
  // The summary never carries voucher codes, and secrets stay out of the row.
  assert.doesNotMatch(JSON.stringify(items), /NC-LIVE|NC-OLD|"secret"/);
});

test("payments can be found by the customer they belong to", () => {
  const { items } = queryRecords(state(), { collection: "payments", q: "c3" });
  assert.deepEqual(items.map((p) => p.id), ["p1"]);
});

test("device records name their customer", () => {
  const s = { ...state(), vouchers: [{ id: "v-live", customerId: "c1", status: "active", wifiDevices: [{ mac: "AA:BB:CC:DD:EE:01", sessionId: "*1", startedAt: "2030-01-01T07:00:00Z" }], wifiDevicesAt: "2030-01-01T08:00:00Z" }] };
  const { items } = queryRecords(s, { collection: "wifiDevices" }, { now: new Date("2030-01-01T08:00:30Z") });
  assert.equal(items.length, 1);
  assert.equal(items[0].customerName, "Amina");
});

test("audit entries filter by the area of their action", () => {
  const auditLogs = [{ id: "a1", action: "voucher.revoked" }, { id: "a2", action: "payment.refund_requested" }, { id: "a3", action: "voucher.printed" }];
  const { items } = queryRecords({ ...state(), auditLogs }, { collection: "audit", status: "voucher" });
  assert.deepEqual(items.map((a) => a.id), ["a1", "a3"]);
});

// #342 (canvas AdminCustomers): an Unlimited bundle shows time left and device
// slots used / slots; a bundle bought before the switch keeps its own terms.
test("an Unlimited bundle carries its device slots, counting a registered device while offline; earlier bundles are unchanged", async () => {
  const { routerRevision } = await import("../lib/device-identities.mjs");
  const s = state();
  s.customers.push({ id: "c4", name: "Ngwa", phone: "670000004", status: "active" });
  s.vouchers.unshift({ id: "v-unl", customerId: "c4", status: "active", code: "NC-UNL", planId: "unlimited-7d-2", quotaBytes: null, usedBytes: 0, expiresAt: "2030-01-08T00:00:00Z",
    deviceLimit: 2, accessType: "personal_unlimited", deviceSlots: 2, sharing: false });
  s.wifiDeviceGrants = ["AA:AA:AA:AA:AA:01", "AA:AA:AA:AA:AA:02"].map((mac) => ({ id: mac, customerId: "c4", mac, voucherId: "v-unl", status: "approved", routerRevision: routerRevision(s) }));
  const { items } = queryRecords(s, { collection: "customers" }, { voucherView: view });
  const byId = Object.fromEntries(items.map((c) => [c.id, c]));
  assert.deepEqual([byId.c4.summary.bundle.accessType, byId.c4.summary.bundle.deviceSlots, byId.c4.summary.bundle.slotsUsed], ["personal_unlimited", 2, 2]);
  assert.equal(byId.c4.summary.bundle.activeDevices, 2);
  // The earlier Weekly bundle: exactly the row it had before (data left, its device limit).
  assert.deepEqual(Object.keys(byId.c1.summary.bundle).sort(), ["activeDevices", "deviceLimit", "expiresAt", "id", "name", "quotaBytes", "remainingBytes", "status", "usedBytes"]);
});
