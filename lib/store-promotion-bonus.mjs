// The free bundle that comes with a store promotion (#302).
//
// Owner rules for the Black Friday AX1500 offer, 23 Nov (#423; they replace
// the 20 Nov rules):
// - It is given when the router is collected, never at payment. Until then
//   the order says it is given at collection.
// - Given, it waits unstarted. The customer starts it whenever they like
//   within the promotion's window (60 days from collection); unstarted after
//   that, it expires. Started, it runs for its length (one month).
// - An account (the signed-in buyer, else the account of the number that
//   paid) gets it in the account. Starting it while another bundle runs
//   pauses that bundle, which resumes with the time it had left.
// - A buyer with no account gets it reserved for the paying number (#254);
//   the code is on the order and the collection slip. Claiming adds it to the
//   account unstarted, with the same deadline.
// - A refund before collection or before it starts cancels it; after it
//   starts, the refund ends it and resumes any bundle paused for it.
// - It is a gift linked to the order, never revenue: no payment, no sale.
// - What was sold is fixed at checkout: the order keeps its own copy of the
//   free plan (bonusTerms), so catalogue changes before collection never
//   change it. A paused bundle keeps its own terms and resumes with exactly
//   the time it had left.
//
// Orders placed under the 20 Nov rule (order.promotion.bonus.startsAt ===
// "payment_confirmation") keep it: given at payment, days counted from
// payment, and claiming starts it.
//
// Pausing reuses the router queue: a usage reading first, then
// disconnect_voucher; resuming re-syncs the bundle (sync_voucher).
import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";
import { newReservation, maskPhone } from "./reservations.mjs";
import { issueSpeedSnapshot } from "./bundle-speed-policy.mjs";
import { BONUS_START_WITHIN_DAYS } from "./store-promotions.mjs";
import { accessTerms } from "./catalogue.mjs";

const HOUR = 3600000, DAY = 864e5;
const usable = (c) => c && c.status !== "suspended" && !c.suspended;
const note = (s, action, meta, now) => {
  s.auditLogs ??= [];
  s.auditLogs.unshift({ id: randomUUID(), action, actor: "system", meta, at: now.toISOString() });
};
const problem = (message, status, code) => { throw Object.assign(Error(message), { status, ...(code ? { code } : {}) }); };

// The rule an order was placed under.
const LEGACY = "payment_confirmation";
export const bonusRule = (order) => (order?.promotion?.bonus?.startsAt === LEGACY ? LEGACY : "customer_start");
// A free bundle the customer starts (23 Nov rule).
export const startedByCustomer = (v) => v?.promotion?.rule === "customer_start";

// The free bundle as sold, copied into the order at checkout: the promotion's
// rule and the plan's own facts.
// An Unlimited bundle (#345) is copied whole, as a kit's first bundle is.
export function bonusTerms(bonus, plan) {
  if (plan?.bundle) {
    const { cost: _cost, ...bundle } = structuredClone(plan.bundle);
    return { ...bonus, planName: plan.name || null, bundle };
  }
  return { ...bonus, planName: plan?.name || null,
    ...(plan ? { plan: { quotaGb: plan.quotaGb ?? null, deviceLimit: plan.deviceLimit, price: plan.price ?? null, speedSnapshot: issueSpeedSnapshot(plan) } } : {}) };
}
// When the free bundle is given: at collection (the default), or as soon as
// the payment is confirmed when staff chose that (#345; owner, 27 Nov).
export const givenAtPayment = (order) => order?.promotion?.bonus?.givenAt === "payment";

// What the free bundle is issued with: the order's copy; for orders placed
// before the copy existed, the catalogue plan.
function issuedPlan(order, plan) {
  const bundle = order.promotion.bonus.bundle;
  if (bundle) return { id: bundle.id, quotaGb: null, deviceLimit: bundle.accessType === "personal_unlimited" ? bundle.deviceSlots : 1, price: bundle.price ?? null, bundle };
  const sold = order.promotion.bonus.plan;
  if (sold) return { id: order.promotion.bonus.planId, ...sold };
  return plan ? { id: plan.id, quotaGb: plan.quotaGb ?? null, deviceLimit: plan.deviceLimit, price: plan.price ?? null, speedSnapshot: issueSpeedSnapshot(plan) } : null;
}

// The account that gets the bundle: the signed-in buyer, else the account of
// the number that paid; null when neither exists (a reservation instead).
export function bonusRecipient(s, order) {
  const signedIn = order.customerId && s.customers.find((c) => c.id === order.customerId);
  if (usable(signedIn)) return signedIn;
  const payer = s.customers.find((c) => c.phone === order.payment.payerPhone);
  return usable(payer) ? payer : null;
}

