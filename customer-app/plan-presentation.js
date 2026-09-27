const number = new Intl.NumberFormat("en-CM", { maximumFractionDigits: 8 });
const rateNumber = new Intl.NumberFormat("en-CM", { maximumFractionDigits: 2 });
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const positive = (value) => Number.isFinite(value) && value > 0;
const money = (value) => nonnegative(value) ? `${number.format(value)} FCFA` : "Unavailable";
const devices = (value) => positive(value)
  ? `${number.format(value)} device${value === 1 ? "" : "s"}`
  : "Unavailable";

export function durationLabel(validityHours) {
  if (!positive(validityHours)) return "Unavailable";
  if (validityHours >= 48 && Number.isInteger(validityHours / 24)) {
    return `${number.format(validityHours / 24)} days`;
  }
  return `${number.format(validityHours)} hour${validityHours === 1 ? "" : "s"}`;
}

export function dataLabel(quotaGb) {
  if (quotaGb === null) return "Unlimited";
  return nonnegative(quotaGb) ? `${number.format(quotaGb)} GB` : "Unavailable";
}

// Upgrade and downgrade describe price, not an assumed improvement in every allowance.
export function classifyPlanChange(currentPlan, nextPlan) {
  if (!nonnegative(currentPlan?.price) || !nonnegative(nextPlan?.price)) return null;
  return nextPlan.price > currentPlan.price ? "upgrade"
    : nextPlan.price < currentPlan.price ? "downgrade" : "lateral";
}

function difference(current, next, format, more, less, unchanged) {
  if (!nonnegative(current) || !nonnegative(next)) {
    return { change: "Comparison unavailable", direction: "unknown" };
  }
  if (current === next) return { change: unchanged, direction: "same" };
  return {
    change: `${format(Math.abs(next - current))} ${next > current ? more : less}`,
    direction: next > current ? "increase" : "decrease",
  };
}

export function comparePlans(currentPlan, nextPlan) {
  const current = currentPlan || {}, next = nextPlan || {};
  let dataDifference;
  if (current.quotaGb === null && next.quotaGb === null) {
    dataDifference = { change: "Both unlimited", direction: "same" };
  } else if (current.quotaGb === null && nonnegative(next.quotaGb)) {
    dataDifference = {
      change: `${dataLabel(next.quotaGb)} replaces unlimited data`, direction: "decrease",
    };
  } else if (nonnegative(current.quotaGb) && next.quotaGb === null) {
    dataDifference = {
      change: `Unlimited data replaces ${dataLabel(current.quotaGb)}`, direction: "increase",
    };
  } else {
    dataDifference = difference(current.quotaGb, next.quotaGb, dataLabel, "more", "less", "Same data");
  }
  return [
    {
      key: "price", label: "Package price", current: money(current.price), next: money(next.price),
      ...difference(current.price, next.price, money, "more", "less", "Same price"),
    },
    {
      key: "data", label: "Data", current: dataLabel(current.quotaGb), next: dataLabel(next.quotaGb),
      ...dataDifference,
    },
    {
      key: "validity", label: "Validity", current: durationLabel(current.validityHours), next: durationLabel(next.validityHours),
      ...difference(current.validityHours, next.validityHours, durationLabel, "longer", "shorter", "Same validity"),
    },
    {
      key: "devices", label: "Simultaneous devices", current: devices(current.deviceLimit), next: devices(next.deviceLimit),
      ...difference(current.deviceLimit, next.deviceLimit, devices, "more", "fewer", "Same device limit"),
    },
  ];
}

function rateLabel(value, unit) {
  if (value === null) return "Unavailable";
  if (value > 0 && value < 0.01) return `Less than 0.01 FCFA / ${unit}`;
  const rounded = Math.round(value * 100) / 100;
  return `${rounded === value ? "" : "About "}${rateNumber.format(value)} FCFA / ${unit}`;
}

export function planValue(plan) {
  const rate = (divisor) => {
    if (!nonnegative(plan?.price) || !positive(divisor)) return null;
    const result = plan.price / divisor;
    return Number.isFinite(result) ? result : null;
  };
  const pricePerGb = rate(plan?.quotaGb);
  const pricePerDay = rate(plan?.validityHours / 24);
  return {
    pricePerGb,
    pricePerDay,
    perGbLabel: plan?.quotaGb === null ? "Not applicable for unlimited data" : rateLabel(pricePerGb, "GB"),
    perDayLabel: rateLabel(pricePerDay, "day"),
  };
}

export function renewalEligibility(currentVoucher, cataloguePlans, dailyAvailability) {
  if (!currentVoucher?.planId) {
    return {
      eligible: false, code: "no-current-plan", reason: "There is no current plan to renew.",
      plan: null, nextEligibleAt: null,
    };
  }
  const plan = (cataloguePlans || []).find((candidate) =>
    candidate.id === currentVoucher.planId && candidate.discontinued !== true
  );
  if (!plan) {
    return {
      eligible: false, code: "plan-unavailable", reason: "This plan is no longer available for renewal.",
      plan: null, nextEligibleAt: null,
    };
  }
  if (plan.id === "daily" && dailyAvailability?.available !== true) {
    return {
      eligible: false,
      code: dailyAvailability?.available === false ? "daily-cooldown" : "eligibility-unavailable",
      reason: dailyAvailability?.available === false
        ? "The Daily plan is available once every 7 days."
        : "Daily plan eligibility could not be confirmed.",
      plan,
      nextEligibleAt: dailyAvailability?.nextEligibleAt || null,
    };
  }
  return {
    eligible: true, code: "eligible", reason: "This plan is eligible for renewal.",
    plan, nextEligibleAt: null,
  };
}
