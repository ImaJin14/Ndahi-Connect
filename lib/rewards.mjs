// Rewards points (#526): earned on bundle payments, redeemed for bundles.
// Rules: docs/redesign/decisions.md → "Rewards: points and referrals (27 Nov)".
//
// - The ledger (`s.pointsLedger`, stored as `points_ledger` rows) is append-only:
//   rows are never edited or deleted, and the balance is their sum.
// - Credits (earned, referral, welcome, a positive adjustment) are lots that
//   expire after the expiry setting; every debit (redeemed, refunded, expired,
//   a negative adjustment) uses the oldest points first.
// - Points are earned only on a confirmed bundle payment that passed the
//   provider checks (#432), on the bundle price (never the Mobile Money fee),
//   once per payment, and only for payments made while the programme is on.
//   Gifts, custom bundles, admin vouchers, promotion bonuses and redeemed
//   bundles earn nothing (none of them is a bundle payment of one's own).
// - A refund takes back the points that payment earned. The balance never goes
//   below zero: what can't be taken back is recorded as a shortfall and taken
//   from the next points earned.
// - Redeeming saves a bundle on the account with that bundle's terms copied at
//   redemption. The customer starts it within the window, never while another
//   bundle is active; unstarted by then, it expires and the points stay spent.
// - Points are never cash and never revenue: a redeemed bundle has no payment
//   and no sale amount.
import { randomUUID } from "node:crypto";
import { accessTerms, catalogueMode, isUnlimitedBundle, unlimitedOnSale } from "./catalogue.mjs";
import { issueSpeedSnapshot } from "./bundle-speed-policy.mjs";
import { activeSubscription } from "./subscription-policy.mjs";
import { enqueueRouterCommand } from "./router-queue.mjs";

const DAY = 864e5, HOUR = 36e5;
export const EXPIRY_MONTHS = Object.freeze([6, 12, 24]);
export const START_WITHIN_DAYS = Object.freeze([30, 60, 90]);
export const DEFAULTS = Object.freeze({
  points: Object.freeze({ enabled: false, enabledAt: null, xafPerPoint: 100, pointValueXaf: 5, expiryMonths: 12, startWithinDays: 60 }),
  referrals: Object.freeze({ enabled: false, enabledAt: null, referrerPoints: 200, welcomePoints: 100, monthlyCap: 10, minFirstBundleXaf: 500 }),
});
const CREDITS = new Set(["earned", "referral", "welcome", "adjusted"]);
export const LEDGER_KINDS = Object.freeze(["earned", "referral", "welcome", "redeemed", "expired", "refunded", "adjusted"]);

export class RewardsError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new RewardsError(message, status, code); };

export function rewardSettings(s) {
  const r = s?.rewardsSettings && typeof s.rewardsSettings === "object" ? s.rewardsSettings : {};
  return {
    points: { ...DEFAULTS.points, ...(r.points || {}) },
    referrals: { ...DEFAULTS.referrals, ...(r.referrals || {}) },
    offers: Array.isArray(r.offers) ? r.offers : [],
  };
}

const ledger = (s) => (Array.isArray(s.pointsLedger) ? s.pointsLedger : (s.pointsLedger = []));
// A customer's rows, oldest first (rows are appended; equal times keep their order).
export const ledgerOf = (s, customerId) => ledger(s).filter((r) => r.customerId === customerId)
  .map((r, i) => [r, i]).sort(([a, i], [b, j]) => (a.at < b.at ? -1 : a.at > b.at ? 1 : i - j)).map(([r]) => r);
export const balanceOf = (s, customerId) => ledger(s).reduce((sum, r) => sum + (r.customerId === customerId ? r.points : 0), 0);
const addMonths = (at, months) => { const d = new Date(at); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString(); };

// The points still unspent, by the credit they came from.
export function pointLots(s, customerId) {
  const lots = [];
  for (const row of ledgerOf(s, customerId)) {
    if (row.points > 0) { lots.push({ id: row.id, at: row.at, expiresAt: row.expiresAt || null, remaining: row.points }); continue; }
    let owed = -row.points;
    if (!owed) continue;
    // An expiry uses the lots it names; a refund uses its own payment's lot first.
    const order = row.kind === "expired" && Array.isArray(row.lots) ? lots.filter((l) => row.lots.includes(l.id))
      : row.lotId ? [...lots.filter((l) => l.id === row.lotId), ...lots.filter((l) => l.id !== row.lotId)] : lots;
    for (const lot of order) {
      if (!owed) break;
      const take = Math.min(lot.remaining, owed);
      lot.remaining -= take; owed -= take;
    }
  }
  return lots.filter((l) => l.remaining > 0);
}

