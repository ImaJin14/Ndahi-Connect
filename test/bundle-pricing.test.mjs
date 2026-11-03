import test from "node:test";
import assert from "node:assert/strict";
import { blank, catalogue, view } from "../lib/api/state.mjs";
import { bundleStatus } from "../lib/bundle-status.mjs";
import { voucherAccess, voucherListView, voucherOwnershipDetails } from "../lib/voucher-access.mjs";

const now = new Date("2030-01-01T12:00:00.000Z");
const oldMonthly = { id: "monthly", name: "Monthly", price: 2000, quotaGb: 10, validityHours: 720, deviceLimit: 1 };

for (const recordedTerms of ["snapshot", "receipt", "allocation"]) {
  test(`existing Monthly ${recordedTerms} terms survive the catalogue price and quota update`, () => {
    const state = blank(), customer = { id: "customer" },
      voucher = { id: "voucher", customerId: customer.id, paymentId: "payment", planId: "monthly", status: "active",
        activatedAt: now.toISOString(), expiresAt: "2030-01-31T12:00:00.000Z", quotaBytes: 10e9, usedBytes: 1e9, deviceLimit: 1 },
      payment = { id: "payment", customerId: customer.id, planId: "monthly", amount: 2000, status: "paid",
        ...(recordedTerms === "snapshot" ? { planSnapshot: structuredClone(oldMonthly) } : {}),
        ...(recordedTerms === "receipt" ? { receipt: { amount: 2000, plan: structuredClone(oldMonthly) } } : {}) };
    state.customers.push(customer);
    state.vouchers.push(voucher);
    state.payments.push(payment);
    const before = structuredClone(state), access = voucherAccess("owner");

    const current = catalogue(state).find((plan) => plan.id === "monthly");
    assert.equal(current.price, 3000);
    assert.equal(current.quotaGb, 15);
    for (const result of [view(voucher, state), bundleStatus(state, customer, now).bundle,
      voucherListView(state, voucher, access), voucherOwnershipDetails(state, voucher, access)]) {
      assert.equal(result.plan.price, 2000);
      assert.equal(result.plan.quotaGb, 10);
      assert.equal(result.plan.deviceLimit, 1);
      assert.equal(result.remainingBytes, 9e9);
    }
    assert.deepEqual(state, before, "displaying historical terms cannot rewrite purchased entitlements or receipts");
  });
}

test("existing resale stock displays its original face value and allowance", () => {
  const state = blank(), voucher = { id: "stock", planId: "connect30", status: "available",
    faceValue: 5500, quotaBytes: 30e9, usedBytes: 0, deviceLimit: 2 };
  state.vouchers.push(voucher);
  assert.equal(catalogue(state).find((plan) => plan.id === "connect30").price, 6000);
  const result = voucherListView(state, voucher, voucherAccess("owner"));
  assert.equal(result.plan.price, 5500);
  assert.equal(result.plan.quotaGb, 30);
  assert.equal(result.plan.deviceLimit, 2);
});