// Bundles running on the account stop while the free one runs. Home access is
// a different service and is left alone. Only the status and the time left
// are recorded: the bundle's own terms are untouched.
function pauseRunning(s, customerId, bonus, now) {
  const at = () => now;
  const running = s.vouchers.filter((v) => v.customerId === customerId && v.id !== bonus.id && v.status === "active" &&
    v.accessMode !== "home" && !v.accessTransitionId && Date.parse(v.expiresAt) > +now);
  for (const v of running) {
    v.status = "paused";
    v.pausedFor = { voucherId: bonus.id, orderId: bonus.promotion.orderId, pausedAt: now.toISOString(), remainingMs: Date.parse(v.expiresAt) - +now };
    v.routerSyncStatus = "pending";
    // A last usage reading, then the router stops the bundle.
    enqueueRouterCommand(s, { action: "sync_usage" }, at);
    enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, at);
    note(s, "store.promotion_bundle_paused", { voucherId: v.id, bonusVoucherId: bonus.id, orderId: bonus.promotion.orderId, remainingMs: v.pausedFor.remainingMs }, now);
  }
  return running.map((v) => v.id);
}

const orderOf = (s, v) => s.storeOrders?.find((o) => o.id === v.promotion?.orderId);

// Starts the free bundle on an account. Under the 23 Nov rule its days start
// now; under the 20 Nov rule its end was fixed at payment.
export function startBonus(s, v, customer, now) {
  v.customerId = customer.id;
  v.activatedAt = now.toISOString();
  v.expiresAt = startedByCustomer(v) ? new Date(+now + v.promotion.validityHours * HOUR).toISOString() : v.promotion.endsAt;
  if (!(Date.parse(v.expiresAt) > +now)) {
    v.status = "expired";
    return { started: false, paused: [] };
  }
  v.status = "active";
  const paused = pauseRunning(s, customer.id, v, now);
  enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, () => now);
  v.routerSyncStatus = "pending";
  if (startedByCustomer(v)) {
    const order = orderOf(s, v);
    if (order?.bonus) Object.assign(order.bonus, { status: "active", customerId: customer.id, startedAt: v.activatedAt, endsAt: v.expiresAt, pausedVoucherIds: paused });
    note(s, "store.promotion_bonus_started", { orderId: v.promotion.orderId, voucherId: v.id, customerId: customer.id, endsAt: v.expiresAt, pausedVoucherIds: paused }, now);
  }
  return { started: true, paused };
}

