import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";
import { withCorrelation } from "./correlation.mjs";
import { silentLogger, errorFields } from "./logger.mjs";
import { paymentMethodLabel } from "./receipt.mjs";

export const billingPolicyVersion = "2026-09-25";
export const unresolvedPayment = (p) => ["pending", "processing"].includes(p.status) ||
  p.fulfillmentStatus === "needs_review" || ["requested", "pending"].includes(p.refund?.status);
// A checkout the customer abandoned, or that the provider never resolved, stops blocking a
// new one once its approval window and a grace period pass. Late provider confirmations are
// still honoured: a closed payment keeps being checked, every 10 minutes, for lateCheckHours.
const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
export const checkoutTiming = (env = {}) => ({
  pendingSeconds: positive(env.PAYMENT_PENDING_SECONDS, 300),
  graceSeconds: positive(env.PAYMENT_EXPIRY_GRACE_SECONDS, 120),
  lateCheckHours: positive(env.PAYMENT_LATE_CHECK_HOURS, 24),
});
export const checkoutDeadline = (p, { pendingSeconds = 300, graceSeconds = 120 } = {}) =>
  (Date.parse(p.paymentExpiresAt) || Date.parse(p.createdAt) + pendingSeconds * 1000) + graceSeconds * 1000;
const lateCheckIntervalMs = 600000;
export const closedCheckoutMessage = "This payment was not confirmed in time, so it was closed. You can start a new payment. If your provider confirms it later, we will activate it or hold it for support review.";
// Closes an open, unconfirmed checkout past its deadline; returns whether it closed it.
// Paid, refunded and review-held payments are never touched.
export function closeExpiredCheckout(p, now, timing = {}) {
  const open = ["pending", "processing"].includes(p.status) ||
    (["failed", "expired", "cancelled"].includes(p.status) && !p.providerFailedAt);
  if (!open || p.confirmedAt || p.refund || p.fulfillmentStatus === "needs_review" || p.checkoutClosedAt) return false;
  if (!(+now >= checkoutDeadline(p, timing))) return false;
  p.status = "expired";
  p.checkoutClosedAt = now.toISOString();
  p.lateCheckUntil = new Date(+now + (p.creationState === "reserved" ? 0 : timing.lateCheckHours ?? 24) * 3600000).toISOString();
  p.nextVerificationAt = new Date(+now + lateCheckIntervalMs).toISOString();
  p.failureReason = closedCheckoutMessage;
  return true;
}
const lateCheckOver = (p, now) => Boolean(p.checkoutClosedAt) && !(Date.parse(p.lateCheckUntil) > +now);
const receiptEligible = (p) => Boolean(p.confirmedAt || ["paid", "refunded", "refund-pending"].includes(p.status));
export function ensureReceipt(p, plan) {
  if (!receiptEligible(p)) return null;
  p.receipt ??= {
    number: `NC-${p.id}`, paymentId: p.id, paidAt: p.confirmedAt || p.createdAt,
    provider: p.provider, network: p.network || null, providerReference: p.providerReference || null,
    amount: p.amount, currency: p.currency, customerName: p.customerName || "Customer",
    plan: structuredClone(p.planSnapshot || plan || { id: p.planId, name: p.planId }),
    policyVersion: p.policyVersion || null,
  };
  // Enrich old snapshots from the recorded payment, preserving all frozen amounts/allowances.
  if (!p.receipt.network && p.network) p.receipt.network = p.network;
  return p.receipt;
}
export function paymentView(p) {
  const refund = p.refund || (p.status === "refunded" ? { status: "completed" }
    : p.status === "refund-pending" ? { status: "pending", message: "Awaiting provider confirmation." } : null);
  return {
    id: p.id, planId: p.planId, plan: p.planSnapshot, amount: p.amount, currency: p.currency,
    provider: p.provider, methodLabel: paymentMethodLabel(p.receipt?.network ? p.receipt : p), providerReference: p.providerReference, status: p.status,
    createdAt: p.createdAt, confirmedAt: p.confirmedAt, action: p.action, requestKey: p.requestKey,
    replaceVoucherId: p.replaceVoucherId,
    fulfillmentStatus: p.fulfillmentStatus, failureReason: p.failureReason,
    recoveryMessage: p.status === "expired" ? closedCheckoutMessage
      : !["pending", "processing"].includes(p.status) ? undefined
      : p.verificationError ? "The provider could not confirm the result. Recheck this payment; do not pay again."
      : p.creationState === "uncertain" ? "The payment request may have reached your provider. Recheck this payment before trying again." : undefined,
    receiptAvailable: receiptEligible(p),
    receiptEmail: p.receiptEmail ? { status: p.receiptEmail.status, sentAt: p.receiptEmail.sentAt } : undefined,
    refund: refund && { status: refund.status, requestedAt: refund.requestedAt, updatedAt: refund.updatedAt,
      providerReference: refund.providerReference, message: refund.message, reason: refund.reason },
  };
}
// The branded receipt lives in lib/receipt.mjs; re-exported for existing callers.
export { receiptDocument } from "./receipt.mjs";

