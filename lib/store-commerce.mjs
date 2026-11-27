import { issuePromotionBonus } from "./store-promotion-bonus.mjs";
import { catalogue as bundleCatalogue, uniqueActivationCode } from "./api/state.mjs";
import { hashSecret } from "./security.mjs";
import { randomUUID } from "node:crypto";
import {
  storeState,
  expireReservations,
  settleOrder,
  movement, orderLines } from "./device-store.mjs";
import { recordProviderCharge } from "./payment-fees.mjs";
import { refundable, sweepPlans, planReminders, bookingReminders } from "./store-kit-orders.mjs";

// External calls run outside transactions. Durable leases prevent duplicate
// provider submissions; uncertain submissions are verified, never blindly retried.
export function createStoreCommerce({ store, pays, clock, logger, email, orderLink = () => null }) {
  let running = false;
  async function start(id) {
    const claim = await store.transaction((s) => {
      storeState(s);
      const o = s.storeOrders.find((o) => o.id === id);
      if (
        !o ||
        o.payment.creationState !== "reserved" ||
        o.stockState !== "reserved" ||
        Date.parse(o.expiresAt) <= +clock()
      )
        return;
      o.payment.creationState = "submitted";
      o.payment.nextCheckAt = new Date(+clock() + 15000).toISOString();
      return structuredClone(o.payment);
    });
    if (!claim) return;
    try {
      const result = await pays[claim.provider].createPayment(claim);
      let mismatch = null;
      await store.transaction((s) => {
        const o = storeState(s).storeOrders.find((o) => o.id === id);
        if (result.providerReference)
          o.payment.providerReference = String(result.providerReference);
        // The fee MeSomb added to the price, beside the quote (#297).
        mismatch = recordProviderCharge(o.payment, result);
        o.payment.creationState = "created";
        o.payment.nextCheckAt = clock().toISOString();
      });
      if (mismatch) logger?.warn("store.fee_mismatch", { orderId: id, ...mismatch });
      // A create response is not proof of settlement.
    } catch {
      await store.transaction((s) => {
        const p = storeState(s).storeOrders.find((o) => o.id === id).payment;
        p.creationState = "uncertain";
        p.review = "submission_uncertain";
      });
    }
  }
  async function verify(id, { force = false } = {}) {
    const lease = randomUUID(),
      claim = await store.transaction((s) => {
        storeState(s);
        expireReservations(s, clock());
        const o = s.storeOrders.find((o) => o.id === id),
          p = o?.payment;
        if (
          !p ||
          p.confirmedAt ||
          p.refund ||
          p.creationState === "reserved" ||
          (p.leaseUntil && Date.parse(p.leaseUntil) > +clock()) ||
          (!force && p.nextCheckAt && Date.parse(p.nextCheckAt) > +clock())
        )
          return;
        p.lease = lease;
        p.leaseUntil = new Date(+clock() + 60000).toISOString();
        p.nextCheckAt = new Date(+clock() + 30000).toISOString();
        return structuredClone(p);
      });
    if (!claim) return;
    try {
      let result = await pays[claim.provider].verifyPayment(claim);
      // The bundled mock adapter intentionally has no financial detail fields.
      if (claim.provider === "mock")
        result = {
          ...result,
          transactionReference: claim.id,
          amount: claim.amount,
          currency: claim.currency,
        };
      let settled;
      await store.transaction((s) => {
        settled = undefined;
        const o = storeState(s).storeOrders.find((o) => o.id === id);
        if (o?.payment.lease !== lease) return;
        settled = settleOrder(s, o, result, clock());
        // Orders placed under the 20 Nov rule, or whose promotion gives it "as
        // soon as payment is confirmed" (#345), get their free bundle now;
        // otherwise it is given at collection (#423) and this gives nothing.
        if (o.promotion?.bonus) issuePromotionBonus(s, o, clock(), {
          plan: bundleCatalogue(s).find((plan) => plan.id === o.promotion.bonus.planId), code: uniqueActivationCode });
        if (
          !o.payment.review ||
          o.payment.review === "submission_uncertain" ||
          o.payment.review === "verification_unavailable"
        )
          delete o.payment.review;
        delete o.payment.lease;
        delete o.payment.leaseUntil;
      });
      if (settled?.feeMismatch) logger?.warn("store.fee_mismatch", { orderId: id, ...settled.feeMismatch });
    } catch {
      await store.transaction((s) => {
        const p = storeState(s).storeOrders.find((o) => o.id === id)?.payment;
        if (p?.lease === lease) {
          p.review = "verification_unavailable";
          delete p.lease;
          delete p.leaseUntil;
        }
      });
      logger?.warn("store.payment_verification_pending", { orderId: id });
    }
  }
  async function refund(id) {
    const claim = await store.transaction((s) => {
      const o = storeState(s).storeOrders.find((o) => o.id === id),
        p = o?.payment;
      if (
        !p?.refund ||
        !["requested", "pending", "uncertain"].includes(p.refund.status)
      )
        return;
      if (p.refund.leaseUntil && Date.parse(p.refund.leaseUntil) > +clock())
        return;
      if (p.refund.nextCheckAt && Date.parse(p.refund.nextCheckAt) > +clock())
        return;
      const submit = p.refund.status === "requested";
      p.refund.status = submit ? "uncertain" : p.refund.status;
      p.refund.leaseUntil = new Date(+clock() + 60000).toISOString();
      p.refund.nextCheckAt = new Date(+clock() + 30000).toISOString();
      // The amount asked for: part of a payment (#425 Couldn't install), or what is left of it.
      return { payment: { ...structuredClone(p), amount: p.refund.amount ?? refundable(p) }, submit };
    });
    if (!claim) return;
    try {
      const p = claim.payment;
      // Unknown submissions without a reference require provider/support reconciliation.
      if (!claim.submit && !p.refund.providerReference) return;
      const result =
        await pays[p.provider][claim.submit ? "refundPayment" : "verifyRefund"](
          p,
        );
      await store.transaction((s) => {
        const o = storeState(s).storeOrders.find((o) => o.id === id),
          payment = o.payment;
        if (
          payment.refund.id !== p.refund.id ||
          payment.refund.status === "completed"
        )
          return;
        payment.refund.status = ["completed", "failed", "pending"].includes(
          result.status,
        )
          ? result.status
          : "uncertain";
        if (result.providerReference)
          payment.refund.providerReference = String(result.providerReference);
        delete payment.refund.leaseUntil;
        if (payment.refund.status === "completed" && payment.refund.partial) {
          // Part of the payment came back (#425); the order goes on, and a later refund can return the rest.
          (payment.refunds ||= []).push({ ...payment.refund, amount: p.amount, completedAt: clock().toISOString() });
          delete payment.refund;
          payment.status = "paid";
        } else if (payment.refund.status === "completed") {
          (payment.refunds ||= []).push({ ...payment.refund, amount: p.amount, completedAt: clock().toISOString() });
          payment.status = "refunded";
          payment.refund.completedAt = clock().toISOString();
          o.status = "cancelled";
          // Restock only explicitly confirmed returned/unsent units.
          if (payment.refund.restock && o.stockState === "consumed") {
            // Each of a kit's products goes back too (#424).
            for (const line of orderLines(o)) {
              const product = s.storeProducts.find((p) => p.id === line.productId);
              if (product)
                movement(
                  s,
                  product,
                  line.quantity,
                  "Refunded stock returned",
                  "payment-provider",
                  clock(),
                );
            }
          }
          o.stockState = "released";
        }
        if (payment.refund?.status === "failed") payment.status = "paid";
        o.version++;
      });
    } catch {
      logger?.warn("store.refund_verification_pending", { orderId: id });
    }
  }
  async function webhook(provider, data) {
    const state = storeState(await store.snapshot());
    const order = state.storeOrders.find(
      (o) => o.payment.id === data.paymentId && o.payment.provider === provider,
    );
    if (!order) return false;
    // Scheduler guarantees retry even if the provider callback arrives during a lease.
    await verify(order.id);
    return true;
  }
  async function notify(id) {
    if (!email?.sendStoreOrder || (email.configured && !email.configured()))
      return;
    const claim = await store.transaction((s) => {
      const o = storeState(s).storeOrders.find((o) => o.id === id);
      if (
        !o?.contact.email ||
        !["awaiting_payment", "preparing", "ready", "review", "cancelled", "collected", "expired"].includes(
          o.status,
        ) ||
        (!o.payment.confirmedAt && o.payment.creationState === "reserved")
      )
        return;
      const key = `${o.status}:${o.payment.status}:${o.payment.refund?.status || "none"}:${o.contact.email}`;
      const delivery = (o.emailDelivery ||= {});
      if (
        delivery.completedKey === key ||
        Date.parse(delivery.leaseUntil) > +clock() ||
        (delivery.key === key && Date.parse(delivery.nextAttemptAt) > +clock())
      )
        return;
      delivery.key = key;
      delivery.leaseUntil = new Date(+clock() + 60000).toISOString();
      delivery.nextAttemptAt = new Date(+clock() + 60000).toISOString();
      return { order: structuredClone(o), key };
    });
    if (!claim) return;
    try {
      await email.sendStoreOrder({
        to: claim.order.contact.email,
        order: claim.order,
        // A guest's short private link (#401); account orders are in Activity.
        link: orderLink(claim.order),
        deliveryKey: `store-order/${id}/${hashSecret(claim.key).slice(0, 32)}`,
      });
      await store.transaction((s) => {
        const d = storeState(s).storeOrders.find(
          (o) => o.id === id,
        )?.emailDelivery;
        if (d?.key === claim.key) {
          d.completedKey = claim.key;
          d.lastSentAt = clock().toISOString();
          d.status = "sent";
          delete d.leaseUntil;
        }
      });
    } catch {
      await store.transaction((s) => { const d = storeState(s).storeOrders.find((o) => o.id === id)?.emailDelivery; if (d?.key === claim.key) d.status = "retrying"; });
      logger?.warn("store.email_pending", { orderId: id });
    }
  }
  // Reminders by email (#425, #426): a plan's dates 3 days and 1 day before,
  // staff's "Send reminder", and an installation's booking and the day before.
  async function remind(id) {
    if (!email?.sendStoreReminder || (email.configured && !email.configured())) return;
    const claim = await store.transaction((s) => {
      const o = storeState(s).storeOrders.find((x) => x.id === id);
      if (!o?.contact.email) return;
      const sent = (o.remindersSent ||= {});
      const due = [...planReminders(o, clock()).map((r) => ({ ...r, about: "plan" })), ...bookingReminders(o, clock()).map((r) => ({ ...r, about: "installation" }))]
        .find((r) => !sent[r.about + ":" + r.key] && !(o.reminderLease && Date.parse(o.reminderLease) > +clock()));
      if (!due) return;
      o.reminderLease = new Date(+clock() + 60000).toISOString();
      return { order: structuredClone(o), reminder: due };
    });
    if (!claim) return;
    const key = claim.reminder.about + ":" + claim.reminder.key;
    try {
      await email.sendStoreReminder({ to: claim.order.contact.email, order: claim.order, reminder: claim.reminder,
        deliveryKey: `store-reminder/${id}/${hashSecret(key).slice(0, 32)}` });
      await store.transaction((s) => { const o = storeState(s).storeOrders.find((x) => x.id === id); if (o) { (o.remindersSent ||= {})[key] = clock().toISOString(); delete o.reminderLease; } });
    } catch {
      await store.transaction((s) => { const o = storeState(s).storeOrders.find((x) => x.id === id); if (o) delete o.reminderLease; });
      logger?.warn("store.reminder_pending", { orderId: id });
    }
  }
  async function run() {
    if (running) return;
    running = true;
    try {
      await store.transaction((s) => expireReservations(s, clock()));
      // Late plans past their grace are cancelled and refunded (#426).
      const cancelled = await store.transaction((s) => sweepPlans(storeState(s), clock()));
      if (cancelled?.length) logger?.info?.("store.plans_cancelled", { orderIds: cancelled });
      const state = storeState(await store.snapshot());
      const due = state.storeOrders
        .filter(
          (o) =>
            !o.payment.confirmedAt &&
            o.payment.creationState !== "reserved" &&
            (!o.payment.nextCheckAt ||
              Date.parse(o.payment.nextCheckAt) <= +clock()) &&
            Date.parse(o.createdAt) > +clock() - 7 * 86400000,
        )
        .slice(0, 25);
      for (const o of due) await verify(o.id);
      const notifications = state.storeOrders.filter((o) => {
        const key = `${o.status}:${o.payment.status}:${o.payment.refund?.status || "none"}:${o.contact.email}`;
        return o.contact.email && ["awaiting_payment", "preparing", "ready", "review", "cancelled", "collected", "expired"].includes(o.status) && (o.payment.confirmedAt || o.payment.creationState !== "reserved") && o.emailDelivery?.completedKey !== key && !(Date.parse(o.emailDelivery?.leaseUntil) > +clock()) && !(o.emailDelivery?.key === key && Date.parse(o.emailDelivery?.nextAttemptAt) > +clock());
      }).slice(0, 100);
      for (const o of notifications) await notify(o.id);
      for (const o of state.storeOrders
        .filter((o) =>
          ["requested", "pending", "uncertain"].includes(
            o.payment.refund?.status,
          ),
        )
        .slice(0, 10))
        await refund(o.id);
      for (const o of state.storeOrders.filter((o) => o.contact?.email && (o.plan?.status === "running" || o.installation) && o.kind !== "plan_payment").slice(0, 50))
        await remind(o.id);
    } finally {
      running = false;
    }
  }
  return { start, verify, refund, webhook, run, remind };
}