// The next points to expire: the date and how many expire that day.
export function nextExpiry(s, customerId, now) {
  const due = pointLots(s, customerId).filter((l) => l.expiresAt && Date.parse(l.expiresAt) > +now)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  if (!due.length) return null;
  const day = due[0].expiresAt.slice(0, 10);
  return { at: due[0].expiresAt, points: due.filter((l) => l.expiresAt.slice(0, 10) === day).reduce((n, l) => n + l.remaining, 0) };
}

const shortfallOf = (s, customerId) => ledger(s).reduce((n, r) => r.customerId !== customerId ? n
  : n + (r.kind === "refunded" && !r.offset ? r.shortfall || 0 : 0) - (r.kind === "refunded" && r.offset ? -r.points : 0), 0);

// Appends a row. A credit gets its expiry; a credit taken while a refund's
// shortfall is outstanding pays that off at once.
export function appendRow(s, row, now) {
  const at = new Date(now).toISOString(), settings = rewardSettings(s);
  const entry = { id: randomUUID(), at, actor: "system", ...row };
  if (CREDITS.has(entry.kind) && entry.points > 0) entry.expiresAt = addMonths(at, settings.points.expiryMonths);
  ledger(s).push(entry);
  if (entry.points > 0) {
    const owed = shortfallOf(s, entry.customerId);
    if (owed > 0) ledger(s).push({ id: randomUUID(), at, actor: "system", customerId: entry.customerId, kind: "refunded", points: -Math.min(owed, entry.points),
      offset: true, lotId: entry.id, key: `offset:${entry.id}` });
  }
  return entry;
}
const hasKey = (s, key) => ledger(s).some((r) => r.key === key);

export const bundleSummary = (b) => b && ({ id: b.id, name: b.name, validityHours: b.validityHours ?? null, deviceSlots: b.deviceSlots ?? b.deviceLimit ?? null, accessType: b.accessType || null });

// Points for a settled bundle payment (#432 checks passed). Safe to repeat.
export function earnForPayment(s, p, plan, now) {
  const { points: rules } = rewardSettings(s);
  if (!rules.enabled || !rules.enabledAt || !p?.customerId || p.status !== "paid" || p.gift) return null;
  if (!(Date.parse(p.createdAt) >= Date.parse(rules.enabledAt))) return null;
  if (p.reconciliation?.status === "needs_review" || plan?.custom || plan?.catalogue === "custom_gift") return null;
  const key = `earn:${p.id}`;
  if (hasKey(s, key)) return null;
  const points = Math.floor(Number(p.amount) / rules.xafPerPoint);
  if (!(points > 0)) return null;
  return appendRow(s, { customerId: p.customerId, kind: "earned", points, paymentId: p.id, bundle: bundleSummary(plan), key }, now);
}

// Takes back a credit's points, down to zero; what can't be taken is the shortfall.
export function takeBackCredit(s, credit, key, now, extra = {}) {
  if (!credit || hasKey(s, key)) return null;
  const taken = Math.min(credit.points, Math.max(0, balanceOf(s, credit.customerId)));
  return appendRow(s, { customerId: credit.customerId, kind: "refunded", points: taken ? -taken : 0, lotId: credit.id,
    shortfall: credit.points - taken, key, ...extra }, now);
}
// A completed refund takes back the points the payment earned, down to zero.
export function takeBackForPayment(s, p, now) {
  return takeBackCredit(s, ledger(s).find((r) => r.key === `earn:${p.id}`), `refund:${p.id}`, now, { paymentId: p.id });
}
export const ledgerRow = (s, key) => ledger(s).find((r) => r.key === key);

