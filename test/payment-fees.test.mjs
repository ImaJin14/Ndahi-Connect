// The Mobile Money fee and total a customer approves (#297): one quote per network
// from the configured rule, null when no rule is set (never a guessed number), and
// MeSomb's reported fee recorded beside the quote.
import test from "node:test";
import assert from "node:assert/strict";
import { chargedAmounts, feeFor, parseFeeRule, paymentFeeRules, paymentQuotes, providerCharge, quotePayment,
  recordProviderCharge, withPaymentQuotes } from "../lib/payment-fees.mjs";
import { feeObservations, feeSummary } from "../scripts/check-payment-fees.mjs";

const rules = (mtn, orange) => paymentFeeRules({ PAYMENT_MODE: "mesomb", PAYMENT_FEE_MTN: mtn, PAYMENT_FEE_ORANGE: orange });

test("a rule reads percent, basis, fixed amount, bounds and rounding, and rejects anything else", () => {
  const rule = parseFeeRule("percent=2.5, on=gross, fixed=10, min=50, max=3500, round=nearest");
  assert.deepEqual({ ...rule, percent: String(rule.percent) }, { percent: "25000", on: "gross", fixed: 10, min: 50, max: 3500, round: "nearest" });
  assert.equal(parseFeeRule("fixed=100").percent, 0n);
  for (const text of ["", " ", "percent", "percent=", "percent=2,percent=3", "percent=51", "percent=-1", "percent=2.12345", "percent=abc",
    "percent=2,on=net", "percent=2,round=ceil", "percent=2,min=10,max=5", "percent=2,fixed=1.5", "percent=2,colour=red", "on=price", "percent=2=3"])
    assert.equal(parseFeeRule(text), null, text);
  assert.equal(parseFeeRule(undefined), null);
});

test("the quote per network: price, fee and total, with integer arithmetic", () => {
  const r = rules("percent=2", "percent=2,on=gross,round=down");
  assert.deepEqual(quotePayment(30000, "mtn", r), { price: 30000, fee: 600, total: 30600, network: "mtn" });
  assert.deepEqual(quotePayment(5000, "mtn", r), { price: 5000, fee: 100, total: 5100, network: "mtn" });
  // gross: 2% of what is collected, so 5000 / 0.98 = 5102.04 -> 102 rounded down.
  assert.deepEqual(quotePayment(5000, "orange", r), { price: 5000, fee: 102, total: 5102, network: "orange" });
  assert.deepEqual(paymentQuotes(1000, r), { mtn: { price: 1000, fee: 20, total: 1020, network: "mtn" }, orange: { price: 1000, fee: 20, total: 1020, network: "orange" } });
  // Rounding: up by default, so a total is never below what is asked.
  assert.equal(feeFor(1234, parseFeeRule("percent=2")), 25);
  assert.equal(feeFor(1234, parseFeeRule("percent=2,round=down")), 24);
  assert.equal(feeFor(1225, parseFeeRule("percent=2,round=nearest")), 25);
  assert.equal(feeFor(1224, parseFeeRule("percent=2,round=nearest")), 24);
  // No floating-point drift on exact amounts (30000 * 0.02 is not exactly 600 in floats).
  assert.equal(feeFor(30000, parseFeeRule("percent=2")), 600);
  assert.equal(feeFor(100, parseFeeRule("percent=1.5,fixed=4")), 6);
  assert.equal(feeFor(1000, parseFeeRule("percent=2,min=50")), 50);
  assert.equal(feeFor(500000, parseFeeRule("percent=2,max=3500")), 3500);
});