// Gives the free bundle. 23 Nov rule: once the order is collected, or once it
// is paid when staff chose "As soon as payment is confirmed" (#345). 20 Nov
// rule: once it is paid and fulfilled ("preparing"). Idempotent: an order gets
// one free bundle. `plan` is the catalogue plan (used only for orders placed
// before the order kept its own copy); `code` makes a unique activation code.
export function issuePromotionBonus(s, order, now, { plan, code }) {
  const promo = order.promotion;
  if (!promo?.bonus || order.bonus || order.payment.status !== "paid") return null;
  const legacy = bonusRule(order) === LEGACY;
  if (givenAtPayment(order) ? !["preparing", "ready", "collected"].includes(order.status) : order.status !== (legacy ? "preparing" : "collected")) return null;
  const facts = issuedPlan(order, plan);
  if (!facts) {
    order.bonus = { status: "needs_review", reason: "plan_unavailable", at: now.toISOString() };
    note(s, "store.promotion_bonus_needs_review", { orderId: order.id, promotionId: promo.id, planId: promo.bonus.planId }, now);
    return order.bonus;
  }
  const givenAt = now.toISOString(), recipient = bonusRecipient(s, order);
  const v = {
    id: randomUUID(), planId: facts.id, code: code(s), customerId: null,
    status: "available", activatedAt: null, expiresAt: null,
    quotaBytes: facts.quotaGb === null ? null : facts.quotaGb * 1e9, usedBytes: 0, deviceLimit: facts.deviceLimit,
    // An Unlimited bundle keeps its own terms on the voucher, as kits do (#424).
    ...(facts.bundle ? { ...accessTerms(facts.bundle), customTerms: structuredClone(facts.bundle) } : { speedSnapshot: facts.speedSnapshot }),
    // A gift linked to the order: no payment and no sale amount, so never revenue.
    saleType: "gift", faceValue: facts.price ?? null, createdAt: givenAt,
    emailStatus: "not_applicable", emailAttempts: 5,
  };
  s.vouchers.unshift(v);
  if (legacy) {
    const endsAt = new Date(Date.parse(order.payment.confirmedAt) + promo.bonus.validityHours * HOUR).toISOString();
    v.promotion = { id: promo.id, orderId: order.id, reference: order.reference, endsAt, validityHours: promo.bonus.validityHours };
    if (recipient) {
      const { started, paused } = startBonus(s, v, recipient, now);
      order.bonus = { status: started ? "active" : "expired", voucherId: v.id, recipient: "account", customerId: recipient.id, givenAt, endsAt, pausedVoucherIds: paused };
    } else {
      // Claimable until the free days end; there is nothing to claim after that.
      v.reservation = { ...newReservation(order.payment.payerPhone, { type: "store_order", id: order.id }, now), expiresAt: endsAt };
      order.bonus = { status: "reserved", voucherId: v.id, recipient: "number", phone: order.payment.payerPhone, givenAt, endsAt, code: v.code };
    }
  } else {
    const startBy = new Date(+now + (promo.bonus.startWithinDays ?? BONUS_START_WITHIN_DAYS) * DAY).toISOString();
    v.promotion = { id: promo.id, orderId: order.id, reference: order.reference, rule: "customer_start", validityHours: promo.bonus.validityHours, givenAt, startBy };
    v.startBy = startBy;
    if (recipient) {
      // In the account, unstarted, until the customer presses Start.
      v.customerId = recipient.id;
      order.bonus = { status: "given", voucherId: v.id, recipient: "account", customerId: recipient.id, givenAt, startBy };
    } else {
      // Claimable with the code on the slip until the start deadline.
      v.reservation = { ...newReservation(order.payment.payerPhone, { type: "store_order", id: order.id }, now), expiresAt: startBy };
      order.bonus = { status: "reserved", voucherId: v.id, recipient: "number", phone: order.payment.payerPhone, givenAt, startBy, code: v.code };
    }
  }
  note(s, "store.promotion_bonus_given", { orderId: order.id, promotionId: promo.id, voucherId: v.id, recipient: order.bonus.recipient,
    ...(order.bonus.endsAt ? { endsAt: order.bonus.endsAt } : { startBy: order.bonus.startBy }) }, now);
  return order.bonus;
}

// A reserved free bundle claimed by its number. 23 Nov rule: it is saved in
// the account unstarted, with the deadline it was given with. 20 Nov rule: it
// starts now and still ends when its days run out.
export function claimBonus(s, v, customer, now) {
  const order = orderOf(s, v);
  let result = { started: false, paused: [] };
  if (startedByCustomer(v)) {
    v.customerId = customer.id;
    v.startBy = v.promotion.startBy;
    if (order?.bonus) Object.assign(order.bonus, { status: "given", customerId: customer.id, claimedAt: now.toISOString() });
  } else {
    result = startBonus(s, v, customer, now);
    if (order?.bonus) Object.assign(order.bonus, { status: result.started ? "active" : "expired", customerId: customer.id,
      claimedAt: now.toISOString(), pausedVoucherIds: result.paused });
  }
  if (order?.bonus) delete order.bonus.code;
  note(s, "store.promotion_bonus_claimed", { orderId: v.promotion?.orderId, voucherId: v.id, customerId: customer.id }, now);
  return result;
}

// The customer presses Start (23 Nov rule). Safe to repeat: a free bundle
// already started by this account is returned as it is.
export function startPromotionBonus(s, voucherId, customer, now) {
  const v = s.vouchers.find((x) => x.id === voucherId);
  if (!v || !startedByCustomer(v) || v.customerId !== customer.id) problem("Free month not found.", 404);
  if (v.status === "active" || v.status === "paused" || (v.status === "expired" && v.activatedAt)) return { voucher: v, order: orderOf(s, v), replayed: true };
  if (v.status === "expired" || (v.status === "available" && !(Date.parse(v.promotion.startBy) > +now)))
    problem(`This free month had to be started by ${new Date(v.promotion.startBy).toISOString().slice(0, 10)}.`, 409, "START_WINDOW_ENDED");
  if (v.status !== "available") problem("This free month can no longer be started.", 409, "BONUS_UNAVAILABLE");
  startBonus(s, v, customer, now);
  return { voucher: v, order: orderOf(s, v), replayed: false };
}

