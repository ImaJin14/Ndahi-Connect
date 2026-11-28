// Referrals (#527), paid in points on the ledger (#526). Rules:
// docs/redesign/decisions.md → "Rewards: points and referrals (27 Nov)".
//
// - Every account has a short code (AMINA-7K2: the first name and three
//   characters with no look-alikes) and a link, <portal>/r/<CODE>.
// - A number new to NDAHI that checks out with a code keeps it (a pending
//   referral) until its first bundle payment. A number that already has an
//   account, or the referrer's own, can't use one.
// - When that first payment settles, and it is at least the smallest first
//   bundle (500 XAF), the referrer gets 200 points and the friend 100. Once per
//   new number.
// - Never paid: the friend paying from the referrer's number or a Mobile Money
//   number the referrer has paid from. Past the monthly cap (10 friends), the
//   friend is recorded but not paid.
// - Held for the owner's review, with no points until approved: the friend on
//   a Wi-Fi device the referrer uses, several friends paid from one Mobile
//   Money number, or a burst of friends in one day.
// - A refund of the friend's first payment takes both payouts back.
import { randomInt, randomUUID } from "node:crypto";
import { appendRow, bundleSummary, ledgerRow, redeemOpen, rewardOffers, rewardSettings, takeBackCredit } from "./rewards.mjs";
import { maskPhone } from "./reservations.mjs";

// More friends than this in one day, for one referrer, is a burst (owner review).
export const BURST_PER_DAY = 5;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", CODE = /^[A-Z]{1,8}-[A-HJ-KM-NP-Z2-9]{3}$/;
const list = (s) => (Array.isArray(s.referrals) ? s.referrals : (s.referrals = []));
const customer = (s, id) => (s.customers || []).find((c) => c.id === id);
const usable = (c) => c && c.status !== "suspended" && !c.suspended;
const digits = (phone) => String(phone || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, "");

export const normalCode = (code) => String(code || "").trim().toUpperCase();
// Checkout names an account "Customer" until the customer gives a name: that is no name.
const realName = (name) => (String(name || "").trim() === "Customer" ? "" : String(name || "").trim());
const prefixOf = (name) => realName(name).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().split(/\s+/)[0]
  .toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8) || "NDAHI";