// External money operations are sent only after a durable claim. An uncertain
// submission is never automatically resent: recovery only reads provider state.
export function createBillingService({ store, payments, email, settle, now = () => new Date(), planFor,
  timeoutMs = 20000, logger = silentLogger, timing = checkoutTiming() }) {
  const stamp = () => now().toISOString();
  const providerFailed = (operation, p, error) =>
    logger.warn("payment.provider_failed", { operation, paymentId: p.id, provider: p.provider, ...errorFields(error) });
  async function bounded(task) {
    let timer;
    try { return await Promise.race([task(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Provider unavailable")), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function startPayment(id) {
    const claim = await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (!p || p.creationState !== "reserved" || p.checkoutClosedAt) return null;
      // A reservation that missed its window never reached the provider: close it without
      // sending a prompt the customer is no longer waiting for, and without late checks.
      if (closeExpiredCheckout(p, now(), { ...timing, graceSeconds: 0, lateCheckHours: 0 })) {
        logger.info("payment.checkout_expired", { paymentId: p.id, provider: p.provider, state: "never_submitted" });
        return null;
      }
      p.creationState = "submitted";
      p.submittedAt = stamp();
      return structuredClone(p);
    });
    if (!claim) return;
    return withCorrelation({ correlationId: claim.correlationId }, async () => {
      let made;
      try { made = await bounded(() => payments[claim.provider].createPayment(claim)); }
      // The provider may have accepted the charge before the connection failed.
      catch (error) { providerFailed("create_payment", claim, error); }
      await store.transaction((s) => {
        const p = s.payments.find((p) => p.id === id);
        if (!p || p.creationState !== "submitted") return;
        if (!made?.providerReference || s.payments.some((other) => other.id !== id &&
          other.provider === p.provider && String(other.providerReference) === String(made.providerReference))) {
          p.creationState = "uncertain";
          return;
        }
        p.creationState = "accepted";
        p.providerReference = String(made.providerReference);
        p.authorizationMode = made.authorizationMode;
        if (/^https:\/\//i.test(made.checkoutUrl || "")) p.checkoutUrl = made.checkoutUrl;
        // Even an immediate success must be verified independently before fulfillment.
      });
    });
  }
  async function recheckPayment(id) {
    const claim = await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (!p || p.creationState === "reserved" || p.provider === "mock" || p.refund || p.confirmedAt || lateCheckOver(p, now()) ||
        !["pending", "failed", "expired", "cancelled", "processing"].includes(p.status) ||
        Date.parse(p.verificationLeaseUntil) > +now() || Date.parse(p.nextVerificationAt) > +now()) return null;
      p.verificationToken = randomUUID();
      p.verificationLeaseUntil = new Date(+now() + timeoutMs + 5000).toISOString();
      return structuredClone(p);
    });
    if (!claim) return;
    return withCorrelation({ correlationId: claim.correlationId }, async () => {
      let verified;
      try { verified = await bounded(() => payments[claim.provider].verifyPayment(claim)); }
      catch (error) { providerFailed("verify_payment", claim, error); /* retry reads later */ }
      await store.transaction(async (s) => {
        const p = s.payments.find((p) => p.id === id);
        if (!p || p.verificationToken !== claim.verificationToken) return;
        delete p.verificationToken; delete p.verificationLeaseUntil;
        const closed = Boolean(p.checkoutClosedAt);
        p.nextVerificationAt = new Date(+now() + (closed ? lateCheckIntervalMs : 5000)).toISOString();
        if (p.confirmedAt || p.refund || s.vouchers.some((v) => v.paymentId === id)) return;
        if (!verified || !["paid", "pending", "failed"].includes(verified.status) ||
          !verified.providerReference || verified.transactionReference !== p.id ||
          Number(verified.amount) !== p.amount || verified.currency !== p.currency ||
          s.payments.some((other) => other.id !== id && other.provider === p.provider &&
            String(other.providerReference) === String(verified.providerReference))) {
          p.verificationError = "verification_unavailable_or_mismatched";
          // Local timeouts and missing transactions do not prove that no money moved.
          if (!p.providerFailedAt && !closed) p.status = "pending";
          return;
        }
        delete p.verificationError;
        p.providerReference = String(verified.providerReference);
        p.lastVerificationAt = stamp();
        if (verified.status === "paid") await settle(s, p, p.providerReference);
        // A closed checkout stays closed while the provider still reports it pending.
        else if (!(closed && verified.status === "pending")) {
          p.status = verified.status;
          if (verified.status === "failed") { p.providerFailedAt = stamp(); p.failureReason = "Your provider confirmed that this payment failed."; }
        }
      });
    });
  }
  async function expireCheckout(id) {
    const closed = await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      return p && closeExpiredCheckout(p, now(), timing) ? { provider: p.provider, correlationId: p.correlationId } : null;
    });
    if (closed) {
      withCorrelation({ correlationId: closed.correlationId }, () =>
        logger.info("payment.checkout_expired", { paymentId: id, provider: closed.provider, state: "window_elapsed" }));
    }
  }
  function requestRefund(p, reason) {
    if (p.refund) return;
    if (["refunded", "refund-pending"].includes(p.status)) {
      p.refund = { id: randomUUID(), status: p.status === "refunded" ? "completed" : "pending",
        submittedAt: stamp(), updatedAt: stamp(), message: "Historical refund: support must verify its provider reference; do not submit another refund." };
      return;
    }
    p.refund = { id: randomUUID(), status: "requested", requestedAt: stamp(), updatedAt: stamp(),
      reason: String(reason || "Full refund requested").slice(0, 500),
      message: "Your refund request is awaiting administrator review." };
  }
  function applyRefund(s, p, result) {
    if (!result || !["pending", "completed", "failed"].includes(result.status)) return;
    p.refund.status = result.status;
    p.refund.updatedAt = stamp();
    p.refund.providerReference = result.providerReference || p.refund.providerReference;
    p.refund.message = result.status === "completed" ? "Your provider confirmed the refund."
      : result.status === "failed" ? "Your provider reports that the refund failed. Contact support for review."
        : "Your provider is processing the refund. A request is not confirmation that funds have arrived.";
    if (result.status === "completed") {
      p.status = "refunded";
      p.fulfillmentStatus = "refunded";
      for (const v of s.vouchers.filter((v) => v.paymentId === p.id && v.status === "active")) {
        v.status = "refunded";
        v.routerSyncStatus = "pending";
        enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, now);
        for (const session of s.sessions.filter((x) => x.voucherId === v.id)) session.status = "disconnected";
      }
    } else p.status = result.status === "pending" ? "refund-pending" : "paid";
  }
  async function submitRefund(id) {
    const claim = await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (!p?.refund || p.refund.status !== "requested" || p.refund.submittedAt) return null;
      p.refund.status = "pending"; p.refund.submittedAt = stamp(); p.refund.updatedAt = stamp();
      p.refund.message = "The refund request is being confirmed with your provider.";
      p.status = "refund-pending";
      return structuredClone(p);
    });
    if (!claim) return;
    return withCorrelation({ correlationId: claim.correlationId }, async () => {
      let result;
      try { result = await bounded(() => payments[claim.provider].refundPayment(claim)); }
      catch (error) { providerFailed("refund_payment", claim, error); /* never resubmit an uncertain refund */ }
      await store.transaction((s) => {
        const p = s.payments.find((p) => p.id === id);
        if (!p || p.refund.id !== claim.refund.id || p.refund.status !== "pending") return;
        if (result) applyRefund(s, p, result);
        else p.refund.message = "Provider confirmation is unavailable. The request may have succeeded; support must verify it before any new refund.";
      });
    });
  }
  async function recheckRefund(id) {
    const claim = await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (!p?.refund || p.refund.status !== "pending" || !p.refund.providerReference ||
        Date.parse(p.refund.nextCheckAt) > +now()) return null;
      p.refund.nextCheckAt = new Date(+now() + timeoutMs + 10000).toISOString();
      return structuredClone(p);
    });
    if (!claim) return;
    return withCorrelation({ correlationId: claim.correlationId }, async () => {
      let result;
      try { result = await bounded(() => payments[claim.provider].verifyRefund(claim)); }
      catch (error) { providerFailed("verify_refund", claim, error); /* pending remains pending */ }
      await store.transaction((s) => {
        const p = s.payments.find((p) => p.id === id);
        if (p?.refund?.id === claim.refund.id && p.refund.status === "pending" &&
          result?.providerReference === claim.refund.providerReference) applyRefund(s, p, result);
      });
    });
  }
  async function sendReceipt(id) {
    const claim = await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (!p || !ensureReceipt(p, planFor(s, p.planId)) || p.receiptEmail?.status === "sent" ||
        Date.parse(p.receiptEmail?.nextAttemptAt) > +now()) return null;
      const customer = s.customers.find((c) => c.id === p.customerId);
      p.receiptEmail = { ...p.receiptEmail, status: "pending", token: randomUUID(),
        nextAttemptAt: new Date(+now() + 60000).toISOString() };
      return { payment: structuredClone(p), email: customer?.email };
    });
    if (!claim) return;
    return withCorrelation({ correlationId: claim.payment.correlationId }, async () => {
      let delivered;
      try {
        delivered = await bounded(() => email.sendReceipt({ to: claim.email, receipt: claim.payment.receipt }));
        logger.info("email.sent", { kind: "receipt", paymentId: id });
      } catch (error) {
        logger.warn("email.failed", { kind: "receipt", paymentId: id, ...errorFields(error) }); // downloadable receipt remains available
      }
      await store.transaction((s) => {
        const p = s.payments.find((p) => p.id === id);
        if (p?.receiptEmail?.token !== claim.payment.receiptEmail.token) return;
        p.receiptEmail.status = delivered ? "sent" : "failed";
        if (delivered) p.receiptEmail.sentAt = stamp();
        delete p.receiptEmail.token;
      });
    });
  }
  let running;
  function run() {
    if (running) return running;
    running = (async () => {
      const state = await store.snapshot();
      // Closed checkouts drop out once their late-check window ends, so abandoned payments
      // cannot crowd out new ones.
      for (const p of state.payments.filter((p) => (p.creationState === "reserved" && !p.checkoutClosedAt) ||
        unresolvedPayment(p) || ["failed", "expired", "cancelled"].includes(p.status) && !p.providerFailedAt && !lateCheckOver(p, now()) ||
        (p.confirmedAt || ["paid", "refunded", "refund-pending"].includes(p.status)) && p.receiptEmail?.status !== "sent")
        .sort((a, b) => (Date.parse(a.billingCheckedAt) || 0) - (Date.parse(b.billingCheckedAt) || 0)).slice(0, 25)) {
        await store.transaction((s) => { const current = s.payments.find((x) => x.id === p.id); if (current) current.billingCheckedAt = stamp(); });
        await startPayment(p.id); await recheckPayment(p.id); await expireCheckout(p.id); await recheckRefund(p.id); await sendReceipt(p.id);
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  return { startPayment, recheckPayment, expireCheckout, requestRefund, submitRefund, recheckRefund, sendReceipt, run };
}
