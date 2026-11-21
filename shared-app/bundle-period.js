// Bundles arranged by how long they last (owner, 21 Nov 2026: "auto arrange
// bundles based on monthly, weekly and daily plans with filters on the bundle
// page"), for the customer buy page and Admin → Bundles.
// Daily: up to a day. Weekly: up to 7 days. Monthly: longer (30 days, 45 days).
// Within a period, the cheapest first; equal prices keep the catalogue order.
export const BUNDLE_PERIODS = ["daily", "weekly", "monthly"];
export const PERIOD_LABELS = { all: "bundlePeriodAll", daily: "bundlePeriodDaily", weekly: "bundlePeriodWeekly", monthly: "bundlePeriodMonthly" };

export function bundlePeriod(plan) {
  const hours = Number(plan?.validityHours);
  if (Number.isFinite(hours) && hours > 0 && hours <= 24) return "daily";
  if (Number.isFinite(hours) && hours > 0 && hours <= 168) return "weekly";
  return "monthly";
}

const price = (plan) => (Number.isFinite(Number(plan?.price)) && plan?.price !== null ? Number(plan.price) : Infinity);

// The periods that have bundles, in order, each with its bundles sorted.
export function groupBundles(plans) {
  const groups = new Map(BUNDLE_PERIODS.map((period) => [period, []]));
  for (const plan of plans || []) groups.get(bundlePeriod(plan)).push(plan);
  return BUNDLE_PERIODS.map((period) => ({ period, plans: groups.get(period).slice().sort((a, b) =>
    price(a) - price(b) || Number(a.validityHours) - Number(b.validityHours)) })).filter((group) => group.plans.length);
}

// A requested filter, kept only when that period has bundles.
export function chosenPeriod(value, groups) {
  return groups.some((group) => group.period === value) ? value : "all";
}
