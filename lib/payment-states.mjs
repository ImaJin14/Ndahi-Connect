// Payment states the customer sees (#433; 24 Nov brief §3,
// docs/redesign/specs/catalogue-and-payment-update-2026-11-24.md; canvas
// PhonePaymentFailed, #409). Every provider answer, from a poll or an
// authenticated webhook, becomes one of:
//
//   paid · pending · expired · cancelled_or_pin · invalid_subscriber ·
//   insufficient_funds · unclear
//
// Specific provider codes win over message text, an explicit PIN error is read
// before broad invalid-number wording, and anything ambiguous is "unclear":
// a cause is never guessed. The older `failureCode` (declined, low_balance,
// check_balance, wrong_network, timeout) stays for the current screens.
import { catalogue, findPlan } from "./api/state.mjs";
import { quotePayment } from "./payment-fees.mjs";

export const PAYMENT_STATES = Object.freeze(["paid", "pending", "expired", "cancelled_or_pin", "invalid_subscriber", "insufficient_funds", "unclear"]);

// Provider error codes (MeSomb sends kebab or snake case; Flutterwave and the
// operators' own codes too), read before any message text.
const CODES = [
  [/(?:^|[^a-z])(?:pin|secret.?code|code.?secret)(?:[^a-z]|$)/, "cancelled_or_pin"],
  [/insufficient|balance|not.?enough.?(?:funds|money)/, "insufficient_funds"],
  [/cancel|declined|rejected.?by/, "cancelled_or_pin"],
  [/timeout|time.?out|expired/, "expired"],
  [/(?:subscriber|msisdn|account|number|payer).?not.?(?:found|registered|exist)|unknown.?(?:subscriber|msisdn|number)|invalid.?(?:subscriber|msisdn|number|phone|account)|unregistered|wrong.?(?:network|operator)/, "invalid_subscriber"],
  [/internal.?error|general.?error|unknown.?error/, "unclear"],
];
// Message wording, in the same order of trust.
const CATCH_ALL = /subscriber internal error|it can be\s*:/i;
const PIN = /\b(?:pin|secret code|code secret|code pin|wrong code|incorrect code|mot de passe)\b/i;
const CANCELLED = /\b(?:cancel(?:l?ed|lation)?|annul(?:é|ée|e|ee)?|(?:declined|rejected|refused) by (?:the )?(?:user|customer|subscriber|payer)|(?:user|customer|subscriber|payer) (?:cancelled|canceled|declined|rejected|refused))\b/i;
const EXPIRED = /\b(?:expired|timed? ?out|timeout|délai (?:dépassé|expiré)|expiré)\b/i;
const INVALID = /not (?:registered|subscribed) (?:for|to|on|with) (?:mobile money|momo|orange money|mtn|orange)|no (?:mobile money|momo|orange money) account|wrong (?:network|operator)|(?:network|operator) mismatch|invalid (?:subscriber|msisdn|phone number|number|account)|(?:subscriber|number|msisdn) (?:not found|does not exist|unknown)|unknown (?:subscriber|number)|numéro (?:invalide|inconnu|non enregistré)/i;
const INSUFFICIENT = /insufficient|not enough (?:money|funds|balance)|low balance|solde insuffisant|customer balance invalid|balance is low/i;
const FIELDS = ["detail", "message", "processor_response", "reason", "status_message", "narration", "error"];

// One provider answer (a transaction, or an error response merged into one
// object with `code`, `message` and `detail`) as a state.
export function providerResultState(raw) {
  if (!raw || typeof raw !== "object") return "unclear";
  const status = String(raw.status ?? raw.transaction?.status ?? "").toUpperCase();
  if (raw.success !== false && status === "SUCCESS") return "paid";
  if (["EXPIRED", "TIMEOUT", "TIMED_OUT"].includes(status)) return "expired";
  const code = [raw.code, raw.error_code, raw.errorCode].filter((value) => typeof value === "string" && value.trim()).join(" ").toLowerCase();
  const text = FIELDS.map((key) => raw[key]).filter((value) => typeof value === "string").join(" ").replace(/[_-]+/g, " ");
  if (code) for (const [pattern, state] of CODES) if (pattern.test(code)) return state;
  if (CATCH_ALL.test(text)) return "unclear";
  if (PIN.test(text)) return "cancelled_or_pin";
  if (CANCELLED.test(text)) return "cancelled_or_pin";
  if (EXPIRED.test(text)) return "expired";
  if (INVALID.test(text)) return "invalid_subscriber";
  if (INSUFFICIENT.test(text)) return "insufficient_funds";
  if (["PENDING", "PROCESSING", "INITIATED", "IN_PROGRESS"].includes(status)) return "pending";
  return "unclear";
}

