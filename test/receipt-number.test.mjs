import assert from "node:assert/strict";
import test from "node:test";
import { nextReceiptNumber, receiptMonth } from "../lib/receipt-number.mjs";
import { ensureReceipt } from "../lib/billing.mjs";
import { receiptView } from "../lib/receipt.mjs";

// Short receipt numbers (#369, owner 27 Nov): NC-YYMM-NNNN and NC-PAY-YYMM-NNNN,
// counted per month in Douala time; receipts already issued keep their numbers.

test("receipt numbers count up within a Douala month and restart the next", () => {
  const s = {};
  assert.equal(receiptMonth("2026-11-30T22:59:00Z"), "2611");
  assert.equal(receiptMonth("2026-11-30T23:30:00Z"), "2612", "23:30 UTC is already 1 December in Douala");
  assert.deepEqual(nextReceiptNumber(s, "2026-11-24T13:32:00Z"), { number: "NC-2611-0001", paymentNumber: "NC-PAY-2611-0001" });
  assert.deepEqual(nextReceiptNumber(s, "2026-11-25T08:00:00Z"), { number: "NC-2611-0002", paymentNumber: "NC-PAY-2611-0002" });
  assert.deepEqual(nextReceiptNumber(s, "2026-12-01T08:00:00Z"), { number: "NC-2612-0001", paymentNumber: "NC-PAY-2612-0001" });
  assert.deepEqual(s.receiptNumbers, { 2611: 2, 2612: 1 });
  s.receiptNumbers["2611"] = 9999;
  assert.equal(nextReceiptNumber(s, "2026-11-26T08:00:00Z").number, "NC-2611-10000", "past 9,999 the number grows");
});

test("a new receipt gets a short number; an issued one keeps its own", () => {
  const s = { receiptNumbers: { 2611: 456 } };
  const base = { id: "9f0c", status: "paid", amount: 4000, fee: 80, total: 4080, providerFee: 80, providerTotal: 4080, currency: "XAF", provider: "mesomb", network: "mtn",
    payerPhone: "237670001245", confirmedAt: "2026-11-24T13:32:00Z", planSnapshot: { id: "unlimited-7d-2", name: "Personal Unlimited", validityHours: 168, accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaGb: null } };
  const paid = { ...base }, receipt = ensureReceipt(paid, null, s);
  assert.deepEqual([receipt.number, receipt.paymentNumber, receipt.paymentId], ["NC-2611-0457", "NC-PAY-2611-0457", "9f0c"]);
  assert.equal(ensureReceipt(paid, null, s).number, "NC-2611-0457", "the same receipt, not a new number");
  assert.equal(s.receiptNumbers["2611"], 457);
  const old = { ...base, id: "a1b2", receipt: { number: "NC-a1b2", paymentId: "a1b2", amount: 4000, currency: "XAF", plan: {} } };
  assert.equal(ensureReceipt(old, null, s).number, "NC-a1b2");
  assert.equal(ensureReceipt({ ...base, id: "c3d4" }, null).number, "NC-c3d4", "without the state, the long number");
  assert.equal(ensureReceipt({ id: "e5f6", status: "paid", amount: 500, currency: "XAF" }, null, s).number, "NC-e5f6", "a payment with no date keeps the long number");

  // The receipt screen's fields: confirmed amounts, network, masked number, terms and Wi-Fi state.
  const view = receiptView(receipt, null, { state: "active", at: "2026-11-24T13:33:00Z" });
  assert.deepEqual(view.amounts, { price: 4000, fee: 80, total: 4080, currency: "XAF", confirmed: true });
  assert.deepEqual([view.paymentNumber, view.network, view.payerPhoneMasked, view.providerRef], ["NC-PAY-2611-0457", "mtn", "6•• •• 12 45", null]);
  assert.deepEqual(view.terms, { accessType: "personal_unlimited", deviceSlots: 2, validityHours: 168, quotaGb: null, deviceLimit: 2 });
  assert.deepEqual(view.activation, { state: "active", at: "2026-11-24T13:33:00Z" });
  // A fee only quoted before paying is not "confirmed".
  const quoted = ensureReceipt({ ...base, id: "q1", providerFee: undefined, providerTotal: undefined }, null, s);
  assert.equal(receiptView(quoted).amounts.confirmed, false);
});