// Points past their expiry, oldest first. `customerId` limits it to one account.
export function expirePoints(s, now, customerId) {
  const at = +now, written = [], sweep = randomUUID();
  const customers = new Set(ledger(s).filter((r) => r.points > 0 && r.expiresAt && Date.parse(r.expiresAt) <= at &&
    (!customerId || r.customerId === customerId)).map((r) => r.customerId));
  for (const id of customers) {
    const due = pointLots(s, id).filter((l) => l.expiresAt && Date.parse(l.expiresAt) <= at);
    const points = due.reduce((n, l) => n + l.remaining, 0);
    if (!points) continue;
    written.push(appendRow(s, { customerId: id, kind: "expired", points: -points, lots: due.map((l) => l.id), earnedFrom: due[0].at, sweep }, now));
  }
  return written;
}

// The housekeeping sweep (lib/api/state.mjs clean): at most hourly per process,
// and only when the ledger is loaded. Rows are written only when points are due,
// so running it again, or in another process, writes nothing more.
let lastSweep = 0;
export function expireDuePoints(s, now) {
  const t = +now;
  if (!ledger(s).length || (t >= lastSweep && t - lastSweep < HOUR)) return [];
  lastSweep = t;
  return expirePoints(s, now);
}

// Redeemed bundles not started by their deadline expire; the points stay spent.
export function expireUnstartedRewards(s, now) {
  const expired = [];
  for (const v of s.vouchers || []) {
    if (!v.reward || v.status !== "available" || Date.parse(v.reward.startBy) > +now) continue;
    v.status = "expired";
    v.expiredUnstartedAt = new Date(now).toISOString();
    expired.push(v.id);
  }
  return expired;
}

// The bundles customers can redeem: published Unlimited bundles, with the
// owner's points price (suggested: price ÷ the value of a point). Home WISP is
// off until the owner turns it on.
export function rewardOffers(s) {
  const { points: rules, offers } = rewardSettings(s);
  return unlimitedOnSale(s).map((b) => {
    const saved = offers.find((o) => o.bundleId === b.id), suggested = Math.max(1, Math.round(b.price / rules.pointValueXaf));
    return { bundle: b, points: saved?.points ?? suggested, suggested,
      redeemable: saved ? saved.redeemable === true : b.accessType !== "home_wisp_unlimited" };
  });
}
// Redeeming needs the Unlimited catalogue on sale (its router rules: #450).
export const redeemOpen = (s) => catalogueMode(s) === "unlimited";

const KEY = /^[A-Za-z0-9_-]{16,120}$/;
// Spends the points and saves the bundle, in the caller's transaction: two
// requests can't spend the same points. Replaying the same key returns the
// first result.
export function redeemPoints(s, customer, input, now, code) {
  const idempotencyKey = String(input?.idempotencyKey || "");
  if (!KEY.test(idempotencyKey)) fail("Refresh the page and try again.", 400, "IDEMPOTENCY_KEY_REQUIRED");
  const key = `redeem:${customer.id}:${idempotencyKey}`, previous = ledger(s).find((r) => r.key === key);
  if (previous) return { row: previous, voucher: s.vouchers.find((v) => v.id === previous.voucherId), replayed: true };
  if (customer.status === "suspended" || customer.suspended) fail("This account is suspended.", 403, "ACCOUNT_SUSPENDED");
  expirePoints(s, now, customer.id);
  const offer = redeemOpen(s) && rewardOffers(s).find((o) => o.bundle.id === input?.offerId && o.redeemable);
  if (!offer) fail("This bundle can't be redeemed now.", 409, "OFFER_UNAVAILABLE");
  const balance = balanceOf(s, customer.id);
  if (balance < offer.points) fail(`You need ${offer.points - balance} more points for this bundle.`, 409, "NOT_ENOUGH_POINTS");
  const { points: rules } = rewardSettings(s), at = new Date(now), b = offer.bundle;
  const startBy = new Date(+at + rules.startWithinDays * DAY).toISOString(), rowId = randomUUID();
  const v = {
    id: randomUUID(), planId: b.id, code: code(s), customerId: customer.id,
    status: "available", activatedAt: null, expiresAt: null, startBy,
    quotaBytes: b.quotaGb == null ? null : b.quotaGb * 1e9, usedBytes: 0, deviceLimit: b.deviceLimit, validityHours: b.validityHours,
    // The bundle's terms as they were when redeemed, as kits and promotions do.
    ...accessTerms(b), customTerms: structuredClone(b), speedSnapshot: issueSpeedSnapshot(b),
    // Points are never revenue: no payment and no sale amount.
    saleType: "reward", faceValue: null, createdAt: at.toISOString(),
    reward: { ledgerId: rowId, points: offer.points, startBy },
    emailStatus: "not_applicable", emailAttempts: 5,
  };
  s.vouchers.unshift(v);
  const row = appendRow(s, { id: rowId, customerId: customer.id, kind: "redeemed", points: -offer.points, voucherId: v.id, bundle: bundleSummary(b), key, actor: "customer" }, now);
  return { row, voucher: v, replayed: false };
}

