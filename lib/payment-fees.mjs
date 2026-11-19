// The Mobile Money fee a customer pays on top of the price (#297).
//
// MeSomb is asked with `fees: false` (lib/payments.mjs), so the payer approves the
// price plus MeSomb's fee. MeSomb has no call that quotes that fee before a charge;
// it reports the fee it charged (`fees`, and `trxamount` = price + fee) once the
// request exists. So the fee shown before paying comes from one rule per network,
// set from the MeSomb contract in PAYMENT_FEE_MTN and PAYMENT_FEE_ORANGE, and every
// fee MeSomb reports is recorded beside the quote and compared
// (scripts/check-payment-fees.mjs). No rule, or an invalid one, means no number:
// the screens then say "plus the Mobile Money fee shown in your prompt".
//
// A rule is comma-separated key=value pairs:
//   percent=2            percentage, 0 to 50, up to 4 decimals
//   on=price | gross     price: the fee is that percentage of the price.
//                        gross: it is that percentage of the total collected, so
//                        total = price / (1 - percent).
//   fixed=0              whole FCFA added to the percentage
//   min=0, max=...       whole FCFA bounds for the fee
//   round=up | down | nearest   to whole FCFA. Default up: a quote can only be
//                        high by under 1 FCFA, never low, so "your balance needs at
//                        least {total}" stays true.
// Example: PAYMENT_FEE_MTN="percent=2,on=price,round=up"

export const feeNetworks = ["mtn", "orange"];
const SCALE = 1_000_000n; // percent=2 -> 20000 parts per million
const keys = new Set(["percent", "on", "fixed", "min", "max", "round"]);
const whole = (value) => /^\d{1,7}$/.test(value) ? Number(value) : NaN;

export function parseFeeRule(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const rule = { percent: 0n, on: "price", fixed: 0, min: 0, max: null, round: "up" }, seen = new Set();
  for (const part of text.split(",")) {
    const [key, value, extra] = part.split("=").map((item) => item?.trim());
    if (!keys.has(key) || seen.has(key) || value === undefined || value === "" || extra !== undefined) return null;
    seen.add(key);
    if (key === "percent") {
      const match = /^(\d{1,2})(?:\.(\d{1,4}))?$/.exec(value);
      if (!match) return null;
      rule.percent = BigInt(match[1]) * 10000n + BigInt((match[2] || "").padEnd(4, "0"));
      if (rule.percent > 500000n) return null;
    } else if (key === "on") {
      if (!["price", "gross"].includes(value)) return null;
      rule.on = value;
    } else if (key === "round") {
      if (!["up", "down", "nearest"].includes(value)) return null;
      rule.round = value;
    } else {
      rule[key] = whole(value);
      if (!Number.isSafeInteger(rule[key])) return null;
    }
  }
  if (!seen.has("percent") && !seen.has("fixed")) return null;
  if (rule.max !== null && rule.max < rule.min) return null;
  return Object.freeze(rule);
}

// The rules in force. Flutterwave's fees are not added on top of the price, so
// its payments never get a MeSomb quote.
export function paymentFeeRules(env = process.env) {
  if (!["mesomb", "mock"].includes(env.PAYMENT_MODE)) return {};
  return Object.fromEntries(feeNetworks.map((network) => [network, parseFeeRule(env[`PAYMENT_FEE_${network.toUpperCase()}`])]));
}

const divide = (numerator, denominator, round) => {
  const quotient = numerator / denominator, remainder = numerator % denominator;
  if (remainder === 0n || round === "down") return quotient;
  if (round === "up") return quotient + 1n;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
};

export function feeFor(price, rule) {
  const amount = BigInt(price);
  // gross: fee / (price + fee) = percent, so fee = price * percent / (1 - percent).
  const share = divide(amount * rule.percent, rule.on === "gross" ? SCALE - rule.percent : SCALE, rule.round);
  const fee = Number(share) + rule.fixed;
  return Math.min(Math.max(fee, rule.min), rule.max ?? Infinity);
}

// What the customer approves for this price on this network. fee and total are
// null when there is no rule: the screens never show a guessed number.
export function quotePayment(price, network, rules = {}) {
  const rule = feeNetworks.includes(network) ? rules[network] : null;
  if (!rule || !Number.isSafeInteger(price) || price < 0) return { price, fee: null, total: null, network };
  const fee = feeFor(price, rule);
  return { price, fee, total: price + fee, network };
}

// Both networks, for a screen that lets the customer switch between them.
export const paymentQuotes = (price, rules) =>
  Object.fromEntries(feeNetworks.map((network) => [network, quotePayment(price, network, rules)]));

export const withPaymentQuotes = (plan, rules) =>
  Number.isSafeInteger(plan?.price) ? { ...plan, paymentQuotes: paymentQuotes(plan.price, rules) } : plan;

// The fee MeSomb reports it charged on a transaction, when the numbers agree with
// the price we sent: `amount` is the price, `trxamount` the price plus `fees`.
export function providerCharge(raw, amount) {
  const fee = Number(raw?.fees), total = Number(raw?.trxamount);
  if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(total) || Math.abs(total - (amount + fee)) >= 1) return {};
  const cents = (value) => Math.round(value * 100) / 100;
  return { providerFee: cents(fee), providerTotal: cents(total) };
}

// Records a provider-reported charge on a payment. Returns the quote it differs
// from, for the caller to log once, or null.
export function recordProviderCharge(p, reported = {}) {
  if (!Number.isFinite(reported.providerFee) || (p.providerFee === reported.providerFee && p.providerTotal === reported.providerTotal)) return null;
  p.providerFee = reported.providerFee;
  p.providerTotal = reported.providerTotal;
  return Number.isFinite(p.fee) && p.fee !== reported.providerFee
    ? { quotedFee: p.fee, reportedFee: reported.providerFee, amount: p.amount, network: p.network || null } : null;
}

// The fee and total to show for a payment: what the provider reported charging,
// else what was quoted before paying, else nothing.
export function chargedAmounts(p) {
  if (Number.isFinite(p?.providerFee)) return { fee: p.providerFee, total: p.providerTotal };
  if (Number.isFinite(p?.fee) && Number.isFinite(p?.total)) return { fee: p.fee, total: p.total };
  return { fee: null, total: null };
}
