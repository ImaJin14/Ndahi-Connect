import test from "node:test";
import assert from "node:assert/strict";
import { cashCollected, cashPeriodStart, cashReport, CASH_PERIODS } from "../lib/cash-collected.mjs";
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

// Cash and settlements (#379; owner, 25 Nov): periods, and per network what
// MeSomb should pay into the bank from saved payments.
test("periods start at Douala midnight: today, six days before today, the 1st of the month, never before 1 November", () => {
  const at = new Date("2026-11-25T16:30:00Z");
  assert.deepEqual(CASH_PERIODS, ["today", "week", "month"]);
  assert.deepEqual(CASH_PERIODS.map((period) => cashPeriodStart(period, at).toISOString()),
    ["2026-11-24T23:00:00.000Z", "2026-11-18T23:00:00.000Z", "2026-10-31T23:00:00.000Z"]);
  assert.equal(cashPeriodStart("today", new Date("2026-11-25T23:30:00Z")).toISOString(), "2026-11-25T23:00:00.000Z", "00:30 in Douala is the next day");
  assert.equal(cashPeriodStart("month", new Date("2027-01-02T08:00:00Z")).toISOString(), "2026-12-31T23:00:00.000Z");
  assert.equal(cashPeriodStart("week", new Date("2026-11-03T08:00:00Z")).toISOString(), "2026-10-31T23:00:00.000Z", "clamped to the baseline");
  assert.throws(() => cashPeriodStart("year", at), /Unknown cash report period/);
});

test("net provider settlements per network: what customers paid, the saved fee, completed refunds and the net", () => {
  const at = new Date("2026-11-25T16:30:00Z"), day = (iso) => ({ confirmedAt: iso, createdAt: iso });
  const report = cashReport({
    payments: [
      // MeSomb's reported fee wins over the quote.
      payment("m1", { network: "mtn", amount: 2500, fee: 50, total: 2550, providerFee: 48, providerTotal: 2548, ...day("2026-11-25T10:00:00Z") }),
      // Only the quote saved.
      payment("m2", { network: "mtn", amount: 1000, fee: 20, total: 1020, ...day("2026-11-24T10:00:00Z") }),
      // Refunded in full: the fee stays charged, the price comes back.
      payment("m3", { network: "mtn", amount: 1000, fee: 20, total: 1020, status: "refunded", refund: { status: "completed" }, ...day("2026-11-23T10:00:00Z") }),
      // No network saved: the payer's number tells (69… is Orange). No fee saved before 19 Nov counts as none.
      payment("o1", { payerPhone: "690001245", amount: 3000, ...day("2026-11-20T10:00:00Z") }),
      // Outside the 7 days.
      payment("old", { network: "mtn", amount: 9999, fee: 200, total: 10199, ...day("2026-11-10T10:00:00Z") }),
    ],
    storeOrders: [{ payment: payment("s1", { network: "orange", amount: 30000, fee: 600, total: 30600, ...day("2026-11-22T10:00:00Z") }) }],
    adminUsers: [{ remittances: [{ amount: 20000, createdAt: "2026-11-21T09:00:00Z" }, { amount: 5000, createdAt: "2026-11-02T09:00:00Z" }, { amount: "x", createdAt: "2026-11-21T09:00:00Z" }] }],
  }, at, { period: "week" });
  assert.equal(report.period, "week");
  assert.equal(report.from, "2026-11-18T23:00:00.000Z");
  assert.deepEqual(report.networks, {
    mtn: { payments: 3, cashBeforeFees: 4588, fees: 88, refunded: 1000, net: 3500 },
    orange: { payments: 2, cashBeforeFees: 33600, fees: 600, refunded: 0, net: 33000 },
  });
  // Each row adds up: cash before fees − fees − refunds = net.
  for (const n of Object.values(report.networks)) assert.equal(n.cashBeforeFees - n.fees - n.refunded, n.net);
  assert.deepEqual([report.sources.internet.collected, report.sources.store.collected, report.refunded], [7500, 30000, 1000]);
  assert.deepEqual(report.resellerCash, { handoffs: 1, amount: 20000 });
  const today = cashReport({ payments: [payment("m1", { network: "mtn", amount: 2500, fee: 50, total: 2550, ...day("2026-11-25T10:00:00Z") })] }, at, { period: "today" });
  assert.deepEqual([today.networks.mtn.payments, today.networks.orange.payments, today.resellerCash.amount], [1, 0, 0]);
  // Evidence that needs review shows no settlement figures at all.
  assert.equal(cashReport({ payments: [payment("bad", { currency: "EUR", ...day("2026-11-25T10:00:00Z") })] }, at).networks, null);
});