// What a friend sees: "Amina" on the invitation, "J. Fon" in their history.
export const firstName = (name) => realName(name).split(/\s+/)[0] || "";
export const shortName = (name) => {
  const parts = realName(name).split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0][0]}. ${parts.at(-1)}` : parts[0] || "";
};

// The account's code, made the first time it's needed.
export function referralCode(s, c) {
  if (c.referralCode) return c.referralCode;
  const prefix = prefixOf(c.name), taken = new Set((s.customers || []).map((x) => x.referralCode).filter(Boolean));
  for (let i = 0; i < 100; i++) {
    const code = `${prefix}-${Array.from({ length: 3 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;
    if (!taken.has(code)) return (c.referralCode = code);
  }
  throw Error("No referral code is free for this name.");
}
export const referrerOf = (s, code) => {
  const k = normalCode(code);
  return CODE.test(k) ? (s.customers || []).find((c) => c.referralCode === k && usable(c)) : undefined;
};

// GET /api/referrals/<code> (PhoneInvite): never the referrer's number.
export function referralLanding(s, code) {
  const { referrals: rules } = rewardSettings(s), referrer = rules.enabled && referrerOf(s, code);
  if (!referrer) return { valid: false };
  // The best bundle the welcome points alone can redeem ("enough for a free 24-hour bundle").
  const free = redeemOpen(s) ? rewardOffers(s).filter((o) => o.redeemable && o.points <= rules.welcomePoints).sort((a, b) => b.points - a.points)[0] : null;
  return { valid: true, code: referrer.referralCode, firstName: firstName(referrer.name), welcomePoints: rules.welcomePoints,
    freeBundle: free ? bundleSummary(free.bundle) : null };
}

// New to NDAHI: no bundle and no confirmed payment yet (the checkout in hand aside).
const isNew = (s, c, paymentId) => !(s.vouchers || []).some((v) => v.customerId === c.id) &&
  !(s.payments || []).some((p) => p.customerId === c.id && p.id !== paymentId && (p.confirmedAt || ["paid", "refunded", "refund-pending"].includes(p.status)));

// At checkout: a new number keeps the first valid code it arrives with.
export function attributeReferral(s, friend, code, now, { paymentId } = {}) {
  const { referrals: rules } = rewardSettings(s);
  if (!rules.enabled) return { status: "off" };
  const referrer = referrerOf(s, code);
  if (!referrer) return { status: "invalid" };
  if (referrer.id === friend.id || digits(referrer.phone) === digits(friend.phone)) return { status: "own" };
  const kept = list(s).find((r) => r.friendId === friend.id);
  if (kept) return { status: "kept", referral: kept };
  if (!isNew(s, friend, paymentId)) return { status: "not_new" };
  const r = { id: randomUUID(), referrerId: referrer.id, friendId: friend.id, code: referrer.referralCode, status: "pending",
    at: new Date(now).toISOString(), attributedAt: new Date(now).toISOString() };
  list(s).push(r);
  return { status: "attributed", referral: r };
}

// Every device the account has used: approved Wi-Fi devices and each bundle's devices.
function devicesOf(s, customerId) {
  const macs = new Set();
  for (const g of s.wifiDeviceGrants || []) if (g.customerId === customerId && g.mac) macs.add(String(g.mac).toUpperCase());
  for (const v of s.vouchers || []) if (v.customerId === customerId) for (const d of v.wifiDevices || []) if (d?.mac) macs.add(String(d.mac).toUpperCase());
  return macs;
}
const payersOf = (s, customerId) => new Set((s.payments || []).filter((p) => p.customerId === customerId && p.payerPhone).map((p) => digits(p.payerPhone)));

function pay(s, r, now) {
  const { referrals: rules } = rewardSettings(s), referrer = customer(s, r.referrerId), friend = customer(s, r.friendId);
  const paid = appendRow(s, { customerId: r.referrerId, kind: "referral", points: rules.referrerPoints, referralId: r.id, friend: maskPhone(friend?.phone), key: `referral:${r.id}` }, now);
  const welcome = appendRow(s, { customerId: r.friendId, kind: "welcome", points: rules.welcomePoints, referralId: r.id,
    invitedBy: { name: shortName(referrer?.name), code: r.code }, key: `welcome:${r.id}` }, now);
  Object.assign(r, { status: "paid", paidAt: new Date(now).toISOString(), points: { referrer: paid.points, welcome: welcome.points } });
  return r;
}

// The friend's first bundle payment has settled: pay, hold, or record why not. Once.
export function referralOnPayment(s, p, now) {
  const r = list(s).find((x) => x.friendId === p.customerId && x.status === "pending");
  if (!r || p.gift || p.status !== "paid") return null;
  const { referrals: rules } = rewardSettings(s), at = new Date(now).toISOString();
  const referrer = customer(s, r.referrerId), friend = customer(s, r.friendId);
  Object.assign(r, { paymentId: p.id, firstPayment: p.amount, payer: digits(p.payerPhone), decidedAt: at });
  const close = (status, reason) => Object.assign(r, { status, reason });
  if (!rules.enabled || !(Date.parse(p.createdAt) >= Date.parse(rules.enabledAt))) return close("ineligible", "programme_off");
  if (!(p.amount >= rules.minFirstBundleXaf)) return close("ineligible", "below_minimum");
  if (!usable(referrer) || !friend) return close("ineligible", "referrer_unavailable");
  if (digits(friend.phone) === digits(referrer.phone) || r.payer === digits(referrer.phone) || payersOf(s, referrer.id).has(r.payer))
    return close("rejected", "referrer_number");
  const month = at.slice(0, 7), day = at.slice(0, 10), others = list(s).filter((x) => x.id !== r.id && x.referrerId === r.referrerId && x.decidedAt);
  if (others.filter((x) => ["paid", "held"].includes(x.status) && x.decidedAt.slice(0, 7) === month).length >= rules.monthlyCap) return close("capped", "monthly_cap");
  const reasons = [];
  const mine = devicesOf(s, referrer.id);
  if ([...devicesOf(s, friend.id)].some((mac) => mine.has(mac))) reasons.push("same_device");
  if (others.some((x) => x.payer && x.payer === r.payer)) reasons.push("same_payer");
  if (others.filter((x) => x.decidedAt.slice(0, 10) === day).length + 1 > BURST_PER_DAY) reasons.push("burst");
  if (reasons.length) return Object.assign(r, { status: "held", reasons });
  return pay(s, r, now);
}

// The owner's decision on a held referral.
export function decideReferral(s, id, decision, now, actor) {
  const r = list(s).find((x) => x.id === id);
  if (!r) return { error: { status: 404, message: "Referral not found." } };
  if (r.status !== "held") return { error: { status: 409, message: "This referral has already been decided." } };
  Object.assign(r, { reviewedAt: new Date(now).toISOString(), reviewedBy: actor });
  if (decision === "reject") return { referral: Object.assign(r, { status: "rejected", reason: "owner_rejected" }) };
  return { referral: pay(s, r, now) };
}

// A completed refund of the friend's first payment takes both payouts back.
export function reverseReferralForPayment(s, p, now) {
  const r = list(s).find((x) => x.paymentId === p.id);
  if (!r) return null;
  if (r.status === "held") return Object.assign(r, { status: "rejected", reason: "first_payment_refunded" });
  if (r.status !== "paid") return null;
  for (const key of [`referral:${r.id}`, `welcome:${r.id}`]) takeBackCredit(s, ledgerRow(s, key), `refund:${key}`, now, { referralId: r.id });
  return Object.assign(r, { status: "reversed", reversedAt: new Date(now).toISOString() });
}

// The Invite friends tab: the code, the link and the friends (masked numbers).
export function accountReferralView(s, c, origin) {
  const { referrals: rules } = rewardSettings(s);
  if (!rules.enabled) return null;
  const code = referralCode(s, c);
  return {
    code, link: `${String(origin || "").replace(/\/$/, "")}/r/${code}`,
    // Joined friends first, newest first, then those who haven't bought yet (as drawn).
    friends: list(s).filter((r) => r.referrerId === c.id).sort((a, b) => (a.status === "paid") !== (b.status === "paid") ? (a.status === "paid" ? -1 : 1)
      : ((a.paidAt || a.at) < (b.paidAt || b.at) ? 1 : -1)).slice(0, 50).map((r) => ({
      id: r.id, phone: maskPhone(customer(s, r.friendId)?.phone), at: r.paidAt || r.at,
      status: r.status === "paid" ? "joined" : r.status === "pending" || r.status === "held" ? "pending" : "not_counted",
      ...(r.status === "paid" ? { points: r.points?.referrer ?? null } : {}) })),
  };
}

const REASONS = Object.freeze({ same_device: "same_device", same_payer: "same_payer", burst: "burst" });
export function referralReviewView(s, r) {
  const referrer = customer(s, r.referrerId), friend = customer(s, r.friendId);
  return { id: r.id, code: r.code, status: r.status, reasons: (r.reasons || []).filter((x) => REASONS[x]), at: r.decidedAt || r.at,
    referrer: { id: r.referrerId, name: referrer?.name || "", phone: maskPhone(referrer?.phone) },
    friend: { id: r.friendId, phone: maskPhone(friend?.phone) }, firstPayment: r.firstPayment ?? null, payer: maskPhone(r.payer) };
}

// Owner figures: friends joined this month (and points to referrers), referrals held.
export function referralMetrics(s, now) {
  const month = new Date(now).toISOString().slice(0, 7), joined = list(s).filter((r) => r.status === "paid" && r.paidAt?.slice(0, 7) === month);
  return { friendsThisMonth: { count: joined.length, points: joined.reduce((n, r) => n + (r.points?.referrer || 0), 0) },
    flagged: list(s).filter((r) => r.status === "held").length };
}
export const referralsByStatus = (s, status) => list(s).filter((r) => !status || r.status === status).sort((a, b) => ((a.decidedAt || a.at) < (b.decidedAt || b.at) ? 1 : -1));
