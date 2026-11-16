import test from "node:test";
import assert from "node:assert/strict";
import { recordedCollectionsByDay, insightsDataAvailability } from "../lib/insights.mjs";

const period = { from: "2026-11-15T23:00:00Z", to: "2026-11-17T23:00:00Z" };
const payment = (id, extra = {}) => ({ id, provider: "mesomb", providerReference: `ref-${id}`, status: "paid",
  currency: "XAF", amount: 500, confirmedAt: "2026-11-16T22:59:00Z", ...extra });

test("daily recorded collections use Cameroon dates, deduplicate and identify partial offline coverage", () => {
  const p = payment("p1");
  const result = recordedCollectionsByDay({ payments: [p, payment("next", { confirmedAt: "2026-11-16T23:00:00Z", amount: 1000 })],
    storeOrders: [{ payment: structuredClone(p) }], vouchers: [{ id: "v1", cashSale: { id: "s1", resellerId: "r1", receivedAt: "2026-11-16T12:00:00Z", amount: 250 } }] }, period);
  assert.equal(result.status, "available");
  assert.equal(result.coverage, "partial-older-offline-sales-may-not-be-recorded");
  assert.equal(result.duplicateRecords, 1);
  assert.deepEqual(result.days, [
    { date: "2026-11-16", collected: 750, refunded: 0, net: 750 },
    { date: "2026-11-17", collected: 1000, refunded: 0, net: 1000 },
  ]);
});

test("refunds affect their original confirmation day and conflicting evidence suppresses amounts", () => {
  const p = payment("p1", { status: "refunded" });
  const valid = recordedCollectionsByDay({ payments: [p] }, period);
  assert.equal(valid.days[0].refunded, 500);
  assert.equal(valid.days[0].net, 0);
  const conflict = recordedCollectionsByDay({ payments: [p, { ...p, amount: 501 }] }, period);
  assert.equal(conflict.status, "needs_review");
  assert.equal(conflict.days, null);
});

test("invalid evidence never becomes a plausible chart and unavailable data stays unavailable", () => {
  const result = recordedCollectionsByDay({ payments: [payment("bad", { amount: NaN })] }, period);
  assert.equal(result.status, "needs_review");
  assert.equal(result.days, null);
  assert.throws(() => recordedCollectionsByDay({}, { from: period.to, to: period.from }), RangeError);
  assert.throws(() => recordedCollectionsByDay({}, { from: "2026-01-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }), RangeError);
  for (const value of Object.values(insightsDataAvailability())) assert.equal(value.status, "unavailable");
});