// "Start now": never while another bundle is active, and only within the window.
export function startRedeemedBundle(s, customer, voucherId, now) {
  const v = (s.vouchers || []).find((x) => x.id === voucherId && x.reward && x.customerId === customer.id);
  if (!v) fail("Bundle not found.", 404);
  if (v.status === "active" || (v.status === "expired" && v.activatedAt)) return { voucher: v, replayed: true };
  if (v.status === "expired" || (v.status === "available" && !(Date.parse(v.reward.startBy) > +now)))
    fail(`This bundle had to be started by ${v.reward.startBy.slice(0, 10)}.`, 409, "START_WINDOW_ENDED");
  if (v.status !== "available") fail("This bundle can no longer be started.", 409, "BUNDLE_UNAVAILABLE");
  if (activeSubscription(s, customer.id, now)) fail("You can start it once your current bundle has ended.", 409, "ACTIVE_BUNDLE_EXISTS");
  const at = new Date(now);
  v.status = "active";
  v.activatedAt = at.toISOString();
  v.expiresAt = new Date(+at + v.validityHours * HOUR).toISOString();
  v.startedBy = "customer";
  delete v.startBy;
  enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, () => at);
  v.routerSyncStatus = "pending";
  return { voucher: v, replayed: false };
}

const savedView = (v) => ({ voucherId: v.id, bundle: bundleSummary(v.customTerms), startBy: v.reward.startBy, points: v.reward.points });
const historyView = (r) => ({ id: r.id, kind: r.kind, points: r.points, at: r.at,
  ...(r.bundle ? { bundle: r.bundle } : {}), ...(r.kind === "expired" ? { earnedFrom: r.earnedFrom } : {}),
  ...(r.offset ? { offset: true } : {}), ...(r.friend ? { friend: r.friend } : {}), ...(r.invitedBy ? { invitedBy: r.invitedBy } : {}) });

// GET /api/account/rewards: everything the Rewards screen shows (PhoneRewards).
export function accountRewardsView(s, customer, now) {
  const settings = rewardSettings(s), balance = balanceOf(s, customer.id), open = redeemOpen(s);
  const active = activeSubscription(s, customer.id, now);
  return {
    programme: { points: settings.points.enabled, referrals: settings.referrals.enabled },
    balance, valueXaf: balance * settings.points.pointValueXaf,
    nextExpiry: nextExpiry(s, customer.id, now),
    rules: { xafPerPoint: settings.points.xafPerPoint, expiryMonths: settings.points.expiryMonths, startWithinDays: settings.points.startWithinDays,
      referrerPoints: settings.referrals.referrerPoints, welcomePoints: settings.referrals.welcomePoints, monthlyCap: settings.referrals.monthlyCap },
    offers: open ? rewardOffers(s).filter((o) => o.redeemable).map((o) => ({ ...bundleSummary(o.bundle), points: o.points,
      affordable: balance >= o.points, need: Math.max(0, o.points - balance) })) : [],
    saved: (s.vouchers || []).filter((v) => v.reward && v.customerId === customer.id && v.status === "available" && Date.parse(v.reward.startBy) > +now).map(savedView),
    activeBundle: active ? { endsAt: active.expiresAt || null } : null,
    history: ledgerOf(s, customer.id).filter((r) => r.points !== 0 || r.kind !== "refunded").reverse().slice(0, 100).map(historyView),
  };
}

// Owner figures (AdminRewards; Insights): outstanding points and redemptions.
export function rewardMetrics(s, now) {
  const settings = rewardSettings(s), rows = ledger(s), month = new Date(now).toISOString().slice(0, 7);
  const outstanding = rows.reduce((n, r) => n + r.points, 0);
  const redeemed = rows.filter((r) => r.kind === "redeemed");
  const byMonth = {};
  for (const r of redeemed) { const m = r.at.slice(0, 7); byMonth[m] ??= { month: m, points: 0, bundles: 0 }; byMonth[m].points -= r.points; byMonth[m].bundles++; }
  return {
    outstandingPoints: outstanding, outstandingXaf: outstanding * settings.points.pointValueXaf,
    redeemedThisMonth: byMonth[month] ? { points: byMonth[month].points, bundles: byMonth[month].bundles } : { points: 0, bundles: 0 },
    redemptionsByMonth: Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12),
  };
}

