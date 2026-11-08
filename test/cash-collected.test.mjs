import test from "node:test";
import assert from "node:assert/strict";
import { cashCollected } from "../lib/cash-collected.mjs";
const now = new Date("2026-11-08T17:00:00+01:00");
const payment = (id, extra = {}) => ({
  id,
  provider: "mesomb",
  providerReference: `provider-${id}`,
  amount: 1000,
  currency: "XAF",
  status: "paid",
  confirmedAt: "2026-11-02T10:00:00+01:00",
  ...extra,
});
test("fixed November baseline uses Douala midnight and confirmation time, not creation time", () => {
  const s = {
    payments: [
      payment("old", { confirmedAt: "2026-10-31T22:59:59Z" }),
      payment("boundary", { confirmedAt: "2026-10-31T23:00:00Z" }),
      payment("late", {
        createdAt: "2026-10-01",
        confirmedAt: "2026-11-03T10:00:00Z",
      }),
      payment("future", { confirmedAt: "2026-12-01T00:00:00Z" }),
    ],
  };
  assert.equal(cashCollected(s, now).amount, 2000);
  assert.equal(
    cashCollected(s, new Date("2026-12-02T00:00:00Z")).amount,
    3000,
    "baseline does not roll forward next month",
  );
});
test("includes internet and hardware, excludes mock/pending/offline/gifts, deducts only completed refunds", () => {
  const report = cashCollected(
    {
      payments: [
        payment("paid"),
        payment("mock", { provider: "mock" }),
        payment("pending", { confirmedAt: null, status: "pending" }),
        payment("refund", {
          status: "refunded",
          refund: { status: "completed" },
        }),
        payment("request", {
          status: "refund-pending",
          refund: { status: "pending" },
        }),
      ],
      storeOrders: [
        {
          payment: payment("store", { provider: "flutterwave", amount: 5000 }),
        },
      ],
      vouchers: [
        { saleAmount: 99999, saleType: "sold", activatedAt: now.toISOString() },
      ],
    },
    now,
  );
  assert.equal(report.collected, 8000);
  assert.equal(report.refunded, 1000);
  assert.equal(report.amount, 7000);
  assert.equal(report.sources.internet.amount, 2000);
  assert.equal(report.sources.store.amount, 5000);
});
test("deduplicates matching gateway references across record arrays and rejects conflicting evidence", () => {
  const p = payment("same");
  const report = cashCollected(
    { payments: [p], storeOrders: [{ payment: structuredClone(p) }] },
    now,
  );
  assert.equal(report.amount, 1000);
  assert.equal(report.duplicateRecords, 1);
  assert.equal(
    cashCollected({ payments: [p, { ...p, amount: 2000 }] }, now).amount,
    null,
  );
});
for (const extra of [
  { amount: NaN },
  { amount: -1 },
  { amount: "1000" },
  { amount: 1.234 },
  { currency: "EUR" },
  { providerReference: "" },
  { confirmedAt: "bad" },
  { status: "pending" },
])
  test(`incomplete confirmed evidence ${JSON.stringify(extra)} cannot produce a misleading total`, () => {
    assert.equal(
      cashCollected({ payments: [payment("invalid", extra)] }, now).amount,
      null,
    );
  });
test("empty reporting period is zero, not a fabricated gateway settlement", () => {
  const report = cashCollected({}, now);
  assert.equal(report.amount, 0);
  assert.match(report.basis, /before-fees/);
  assert.match(report.message, /not a live gateway settlement/);
});
