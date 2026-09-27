import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPlanChange,
  comparePlans,
  dataLabel,
  durationLabel,
  planValue,
  renewalEligibility,
} from "../customer-app/plan-presentation.js";

const weekly = Object.freeze({
  id: "weekly", name: "Weekly", price: 500, quotaGb: 5, validityHours: 168, deviceLimit: 1,
});
const monthly = Object.freeze({
  id: "monthly", name: "Monthly", price: 2000, quotaGb: 10, validityHours: 720, deviceLimit: 1,
});
const daily = Object.freeze({
  id: "daily", name: "Daily", price: 100, quotaGb: 1, validityHours: 24, deviceLimit: 1,
});
const unlimited = Object.freeze({
  id: "unlimited", name: "Unlimited Home", price: 30000, quotaGb: null, validityHours: 720, deviceLimit: 6,
});

test("custom validity labels never silently become a month", () => {
  for (const [hours, expected] of [
    [0.5, "0.5 hours"], [1, "1 hour"], [12, "12 hours"], [24, "24 hours"],
    [36, "36 hours"], [48, "2 days"], [49, "49 hours"], [168, "7 days"], [720, "30 days"],
  ]) assert.equal(durationLabel(hours), expected);
  for (const invalid of [0, -1, undefined, null, NaN, Infinity]) {
    assert.equal(durationLabel(invalid), "Unavailable");
  }
});

test("only an explicitly unlimited quota is labelled unlimited", () => {
  assert.equal(dataLabel(null), "Unlimited");
  assert.equal(dataLabel(1.5), "1.5 GB");
  assert.equal(dataLabel(0), "0 GB");
  for (const invalid of [undefined, -1, NaN, Infinity]) {
    assert.equal(dataLabel(invalid), "Unavailable");
  }
});

test("change labels classify package prices even when another allowance decreases", () => {
  assert.equal(classifyPlanChange(weekly, monthly), "upgrade");
  assert.equal(classifyPlanChange(monthly, weekly), "downgrade");
  assert.equal(classifyPlanChange(weekly, { ...weekly, quotaGb: 2, validityHours: 720 }), "lateral");
  assert.equal(classifyPlanChange(weekly, { ...weekly, price: 600, quotaGb: 1 }), "upgrade");
  assert.equal(classifyPlanChange(null, monthly), null);
  assert.equal(classifyPlanChange(weekly, { price: NaN }), null);
});

test("a switch explicitly compares price, data, duration and simultaneous devices", () => {
  assert.deepEqual(comparePlans(weekly, { ...monthly, deviceLimit: 2 }), [
    { key: "price", label: "Package price", current: "500 FCFA", next: "2,000 FCFA", change: "1,500 FCFA more", direction: "increase" },
    { key: "data", label: "Data", current: "5 GB", next: "10 GB", change: "5 GB more", direction: "increase" },
    { key: "validity", label: "Validity", current: "7 days", next: "30 days", change: "23 days longer", direction: "increase" },
    { key: "devices", label: "Simultaneous devices", current: "1 device", next: "2 devices", change: "1 device more", direction: "increase" },
  ]);
  const reduced = comparePlans(monthly, { ...weekly, validityHours: 12 });
  assert.equal(reduced[0].change, "1,500 FCFA less");
  assert.equal(reduced[2].change, "708 hours shorter");
  assert.equal(reduced[3].change, "Same device limit");
});

test("unlimited transitions describe the change without numeric infinity or free-data claims", () => {
  assert.deepEqual(comparePlans(monthly, unlimited)[1], {
    key: "data", label: "Data", current: "10 GB", next: "Unlimited",
    change: "Unlimited data replaces 10 GB", direction: "increase",
  });
  assert.equal(comparePlans(unlimited, monthly)[1].change, "10 GB replaces unlimited data");
  assert.equal(comparePlans(unlimited, unlimited)[1].change, "Both unlimited");
  assert.equal(comparePlans(unlimited, {})[1].direction, "unknown");
  assert.equal(comparePlans({}, unlimited)[1].direction, "unknown");
});

test("unit pricing exposes the real higher price per GB of the longer monthly plan", () => {
  const weeklyValue = planValue(weekly), monthlyValue = planValue(monthly);
  assert.equal(weeklyValue.pricePerGb, 100);
  assert.equal(monthlyValue.pricePerGb, 200);
  assert.equal(weeklyValue.perGbLabel, "100 FCFA / GB");
  assert.equal(monthlyValue.perGbLabel, "200 FCFA / GB");
  assert.equal(weeklyValue.pricePerDay, 500 / 7);
  assert.equal(weeklyValue.perDayLabel, "About 71.43 FCFA / day");
  assert.equal(monthlyValue.perDayLabel, "About 66.67 FCFA / day");
});

test("unit pricing handles fractional days, unlimited data, free plans and invalid denominators", () => {
  assert.equal(planValue({ ...weekly, price: 800, validityHours: 12 }).perDayLabel, "1,600 FCFA / day");
  assert.deepEqual(planValue(unlimited), {
    pricePerGb: null, pricePerDay: 1000,
    perGbLabel: "Not applicable for unlimited data", perDayLabel: "1,000 FCFA / day",
  });
  assert.equal(planValue({ ...weekly, price: 0 }).perGbLabel, "0 FCFA / GB");
  assert.equal(planValue({ ...weekly, price: 0.001 }).perGbLabel, "Less than 0.01 FCFA / GB");
  assert.equal(planValue({ ...weekly, quotaGb: 0 }).pricePerGb, null);
  assert.equal(planValue({ ...weekly, validityHours: 0 }).pricePerDay, null);
  assert.deepEqual(planValue(), {
    pricePerGb: null, pricePerDay: null, perGbLabel: "Unavailable", perDayLabel: "Unavailable",
  });
});

test("renewal selects the current catalogue terms even when the voucher has older prices", () => {
  const oldVoucher = Object.freeze({ planId: "weekly", plan: { ...weekly, price: 300 }, status: "expired" });
  const result = renewalEligibility(oldVoucher, [daily, weekly, monthly]);
  assert.equal(result.eligible, true);
  assert.equal(result.code, "eligible");
  assert.equal(result.plan, weekly);
  assert.equal(result.plan.price, 500);
  assert.equal(oldVoucher.plan.price, 300);
});

test("renewal blocks missing and discontinued current plans without falling back to another plan", () => {
  assert.deepEqual(renewalEligibility(null, [weekly]), {
    eligible: false, code: "no-current-plan", reason: "There is no current plan to renew.",
    plan: null, nextEligibleAt: null,
  });
  for (const catalogue of [[monthly], [{ ...weekly, discontinued: true }], undefined]) {
    const result = renewalEligibility({ planId: "weekly" }, catalogue);
    assert.equal(result.eligible, false);
    assert.equal(result.code, "plan-unavailable");
    assert.equal(result.plan, null);
  }
});

test("Daily renewal uses server eligibility and retains the next eligible date", () => {
  const nextEligibleAt = "2026-09-30T12:00:00.000Z";
  const blocked = renewalEligibility({ planId: "daily" }, [daily], { available: false, nextEligibleAt });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.code, "daily-cooldown");
  assert.equal(blocked.nextEligibleAt, nextEligibleAt);
  assert.equal(blocked.plan, daily);
  assert.equal(renewalEligibility({ planId: "daily" }, [daily], { available: true }).eligible, true);
  assert.equal(renewalEligibility({ planId: "daily" }, [daily]).code, "eligibility-unavailable");
  assert.equal(renewalEligibility({ planId: "weekly" }, [weekly], { available: false }).eligible, true);
});
