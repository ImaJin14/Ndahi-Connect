// Audit log rows as designed (AdminAudit, #232): newest first whatever the
// stored order, the actor's role and name, and what the action was on by name.
// Voucher codes never appear.
import test from "node:test";
import assert from "node:assert/strict";
import { queryRecords } from "../lib/admin-records.mjs";

const state = () => ({
  adminUsers: [
    { id: "u-owner", username: "owner", role: "owner", displayName: "Patrick" },
    { id: "u-op", username: "brenda", role: "operator", displayName: "Brenda" },
    { id: "u-res", username: "kiosk", role: "reseller", displayName: "Market kiosk" },
  ],
  customers: [{ id: "c1", name: "Kevin Nji", phone: "670001245" }, { id: "c2", name: "", phone: "+237 6 99 00 88 02" }],
  payments: [{ id: "p1", payerPhone: "670991245", customerId: "c1" }],
  vouchers: [{ id: "v1", code: "NC-SECRET-CODE" }],
  bundles: [{ id: "custom-family", name: "Connect Family" }],
  storeProducts: [{ id: "prod-1", name: "Wavlink AC1200" }],
  auditLogs: [
    { id: "a1", at: "2026-11-10T07:15:00Z", actor: "owner", action: "admin.login", meta: {} },
    { id: "a2", at: "2026-11-10T16:25:00Z", actor: "brenda", action: "store.order_handed_over", meta: { orderReference: "NS-2611-0088" } },
    { id: "a3", at: "2026-11-10T13:30:00Z", actor: "brenda", action: "reseller.remittance_recorded", meta: { resellerId: "u-res" } },
    { id: "a4", at: "2026-11-10T14:48:00Z", actor: "owner", action: "customer.suspended", meta: { customerId: "c1" } },
    { id: "a5", at: "2026-11-10T16:22:00Z", actor: "owner", action: "payment.checked", meta: { paymentId: "p1", customerId: "c1" } },
    { id: "a6", at: "2026-11-10T10:02:00Z", actor: "owner", action: "store.stock_changed", meta: { productId: "prod-1" } },
    { id: "a7", at: "2026-11-10T09:00:00Z", actor: "system", action: "voucher.revoked", meta: { voucherId: "v1" } },
    { id: "a8", at: "2026-11-10T08:00:00Z", actor: "removed-user", action: "bundle.updated", meta: { bundleId: "custom-family" } },
    { id: "a9", at: "2026-11-10T08:30:00Z", actor: "owner", action: "customer.updated", meta: { customerId: "c2" } },
  ],
});

test("audit entries come newest first, with the actor's role and name and a named target", () => {
  const { items } = queryRecords(state(), { collection: "audit", pageSize: 100 });
  assert.deepEqual(items.map((a) => a.id), ["a2", "a5", "a4", "a3", "a6", "a7", "a9", "a8", "a1"]);
  const by = Object.fromEntries(items.map((a) => [a.id, a]));
  assert.deepEqual([by.a2.actorRole, by.a2.actorName], ["operator", "Brenda"]);
  assert.deepEqual([by.a1.actorRole, by.a1.actorName], ["owner", "Patrick"]);
  assert.deepEqual([by.a7.actorRole, by.a8.actorRole], [null, null], "system and removed accounts have no role");
  assert.equal(by.a3.target, "Market kiosk");
  assert.equal(by.a4.target, "K. Nji");
  assert.equal(by.a5.target, "K. Nji", "the customer, when the payment names one");
  assert.equal(by.a6.target, "Wavlink AC1200");
  assert.equal(by.a8.target, "Connect Family");
  assert.equal(by.a9.target, "6•• •• 88 02", "no name: the masked number");
  assert.equal(by.a2.target, null, "an order keeps its reference, shown by the client");
  assert.equal(by.a7.target, null);
  assert.equal(JSON.stringify(items).includes("NC-SECRET-CODE"), false, "voucher codes are never shown");
});

test("a payment without a customer is named by its masked number", () => {
  const s = state();
  s.auditLogs = [{ id: "p", at: "2026-11-10T16:22:00Z", actor: "owner", action: "payment.checked", meta: { paymentId: "p1" } }];
  assert.equal(queryRecords(s, { collection: "audit" }).items[0].target, "6•• •• 12 45");
});

