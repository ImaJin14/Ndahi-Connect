// Insights' figures (AdminInsights, #382; owner decisions 25 Nov): each beside
// the previous period of the same length, "bought again within 2 days" as the
// owner defined it, the busiest hours, Starlink at peak and the funnel note.
import test from "node:test";
import assert from "node:assert/strict";
import { boughtAgainShare, busiestWindow, funnelSummary, insightsFigures, insightsSummary, percentChange, uplinkAtPeak } from "../lib/insights-summary.mjs";

const DAY = 864e5, now = new Date("2026-11-25T18:00:00Z"), to = "2026-11-25T23:00:00.000Z", from = "2026-11-18T23:00:00.000Z";
const iso = (ms) => new Date(ms).toISOString(), back = (days) => iso(Date.parse(to) - days * DAY);
let n = 0;
const paid = (at, amount, customerId, extra = {}) => ({ id: `p${n}`, provider: "mesomb", providerReference: `r${n++}`, currency: "XAF", status: "paid", amount, planId: "day", customerId, createdAt: at, confirmedAt: at, ...extra });

test("figures come with their change against the period before", () => {
  const s = { payments: [paid(back(1), 1000, "a"), paid(back(2), 1000, "a"), paid(back(3), 500, "b"), paid(back(9), 1000, "c"), paid(back(10), 1000, "c"),
], vouchers: [{ id: "cash", generatedByAdmin: true, saleType: "sold", status: "active", activatedAt: back(4) }],
    storeOrders: [{ id: "o", customerId: "d", payment: { confirmedAt: back(1), provider: "mesomb", providerReference: "so", currency: "XAF", status: "paid", amount: 2000 } }] };
  const f = insightsFigures(s, { from, to, now });
  assert.deepEqual(f.revenue, { value: 4500, previous: 2000, change: 125 }, "bundles and store, net of refunds");
  assert.deepEqual(f.bundlesSold, { value: 4, previous: 2, change: 100 }, "three paid bundles and one code sold by hand");
  assert.deepEqual(f.payingCustomers, { value: 3, previous: 1, change: 200 });
  assert.equal(percentChange(5, 0), null, "nothing to compare with");
  // A test payment is never a sale, and makes the revenue chart need review.
  s.payments.push(paid(back(2), 700, "m", { provider: "mock" }));
  const mock = insightsFigures(s, { from, to, now });
  assert.deepEqual([mock.bundlesSold.value, mock.payingCustomers.value, mock.revenue.value], [4, 3, null]);
});

test("bought again: of customers whose bundle ended, those who bought another within 2 days", () => {
  const v = (id, customerId, bought, ended, status = "expired") => ({ id, customerId, activatedAt: bought, expiresAt: ended, status });
  const s = { vouchers: [
    v("a1", "a", back(6), back(5)), v("a2", "a", back(4.5), back(-3), "active"),      // came back within a day
    v("b1", "b", back(6), back(5.5)), v("b2", "b", back(7), back(6.5)),               // nothing new after the latest
    v("c1", "c", back(7), back(6)), v("c2", "c", back(6.5), back(-1), "active"),      // renewed early: counts
    v("d1", "d", back(8), back(6)), v("d2", "d", back(2), back(-5), "active"),        // came back after 4 days: no
    v("e1", "e", back(2), back(1)),                                                     // ended too recently to tell
  ] };
  assert.deepEqual(boughtAgainShare(s, { start: Date.parse(from), end: Date.parse(to), now }), { ended: 4, again: 2, share: 50 });
  const f = insightsFigures({ ...s, payments: [] }, { from, to, now });
  assert.deepEqual([f.boughtAgain.value, f.boughtAgain.previous, f.boughtAgain.changePoints], [50, null, null]);
});

test("busiest three hours, Starlink at peak in them, and the funnel note", () => {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, average: [19, 20, 21].includes(hour) ? 60 : hour === 3 ? null : 10 }));
  assert.deepEqual(busiestWindow(hours), { from: 19, to: 22 });
  assert.equal(busiestWindow(hours.map((h) => ({ ...h, average: null }))), null);
  const s = { insightCounters: [19, 20, 21, 9].map((hour) => ({ type: "uplink_hourly", at: back(1), hour, peakMbps: hour === 9 ? 90 : 40 + hour - 19 })) };
  assert.equal(uplinkAtPeak(s, { from, to }, { from: 19, to: 22 }), 41, "the average of the busiest hours' peaks");
  const f = funnelSummary({ variants: { v1: { wifi_page: 900, signed_in: 522, payment_started: 306, paid: 198 }, v2: { wifi_page: 100, signed_in: 63, payment_started: 39, paid: 28 } } });
  assert.deepEqual(f, { steps: ["wifi_page", "signed_in", "payment_started", "paid"], current: [100, 58, 34, 22], next: [100, 63, 39, 28], paidPoints: 6, biggestGain: { from: "payment_started", to: "paid" }, newShare: 10 });
  const none = funnelSummary({ variants: { v1: { wifi_page: 0, signed_in: 0, payment_started: 0, paid: 0 }, v2: { wifi_page: 40, signed_in: 20, payment_started: 10, paid: 5 } } });
  assert.deepEqual([none.current, none.paidPoints, none.biggestGain, none.newShare], [null, null, null, 100]);
});

test("the summary the API returns", () => {
  const summary = insightsSummary({ payments: [], vouchers: [] }, { from, to, now });
  assert.deepEqual(Object.keys(summary), ["figures", "busiest", "uplinkAtPeakMbps", "funnel"]);
  assert.deepEqual([summary.busiest, summary.uplinkAtPeakMbps, summary.funnel.newShare], [null, null, null]);
});
