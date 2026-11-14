// Buying a bundle for someone else's number (#255, canvas: PhoneBuyForOther).
// The buyer pays with their own Mobile Money. After payment the bundle is
// saved for the recipient, never started:
//   - no account: a reservation (#254) the recipient claims with their number
//     and the code the buyer passes on;
//   - an account: saved in it, to start when they choose;
//   - an account with a bundle running: saved in it too. There is no queued
//     "next bundle" (decisions.md, Billing), so they start it once theirs ends.
import { randomUUID } from "node:crypto";
import { activeSubscription } from "./subscription-policy.mjs";
import { newReservation, START_DAYS } from "./reservations.mjs";

// Lookups per buyer per hour: enough to fix a typo, not to scan numbers.
export const RECIPIENT_LOOKUPS_PER_HOUR = 20;

const recipientOf = (s, phone) => s.customers.find((c) => c.phone === phone);
const unavailable = (c) => c && (c.status === "suspended" || c.suspended);

// What the buyer is told about a number. Only the case and, for a running
// bundle, the day it ends: never the recipient's stored name or other details.
export function recipientCase(s, buyer, phone, now) {
  if (phone === buyer.phone) return { case: "self" };
  const c = recipientOf(s, phone);
  if (!c) return { case: "noAccount" };
  if (unavailable(c)) return { case: "unavailable" };
  const active = activeSubscription(s, c.id, now);
  return active ? { case: "activeBundle", endsAt: active.expiresAt || null } : { case: "hasAccount" };
}

// Checks the recipient part of a gift purchase; returns the payment's gift
// record or an error outcome.
export function giftRequest(s, buyer, input, normalize, valid) {
  const recipientPhone = normalize(input.recipientPhone);
  if (!valid(recipientPhone)) return { error: { status: 400, body: { error: "Enter their Cameroon phone number." } } };
  if (recipientPhone === buyer.phone) return { error: { status: 400, body: { code: "GIFT_TO_SELF", error: "That's your own number. Buy your bundle from Internet." } } };
  if (unavailable(recipientOf(s, recipientPhone))) return { error: { status: 409, body: { code: "RECIPIENT_UNAVAILABLE", error: "This number can't receive a bundle. Check it with them." } } };
  const recipientName = String(input.recipientName || "").trim().slice(0, 60), note = String(input.note || "").trim().slice(0, 140);
  return { gift: { recipientPhone, ...(recipientName ? { recipientName } : {}), ...(note ? { note } : {}) } };
}

// Issues the paid gift's voucher. `code` makes a unique activation code.
export function giftVoucher(s, payment, buyer, plan, now, code) {
  const at = new Date(now), gift = payment.gift, recipient = recipientOf(s, gift.recipientPhone);
  const usable = recipient && !unavailable(recipient), active = usable && activeSubscription(s, recipient.id, at);
  const outcome = !usable ? "reserved" : active ? "savedUntilEnd" : "saved";
  const v = {
    id: randomUUID(), paymentId: payment.id, customerId: usable ? recipient.id : null, planId: plan.id, code: code(s),
    status: "available", activatedAt: null, expiresAt: null,
    quotaBytes: plan.quotaGb === null ? null : plan.quotaGb * 1e9, usedBytes: 0, deviceLimit: plan.deviceLimit,
    saleType: "sold", saleAmount: payment.amount, faceValue: plan.price, createdAt: at.toISOString(),
    giftedBy: buyer.id, giftedAt: at.toISOString(), ...(gift.note ? { giftNote: gift.note } : {}),
    // The voucher email goes to an account holder; an unclaimed number gets the code from the buyer.
    emailStatus: usable ? "pending" : "not_applicable", emailAttempts: usable ? 0 : 5,
    ...(usable ? { startBy: new Date(+at + START_DAYS * 864e5).toISOString() }
      : { reservation: newReservation(gift.recipientPhone, { type: "customer", id: buyer.id }, at, gift.note) }),
  };
  s.vouchers.unshift(v);
  Object.assign(gift, { outcome, voucherId: v.id, ...(active ? { recipientBundleEndsAt: active.expiresAt || null } : {}) });
  return v;
}

// What the buyer's payment status shows about the gift: who it's for, what
// happened, and the plan. The code itself is the existing `access.code`.
export function giftView(payment) {
  const g = payment.gift;
  if (!g) return null;
  return { recipientPhone: g.recipientPhone, recipientName: g.recipientName || null, note: g.note || null, outcome: g.outcome || null,
    recipientBundleEndsAt: g.recipientBundleEndsAt || null };
}