// Free bundles not started by their deadline expire (23 Nov rule), whether
// they wait in an account or for their number's claim. The voucher and its
// order change together: housekeeping on a targeted read that didn't load the
// order leaves both for a run on the full state (orders are never deleted).
export function expireUnstartedBonuses(s, now) {
  const expired = [];
  for (const v of s.vouchers.filter((x) => startedByCustomer(x) && x.status === "available" && !(Date.parse(x.promotion.startBy) > +now))) {
    const order = orderOf(s, v);
    if (!order) continue;
    v.status = "expired";
    v.expiredUnstartedAt = now.toISOString();
    if (v.reservation?.status === "waiting") v.reservation.status = "expired";
    if (order.bonus && ["given", "reserved"].includes(order.bonus.status)) {
      Object.assign(order.bonus, { status: "expired", expiredAt: now.toISOString() });
      delete order.bonus.code;
    }
    note(s, "store.promotion_bonus_expired", { orderId: v.promotion.orderId, voucherId: v.id, startBy: v.promotion.startBy }, now);
    expired.push(v.id);
  }
  return expired;
}

// Bundles paused for a free bundle that is no longer running resume with the
// time they had left. Only when that free bundle is loaded and over: a partly
// loaded state never resumes anything by mistake.
export function resumePausedBundles(s, now) {
  const resumed = [];
  for (const v of s.vouchers.filter((x) => x.status === "paused" && x.pausedFor)) {
    const bonus = s.vouchers.find((x) => x.id === v.pausedFor.voucherId);
    if (!bonus || bonus.status === "active") continue;
    v.status = "active";
    v.expiresAt = new Date(+now + v.pausedFor.remainingMs).toISOString();
    v.resumedAfter = { ...v.pausedFor, resumedAt: now.toISOString() };
    delete v.pausedFor;
    v.routerSyncStatus = "pending";
    enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, () => now);
    note(s, "store.promotion_bundle_resumed", { voucherId: v.id, bonusVoucherId: bonus.id, expiresAt: v.expiresAt }, now);
    resumed.push(v.id);
  }
  return resumed;
}

// A refund. Before collection nothing was given; before it starts it is
// cancelled (a reserved code can no longer be claimed); once started it ends
// and any bundle paused for it resumes.
export function endPromotionBonus(s, order, now, reason) {
  if (!order.promotion?.bonus) return null;
  if (!order.bonus) {
    order.bonus = { status: "not_given", reason, at: now.toISOString() };
    note(s, "store.promotion_bonus_ended", { orderId: order.id, reason, given: false }, now);
    return order.bonus;
  }
  if (["ended", "not_given", "cancelled", "expired"].includes(order.bonus.status) && !(order.bonus.status === "expired" && bonusRule(order) === LEGACY)) return order.bonus;
  const v = s.vouchers.find((x) => x.id === order.bonus.voucherId);
  let started = false;
  if (v) {
    if (v.status === "active") {
      started = true;
      v.status = "revoked";
      v.revokedAt = now.toISOString();
      v.routerSyncStatus = "pending";
      enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, () => now);
    } else if (v.status === "available") {
      v.status = "revoked";
      v.revokedAt = now.toISOString();
      if (v.reservation) v.reservation.status = "revoked";
    } else started = Boolean(v.activatedAt);
  }
  const status = started || bonusRule(order) === LEGACY ? "ended" : "cancelled";
  Object.assign(order.bonus, { status, endedAt: now.toISOString(), endedReason: reason });
  delete order.bonus.code;
  resumePausedBundles(s, now);
  note(s, "store.promotion_bonus_ended", { orderId: order.id, voucherId: order.bonus.voucherId, reason, started }, now);
  return order.bonus;
}

// What the buyer and staff see about the free bundle on an order. The code is
// shown only while it waits for its number to claim it.
export function bonusView(order) {
  const b = order.bonus;
  if (!order.promotion?.bonus) return null;
  const rule = bonusRule(order);
  return {
    days: Math.round(order.promotion.bonus.validityHours / 24), planId: order.promotion.bonus.planId,
    planName: order.promotion.bonus.planName || null,
    // "customer_start": given at collection, started by the customer within
    // startWithinDays; "payment_confirmation": the 20 Nov rule.
    rule, ...(rule === "customer_start" ? { startWithinDays: order.promotion.bonus.startWithinDays ?? BONUS_START_WITHIN_DAYS, givenAt: order.promotion.bonus.givenAt || "collection" } : {}),
    status: b?.status || "pending", endsAt: b?.endsAt || null, recipient: b?.recipient || null,
    startBy: b?.startBy || null, startedAt: b?.startedAt || null,
    ...(b?.status === "given" ? { voucherId: b.voucherId } : {}),
    ...(b?.phone ? { phone: maskPhone(b.phone) } : {}),
    ...(b?.status === "reserved" && b.code ? { code: b.code } : {}),
  };
}