// AdminAudit (#378; owner, 25 Nov): the six drawn chips, one row per staff
// sign-in, and the drawn "On" column.
test("each drawn chip filters its areas; network actions show only under Everything", () => {
  const s = state();
  s.auditLogs = ["payment.refund_requested", "reseller.remittance_recorded", "store.orders.update", "voucher.revoked", "customer.suspension_changed", "wifi_device.disconnected", "admin.login.succeeded", "network.command_resolved", "home.provisioned"]
    .map((action, i) => ({ id: "e" + i, at: new Date(Date.UTC(2026, 10, 10, 8, i)).toISOString(), actor: "owner", action, meta: {} }));
  const ids = (status) => queryRecords(s, { collection: "audit", status, pageSize: 100 }).items.map((a) => a.action).sort();
  assert.deepEqual(ids("money"), ["payment.refund_requested", "reseller.remittance_recorded"]);
  assert.deepEqual(ids("store"), ["store.orders.update"]);
  assert.deepEqual(ids("vouchers"), ["voucher.revoked"]);
  assert.deepEqual(ids("customers"), ["customer.suspension_changed", "wifi_device.disconnected"]);
  assert.deepEqual(ids("signins"), ["admin.login.succeeded"]);
  assert.equal(ids("").length, 9, "Everything");
  assert.deepEqual(ids("network"), ["network.command_resolved"], "a single area still filters, as before");
});

test("a sign-in that finished a PIN step is one row; a PIN step alone stays", () => {
  const s = state();
  s.auditLogs = [
    { id: "late-pin", at: "2026-11-10T12:00:00Z", actor: "brenda", action: "admin.login.pin_verified", meta: {} },
    { id: "done", at: "2026-11-10T07:15:20Z", actor: "owner", action: "admin.login.succeeded", meta: {} },
    { id: "pin", at: "2026-11-10T07:15:00Z", actor: "owner", action: "admin.login.pin_verified", meta: {} },
    { id: "old", at: "2026-11-01T07:15:00Z", actor: "owner", action: "admin.login.succeeded", meta: {} },
  ];
  const { items, total } = queryRecords(s, { collection: "audit", pageSize: 100 });
  assert.deepEqual(items.map((a) => [a.id, a.method || null, a.targetKind]), [["late-pin", null, "admin"], ["done", "pin_passkey", "admin"], ["old", null, "admin"]]);
  assert.equal(total, 3, "the folded PIN step is not counted");
  assert.equal(s.auditLogs.length, 4, "stored entries never change");
  assert.equal(s.auditLogs.some((a) => a.method), false);
});

test("On names the order, the voucher batch and a bundle payment as drawn", () => {
  const s = state();
  s.storeOrders = [{ id: "o1", reference: "NS-2611-0088" }];
  s.vouchers = [{ id: "v1", code: "NC-SECRET-CODE", batchReference: "B-1110-03" }];
  s.payments = [{ id: "p1", payerPhone: "670991245", planId: "day" }];
  s.auditLogs = [
    { id: "order", at: "2026-11-10T16:25:00Z", actor: "brenda", action: "store.orders.update", meta: { id: "o1", orderAction: "collect" } },
    { id: "stock", at: "2026-11-10T10:02:00Z", actor: "owner", action: "store.stock.adjust", meta: { id: "prod-1", from: 3, to: 2 } },
    { id: "batch", at: "2026-11-10T15:10:00Z", actor: "owner", action: "voucher.resale_batch_generated", meta: { voucherIds: ["v1"], quantity: 20 } },
    { id: "pay", at: "2026-11-10T16:22:00Z", actor: "owner", action: "payment.support_verification.completed", meta: { paymentId: "p1" } },
  ];
  const by = Object.fromEntries(queryRecords(s, { collection: "audit", pageSize: 100 }).items.map((a) => [a.id, a]));
  assert.equal(by.order.target, "NS-2611-0088");
  assert.equal(by.stock.target, "Wavlink AC1200");
  assert.equal(by.batch.target, "B-1110-03");
  assert.deepEqual([by.pay.target, by.pay.targetKind], ["6•• •• 12 45", "bundle"]);
  assert.equal(JSON.stringify(by).includes("NC-SECRET-CODE"), false);
});