// The older reason codes, for answers recorded before #433.
const FROM_CODE = { low_balance: "insufficient_funds", check_balance: "insufficient_funds", wrong_network: "invalid_subscriber" };

// A payment's state now. Pending until the provider answers; a closed checkout
// (its request window over) reads as expired; a provider that couldn't confirm
// the result, or an answer held for review, is "unclear".
export function paymentState(p) {
  if (p.confirmedAt || ["paid", "refunded", "refund-pending"].includes(p.status)) return "paid";
  if (p.verificationHold) return "unclear";
  const ended = ["failed", "expired", "cancelled"].includes(p.status);
  if (ended && p.providerFailedAt) return p.status === "expired" ? "expired" : p.failureState || FROM_CODE[p.failureCode] || "unclear";
  if (ended || p.checkoutClosedAt) return "expired";
  if (p.verificationError || p.creationState === "uncertain") return "unclear";
  return "pending";
}

// Retry only once the previous attempt has certainly ended: the provider
// confirmed it, the request never reached the provider, or its window closed.
export function retryAllowed(p) {
  if (p.confirmedAt || p.verificationHold || ["paid", "refunded", "refund-pending"].includes(p.status)) return false;
  const ended = ["failed", "expired", "cancelled"].includes(p.status);
  return Boolean(ended && (p.providerFailedAt || p.checkoutClosedAt || ["refused", "reserved", "rejected"].includes(p.creationState)));
}

// Where to look the payment up: the provider's reference, else NDAHI's own id.
export const paymentReference = (p) => (p.providerReference && String(p.providerReference) !== p.id ? String(p.providerReference) : p.id);

// The cheaper bundle offered after "insufficient funds", when this network's
// fee is verified (a numeric quote): the highest-priced bundle on sale strictly
// below the attempted base price, of the same kind (fixed-data, Personal
// Unlimited, Home WISP). Ties go to the device count closest to the one asked
// for, then the longer validity, then the display order. None: no suggestion.
const kind = (plan) => plan?.accessType || "fixed_data";
const devices = (plan) => Number(plan?.deviceSlots ?? plan?.deviceLimit ?? 1);
export function cheaperBundle(s, p, rules) {
  const asked = p.planSnapshot || findPlan(s, p.planId);
  if (!asked || !Number.isSafeInteger(p.amount)) return null;
  const onSale = catalogue(s);
  const candidates = onSale.map((plan, order) => ({ plan, order }))
    .filter(({ plan }) => plan.id !== p.planId && kind(plan) === kind(asked) && Number.isSafeInteger(plan.price) && plan.price > 0 && plan.price < p.amount)
    .sort((a, b) => b.plan.price - a.plan.price ||
      Math.abs(devices(a.plan) - devices(asked)) - Math.abs(devices(b.plan) - devices(asked)) ||
      Number(b.plan.validityHours) - Number(a.plan.validityHours) || a.order - b.order);
  const best = candidates[0]?.plan;
  if (!best) return null;
  const quote = quotePayment(best.price, p.network, rules);
  if (quote.fee === null) return null;
  return { planId: best.id, name: best.name, accessType: best.accessType || null, validityHours: best.validityHours,
    ...(best.validityValue ? { validityValue: best.validityValue, validityUnit: best.validityUnit } : {}),
    deviceSlots: best.accessType === "personal_unlimited" ? best.deviceSlots : null, deviceLimit: best.deviceLimit ?? null,
    price: best.price, fee: quote.fee, total: quote.total, network: p.network };
}

// The operators' USSD codes for pending prompts, in "Payment request expired"
// (PhonePaymentFailed). The owner confirmed them for Cameroon on 26 Nov (#409),
// so they show unless PAYMENT_SHORT_CODES=off.
export const shortCodes = (env = {}) => (env.PAYMENT_SHORT_CODES === "off" ? null : { mtn: "*126#", orange: "#150#" });

// Payment confirmed and Wi-Fi active are separate (canvas PhoneReceipt): the
// bundle can wait for its first connection or the router.
export function activationState(p, v) {
  if (!p.confirmedAt && p.status !== "paid") return null;
  if (p.fulfillmentStatus === "needs_review") return "review";
  if (!v) return "activating";
  if (v.status === "available" && v.startsOnFirstConnection) return "waiting_first_connection";
  if (v.status === "active") return v.routerSyncStatus === "synchronized" || v.homeStatus === "connected" ? "active" : "activating";
  return v.status;
}