const whole = (value, min, max, label) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
};

// The owner's settings. Turning a programme on records the day it started:
// nothing before it earns, and nothing is back-dated.
export function updateRewardSettings(s, input, now, actor) {
  const current = rewardSettings(s), at = new Date(now).toISOString(), next = structuredClone(current);
  const switchOn = (part, on) => {
    if (on === undefined) return;
    if (typeof on !== "boolean") fail("Choose on or off.");
    if (on && !current[part].enabled && !redeemOpen(s)) fail("Rewards can be switched on once the Unlimited catalogue is on sale.", 409, "CATALOGUE_NOT_UNLIMITED");
    if (on && !current[part].enabled) next[part].enabledAt = at;
    next[part].enabled = on;
  };
  const p = input?.points, r = input?.referrals;
  if (p && typeof p === "object") {
    switchOn("points", p.enabled);
    if (p.xafPerPoint !== undefined) next.points.xafPerPoint = whole(p.xafPerPoint, 1, 100000, "XAF paid for 1 point");
    if (p.pointValueXaf !== undefined) next.points.pointValueXaf = whole(p.pointValueXaf, 1, 10000, "The value of 1 point");
    if (p.expiryMonths !== undefined) { if (!EXPIRY_MONTHS.includes(Number(p.expiryMonths))) fail("Choose when points expire."); next.points.expiryMonths = Number(p.expiryMonths); }
    if (p.startWithinDays !== undefined) { if (!START_WITHIN_DAYS.includes(Number(p.startWithinDays))) fail("Choose how long a redeemed bundle can wait."); next.points.startWithinDays = Number(p.startWithinDays); }
  }
  if (r && typeof r === "object") {
    switchOn("referrals", r.enabled);
    if (r.referrerPoints !== undefined) next.referrals.referrerPoints = whole(r.referrerPoints, 0, 100000, "Points to the referrer");
    if (r.welcomePoints !== undefined) next.referrals.welcomePoints = whole(r.welcomePoints, 0, 100000, "Points to the new customer");
    if (r.monthlyCap !== undefined) next.referrals.monthlyCap = whole(r.monthlyCap, 1, 1000, "Most friends per referrer a month");
    if (r.minFirstBundleXaf !== undefined) next.referrals.minFirstBundleXaf = whole(r.minFirstBundleXaf, 0, 1000000, "Smallest first bundle that counts");
  }
  if (input?.offers !== undefined) next.offers = offersInput(s, input.offers, current.offers);
  s.rewardsSettings = { ...next, updatedAt: at, updatedBy: actor };
  return { previous: current, next: rewardSettings(s) };
}

function offersInput(s, list, previous) {
  if (!Array.isArray(list) || list.length > 200) fail("Send the redeemable bundles as a list.");
  const onSale = new Map(unlimitedOnSale(s).map((b) => [b.id, b])), kept = previous.filter((o) => !list.some((x) => x?.bundleId === o.bundleId));
  const offers = list.map((o) => {
    if (!onSale.has(o?.bundleId)) fail("Only published bundles can be redeemed.");
    return { bundleId: o.bundleId, points: whole(o.points, 1, 10000000, "A points price"), redeemable: o.redeemable === true };
  });
  if (new Set(offers.map((o) => o.bundleId)).size !== offers.length) fail("Each bundle appears once.");
  return [...kept, ...offers];
}

// An owner's correction, with its reason. A negative one can't take the balance below zero.
export function adjustPoints(s, customer, input, now, actor) {
  const points = Number(input?.points), reason = String(input?.reason || "").trim();
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 1000000) fail("Enter the points to add or take away.");
  if (!reason || reason.length > 300) fail("Give the reason (up to 300 characters).");
  if (points < 0 && balanceOf(s, customer.id) + points < 0) fail("An adjustment can't take the balance below zero.", 409, "BALANCE_TOO_LOW");
  return appendRow(s, { customerId: customer.id, kind: "adjusted", points, reason, actor }, now);
}
