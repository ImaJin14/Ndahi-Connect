// The free bundle that comes with a store promotion (#302). Owner rules for
// the Black Friday AX1500 offer (20 Nov):
// - Its days start when the payment is confirmed and last the promotion's
//   bonus length (45 days of Unlimited Home).
// - An account (the signed-in buyer, else the account of the number that
//   paid) gets it running at once. A bundle already running is paused, and
//   resumes with the time it had left when the free one ends.
// - A buyer with no account gets it reserved for the paying number (#254);
//   the code is on the order and the collection slip. Its days still run from
//   payment, and claiming it starts it straight away.
// - A refund ends it, and resumes any bundle paused for it.
// - It is a gift linked to the order, never revenue: no payment, no sale.
// Pausing reuses the router queue: a usage reading first, then
// disconnect_voucher; resuming re-syncs the bundle (sync_voucher).
import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";
import { newReservation, maskPhone } from "./reservations.mjs";
import { issueSpeedSnapshot } from "./bundle-speed-policy.mjs";

const HOUR = 3600000;
const usable = (c) => c && c.status !== "suspended" && !c.suspended;
const note = (s, action, meta, now) => {
  s.auditLogs ??= [];
  s.auditLogs.unshift({ id: randomUUID(), action, actor: "system", meta, at: now.toISOString() });
};

// The account that gets the bundle: the signed-in buyer, else the account of
// the number that paid; null when neither exists (a reservation instead).
export function bonusRecipient(s, order) {
  const signedIn = order.customerId && s.customers.find((c) => c.id === order.customerId);
  if (usable(signedIn)) return signedIn;
  const payer = s.customers.find((c) => c.phone === order.payment.payerPhone);
  return usable(payer) ? payer : null;
}

// Bundles running on the account stop while the free one runs. Home access is
// a different service and is left alone.
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

// Starts the free bundle on an account; its end was fixed at payment.
export function startBonus(s, v, customer, now) {
  v.customerId = customer.id;
  v.activatedAt = now.toISOString();
  v.expiresAt = v.promotion.endsAt;
  if (!(Date.parse(v.expiresAt) > +now)) {
    v.status = "expired";
    return { started: false, paused: [] };
  }
  v.status = "active";
  const paused = pauseRunning(s, customer.id, v, now);
  enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, () => now);
  v.routerSyncStatus = "pending";
  return { started: true, paused };
}

// Called once the order is paid and fulfilled ("preparing"). Idempotent: an
// order gets one free bundle. `plan` is the catalogue plan; `code` makes a
// unique activation code.
export function issuePromotionBonus(s, order, now, { plan, code }) {
  const promo = order.promotion;
  if (!promo?.bonus || order.bonus || order.payment.status !== "paid" || order.status !== "preparing") return null;
  if (!plan) {
    order.bonus = { status: "needs_review", reason: "plan_unavailable", at: now.toISOString() };
    note(s, "store.promotion_bonus_needs_review", { orderId: order.id, promotionId: promo.id, planId: promo.bonus.planId }, now);
    return order.bonus;
  }
  const paidAt = Date.parse(order.payment.confirmedAt), endsAt = new Date(paidAt + promo.bonus.validityHours * HOUR).toISOString();
  const recipient = bonusRecipient(s, order);
  const v = {
    id: randomUUID(), planId: plan.id, code: code(s), customerId: null,
    status: "available", activatedAt: null, expiresAt: null,
    quotaBytes: plan.quotaGb === null ? null : plan.quotaGb * 1e9, usedBytes: 0, deviceLimit: plan.deviceLimit,
    speedSnapshot: issueSpeedSnapshot(plan),
    // A gift linked to the order: no payment and no sale amount, so never revenue.
    saleType: "gift", faceValue: plan.price ?? null, createdAt: now.toISOString(),
    promotion: { id: promo.id, orderId: order.id, reference: order.reference, endsAt, validityHours: promo.bonus.validityHours },
    emailStatus: "not_applicable", emailAttempts: 5,
  };
  s.vouchers.unshift(v);
  if (recipient) {
    const { started, paused } = startBonus(s, v, recipient, now);
    order.bonus = { status: started ? "active" : "expired", voucherId: v.id, recipient: "account", customerId: recipient.id,
      givenAt: now.toISOString(), endsAt, pausedVoucherIds: paused };
  } else {
    // Claimable until the free days end; there is nothing to claim after that.
    v.reservation = { ...newReservation(order.payment.payerPhone, { type: "store_order", id: order.id }, now), expiresAt: endsAt };
    // The code goes on the order page and the collection slip until claimed.
    order.bonus = { status: "reserved", voucherId: v.id, recipient: "number", phone: order.payment.payerPhone,
      givenAt: now.toISOString(), endsAt, code: v.code };
  }
  note(s, "store.promotion_bonus_given", { orderId: order.id, promotionId: promo.id, voucherId: v.id, recipient: order.bonus.recipient, endsAt }, now);
  return order.bonus;
}

// A reserved free bundle claimed by its number: it starts now and still ends
// when its days run out.
export function claimBonus(s, v, customer, now) {
  const result = startBonus(s, v, customer, now);
  const order = s.storeOrders?.find((o) => o.id === v.promotion?.orderId);
  if (order?.bonus) {
    Object.assign(order.bonus, { status: result.started ? "active" : "expired", customerId: customer.id,
      claimedAt: now.toISOString(), pausedVoucherIds: result.paused });
    delete order.bonus.code;
  }
  note(s, "store.promotion_bonus_claimed", { orderId: v.promotion?.orderId, voucherId: v.id, customerId: customer.id }, now);
  return result;
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

// A refund ends the free bundle (owner, 20 Nov): a running one stops, a
// reserved one can no longer be claimed, and a paused bundle resumes.
export function endPromotionBonus(s, order, now, reason) {
  if (!order.promotion?.bonus) return null;
  if (!order.bonus) {
    order.bonus = { status: "not_given", reason, at: now.toISOString() };
    return order.bonus;
  }
  if (["ended", "not_given"].includes(order.bonus.status)) return order.bonus;
  const v = s.vouchers.find((x) => x.id === order.bonus.voucherId);
  if (v) {
    if (v.status === "active") {
      v.status = "revoked";
      v.revokedAt = now.toISOString();
      v.routerSyncStatus = "pending";
      enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, () => now);
    } else if (v.status === "available") {
      v.status = "revoked";
      v.revokedAt = now.toISOString();
      if (v.reservation) v.reservation.status = "revoked";
    }
  }
  Object.assign(order.bonus, { status: "ended", endedAt: now.toISOString(), endedReason: reason });
  delete order.bonus.code;
  resumePausedBundles(s, now);
  note(s, "store.promotion_bonus_ended", { orderId: order.id, voucherId: order.bonus.voucherId, reason }, now);
  return order.bonus;
}

// What the buyer and staff see about the free bundle on an order. The code is
// shown only while it waits for its number to claim it.
export function bonusView(order) {
  const b = order.bonus;
  if (!order.promotion?.bonus) return null;
  return {
    days: Math.round(order.promotion.bonus.validityHours / 24), planId: order.promotion.bonus.planId,
    planName: order.promotion.bonus.planName || null,
    status: b?.status || "pending", endsAt: b?.endsAt || null, recipient: b?.recipient || null,
    ...(b?.phone ? { phone: maskPhone(b.phone) } : {}),
    ...(b?.status === "reserved" && b.code ? { code: b.code } : {}),
  };
}