test("no rule, an invalid rule, another network or Flutterwave give no number", () => {
  const unavailable = { price: 5000, fee: null, total: null };
  assert.deepEqual(quotePayment(5000, "mtn", rules(undefined, "percent=2")), { ...unavailable, network: "mtn" });
  assert.deepEqual(quotePayment(5000, "mtn", rules("percent=two", "percent=2")), { ...unavailable, network: "mtn" });
  assert.deepEqual(quotePayment(5000, "airtel", rules("percent=2", "percent=2")), { ...unavailable, network: "airtel" });
  assert.deepEqual(quotePayment(5000, undefined, rules("percent=2", "percent=2")), { ...unavailable, network: undefined });
  assert.deepEqual(paymentFeeRules({ PAYMENT_MODE: "flutterwave", PAYMENT_FEE_MTN: "percent=2" }), {});
  assert.deepEqual(paymentFeeRules({ PAYMENT_FEE_MTN: "percent=2" }), {}, "no payment mode is not MeSomb");
  assert.ok(paymentFeeRules({ PAYMENT_MODE: "mock", PAYMENT_FEE_MTN: "percent=2" }).mtn);
  const plan = withPaymentQuotes({ id: "weekly", price: 1500 }, rules("percent=2"));
  assert.deepEqual(plan.paymentQuotes.mtn, { price: 1500, fee: 30, total: 1530, network: "mtn" });
  assert.equal(plan.paymentQuotes.orange.fee, null);
  assert.deepEqual(withPaymentQuotes({ id: "free" }, rules("percent=2")), { id: "free" });
});

test("MeSomb's reported fee is kept only when it agrees with the price, and replaces the quote", () => {
  assert.deepEqual(providerCharge({ amount: 5000, fees: 102, trxamount: 5102 }, 5000), { providerFee: 102, providerTotal: 5102 });
  assert.deepEqual(providerCharge({ fees: "100", trxamount: "5100" }, 5000), { providerFee: 100, providerTotal: 5100 });
  for (const raw of [{ fees: 102, trxamount: 6000 }, { fees: -1, trxamount: 4999 }, { fees: 102 }, {}, null])
    assert.deepEqual(providerCharge(raw, 5000), {}, JSON.stringify(raw));
  const p = { amount: 5000, fee: 100, total: 5100, network: "mtn" };
  assert.deepEqual(chargedAmounts(p), { fee: 100, total: 5100 });
  assert.deepEqual(recordProviderCharge(p, { providerFee: 102, providerTotal: 5102 }), { quotedFee: 100, reportedFee: 102, amount: 5000, network: "mtn" });
  assert.equal(recordProviderCharge(p, { providerFee: 102, providerTotal: 5102 }), null, "a difference is reported once");
  assert.deepEqual(chargedAmounts(p), { fee: 102, total: 5102 });
  assert.equal(recordProviderCharge({ amount: 5000, fee: 100, total: 5100 }, { providerFee: 100, providerTotal: 5100 }), null, "a matching fee is not a mismatch");
  assert.equal(recordProviderCharge(p, {}), null);
  assert.deepEqual(chargedAmounts({ amount: 5000, fee: null, total: null }), { fee: null, total: null });
});

test("the fee checker compares each MeSomb fee with the rule for its network", () => {
  const r = rules("percent=2", "percent=2,on=gross,round=down");
  const rows = feeObservations([
    { payment: "a", network: "mtn", amount: 30000, fee: 600 },
    { payment: "b", network: "mtn", amount: 5000, fee: 102 },
    { payment: "c", network: "orange", amount: 5000, fee: 102 },
    { payment: "d", network: "orange", amount: Number.NaN, fee: 3 },
  ], r);
  assert.equal(rows.length, 3, "a transaction without numbers is skipped");
  assert.deepEqual(rows.map((row) => [row.quoted, row.matches, row.onPrice, row.onTotal]),
    [[600, true, 2, 1.9608], [100, false, 2.04, 1.9992], [102, true, 2.04, 1.9992]]);
  const summary = feeSummary(rows, r);
  assert.deepEqual(summary.mtn, { payments: 2, rule: "set", feePercentOfPrice: [2, 2.04], feePercentOfTotal: [1.9608, 1.9992], ruleMatches: false,
    mismatches: [{ amount: 5000, fee: 102, quoted: 100 }] });
  assert.equal(summary.orange.ruleMatches, true);
  assert.equal(feeSummary(feeObservations([{ network: "mtn", amount: 1000, fee: 20 }], {}), {}).mtn.ruleMatches, null);
});
