import { hashSecret } from "./security.mjs";
import { randomUUID } from "node:crypto";
import {
  storeState,
  expireReservations,
  settleOrder,
  movement,
} from "./device-store.mjs";

// External calls run outside transactions. Durable leases prevent duplicate
// provider submissions; uncertain submissions are verified, never blindly retried.
export function createStoreCommerce({ store, pays, clock, logger, email }) {
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
      await store.transaction((s) => {
        const o = storeState(s).storeOrders.find((o) => o.id === id);
        if (result.providerReference)
          o.payment.providerReference = String(result.providerReference);
        o.payment.creationState = "created";
        o.payment.nextCheckAt = clock().toISOString();
      });
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
      await store.transaction((s) => {
        const o = storeState(s).storeOrders.find((o) => o.id === id);
        if (o?.payment.lease !== lease) return;
        settleOrder(s, o, result, clock());
        if (
          !o.payment.review ||
          o.payment.review === "submission_uncertain" ||
          o.payment.review === "verification_unavailable"
        )
          delete o.payment.review;
        delete o.payment.lease;
        delete o.payment.leaseUntil;
      });
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
      return { payment: structuredClone(p), submit };
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
        if (payment.refund.status === "completed") {
          payment.status = "refunded";
          o.status = "cancelled";
          // Restock only explicitly confirmed returned/unsent units.
          if (payment.refund.restock && o.stockState === "consumed") {
            const product = s.storeProducts.find((p) => p.id === o.productId);
            if (product)
              movement(
                s,
                product,
                o.quantity,
                "Refunded stock returned",
                "payment-provider",
                clock(),
              );
          }
          o.stockState = "released";
        }
        if (payment.refund.status === "failed") payment.status = "paid";
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
        !["preparing", "ready", "review", "cancelled", "collected"].includes(
          o.status,
        ) ||
        !o.payment.confirmedAt
      )
        return;
      const key = `${o.status}:${o.payment.status}:${o.contact.email}`;
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
        deliveryKey: `store-order/${id}/${hashSecret(claim.key).slice(0, 32)}`,
      });
      await store.transaction((s) => {
        const d = storeState(s).storeOrders.find(
          (o) => o.id === id,
        )?.emailDelivery;
        if (d?.key === claim.key) {
          d.completedKey = claim.key;
          delete d.leaseUntil;
        }
      });
    } catch {
      logger?.warn("store.email_pending", { orderId: id });
    }
  }
  async function run() {
    if (running) return;
    running = true;
    try {
      await store.transaction((s) => expireReservations(s, clock()));
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
      for (const o of state.storeOrders.slice(0, 100)) await notify(o.id);
      for (const o of state.storeOrders
        .filter((o) =>
          ["requested", "pending", "uncertain"].includes(
            o.payment.refund?.status,
          ),
        )
        .slice(0, 10))
        await refund(o.id);
    } finally {
      running = false;
    }
  }
  return { start, verify, refund, webhook, run };
}
