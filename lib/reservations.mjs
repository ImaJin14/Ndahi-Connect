// Vouchers reserved for a phone number (#254, server task 3; canvas:
// PhoneClaimGift, AdminVoucherDetail "Waiting for claim"). Staff give a
// voucher to a number that has no account yet. Claiming needs that number and
// the code; there is no SMS, so the code is the proof. Claiming saves the
// bundle in the account; starting it is a separate step (the redeem call).
import { safeEqual } from "./security.mjs";

// Owner decisions recorded in docs/redesign/decisions.md (both pending): an
// unclaimed reservation expires after 90 days, and a claimed bundle waits 90
// days to be started.
export const RESERVATION_DAYS = 90;
export const START_DAYS = 90;
// Wrong claims per number or per address before a 15-minute wait.
export const CLAIM_ATTEMPTS = 5;
export const CLAIM_WINDOW_MS = 15 * 60_000;
const DAY = 864e5;

export function newReservation(phone, by, now, note) {
  const at = new Date(now);
  return {
    phone, status: "waiting", wrongAttempts: 0, by,
    ...(note ? { note: String(note).trim().slice(0, 140) } : {}),
    createdAt: at.toISOString(), expiresAt: new Date(+at + RESERVATION_DAYS * DAY).toISOString(),
  };
}

// waiting, claimed, expired or revoked; null for a voucher never reserved.
export function reservationState(v, now) {
  const r = v && v.reservation;
  if (!r) return null;
  if (r.status === "waiting" && !(Date.parse(r.expiresAt) > +now)) return "expired";
  return r.status;
}

// True when a code entry for this number must not take the voucher: it waits
// for another number, or its reservation has expired or been revoked.
export function reservedAgainst(v, phone, now) {
  const state = reservationState(v, now);
  if (state === "waiting") return !safeEqual(String(v.reservation.phone), String(phone || ""));
  return state === "expired" || state === "revoked";
}

export function waitingFor(v, phone, now) {
  return reservationState(v, now) === "waiting" && safeEqual(String(v.reservation.phone), String(phone || ""));
}

// Saves the voucher in the customer's account. Its days start only when the
// customer starts it, within START_DAYS.
export function claimReservation(v, customer, now, how) {
  const at = new Date(now).toISOString();
  Object.assign(v.reservation, { status: "claimed", claimedAt: at, claimedBy: how, customerId: customer.id });
  v.customerId = customer.id;
  v.startBy = new Date(+new Date(now) + START_DAYS * DAY).toISOString();
}

// A wrong number for a reserved code counts against that reservation (the
// staff page shows the count).
export function recordWrongClaim(v, now) {
  if (reservationState(v, now) !== "waiting") return;
  v.reservation.wrongAttempts = Number(v.reservation.wrongAttempts || 0) + 1;
  v.reservation.lastWrongAttemptAt = new Date(now).toISOString();
}

// A paid Mobile Money payment from the reserved number, for that number's own
// account, claims the vouchers waiting for it (the canvas: "Claimed
// automatically if this number pays for anything with Mobile Money").
export function claimReservationsByPayment(s, payment, customer, now, normalize) {
  if (!payment || payment.status !== "paid" || !customer) return [];
  const payer = normalize(payment.payerPhone);
  if (!payer || payer !== customer.phone) return [];
  const claimed = s.vouchers.filter((v) => v.status === "available" && !v.customerId && waitingFor(v, payer, now));
  for (const v of claimed) claimReservation(v, customer, now, "payment");
  return claimed;
}

// "Amina N." from "Amina Nfor": how a friend's gift names its giver.
const shortName = (name) => {
  const [first, last] = String(name || "").trim().split(/\s+/);
  return first ? `${first}${last ? ` ${last[0].toUpperCase()}.` : ""}` : "";
};

// What the claim page shows about the gift. Plan facts come from the plan the
// voucher was made with.
export function giftView(s, v, plan) {
  const r = v.reservation, giver = r.by?.type === "customer" && s.customers.find((c) => c.id === r.by.id);
  return {
    voucherId: v.id,
    plan: plan ? { id: plan.id, name: plan.name, quotaBytes: v.quotaBytes ?? null, validityHours: plan.validityHours, deviceLimit: v.deviceLimit ?? plan.deviceLimit } : null,
    from: giver && shortName(giver.name) ? { type: "friend", name: shortName(giver.name) } : { type: "ndahi" },
    note: r.note || null,
    claimBy: r.expiresAt,
  };
}

// The staff view of a reservation; the number only for roles that see contacts.
export function reservationView(v, now, { contacts }) {
  const r = v.reservation;
  if (!r) return null;
  return {
    status: reservationState(v, now), expiresAt: r.expiresAt, createdAt: r.createdAt, wrongAttempts: Number(r.wrongAttempts || 0),
    by: r.by?.type || "admin", claimedAt: r.claimedAt || null, claimedBy: r.claimedBy || null,
    ...(contacts ? { phone: r.phone } : {}),
  };
}

// "6•• •• 99 10": numbers in audit entries and staff lines.
export function maskPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, "");
  return d.length === 9 ? `${d[0]}•• •• ${d.slice(5, 7)} ${d.slice(7)}` : "";
}
