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
