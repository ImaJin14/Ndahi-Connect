import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";

export const billingPolicyVersion = "2026-09-25";
export const unresolvedPayment = (p) => ["pending", "processing"].includes(p.status) ||
  p.fulfillmentStatus === "needs_review" || ["requested", "pending"].includes(p.refund?.status);
export function ensureReceipt(p, plan) {
  if (!p.confirmedAt && !["paid", "refunded", "refund-pending"].includes(p.status)) return null;
  p.receipt ??= {
    number: `NC-${p.id}`, paymentId: p.id, paidAt: p.confirmedAt || p.createdAt,
    provider: p.provider, providerReference: p.providerReference || null,
    amount: p.amount, currency: p.currency, customerName: p.customerName || "Customer",
    plan: structuredClone(p.planSnapshot || plan || { id: p.planId, name: p.planId }),
    policyVersion: p.policyVersion || null,
  };
  return p.receipt;
}
export function paymentView(p) {
  const refund = p.refund || (p.status === "refunded" ? { status: "completed" }
    : p.status === "refund-pending" ? { status: "pending", message: "Awaiting provider confirmation." } : null);
  return {
    id: p.id, planId: p.planId, plan: p.planSnapshot, amount: p.amount, currency: p.currency,
    provider: p.provider, providerReference: p.providerReference, status: p.status,
    createdAt: p.createdAt, confirmedAt: p.confirmedAt, action: p.action, requestKey: p.requestKey,
    replaceVoucherId: p.replaceVoucherId,
    fulfillmentStatus: p.fulfillmentStatus, failureReason: p.failureReason,
    recoveryMessage: p.verificationError ? "The provider could not confirm the result. Recheck this payment; do not pay again."
      : p.creationState === "uncertain" ? "The payment request may have reached your provider. Recheck this payment before trying again." : undefined,
    receiptAvailable: Boolean(p.receipt || p.confirmedAt || ["paid", "refunded", "refund-pending"].includes(p.status)),
    receiptEmail: p.receiptEmail ? { status: p.receiptEmail.status, sentAt: p.receiptEmail.sentAt } : undefined,
    refund: refund && { status: refund.status, requestedAt: refund.requestedAt, updatedAt: refund.updatedAt,
      providerReference: refund.providerReference, message: refund.message, reason: refund.reason },
  };
}
const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function receiptDocument(receipt) {
  const plan = receipt.plan;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Receipt ${h(receipt.number)}</title><body><main><h1>NDAHI Connect payment receipt</h1><dl>${[
    ["Receipt", receipt.number], ["Paid", receipt.paidAt], ["Customer", receipt.customerName],
    ["Package", plan.name], ["Data", plan.quotaGb === null ? "Unlimited (fair use applies)" : plan.quotaGb == null ? "Not recorded" : `${plan.quotaGb} GB`],
    ["Validity", plan.validityHours == null ? "Not recorded" : `${plan.validityHours} hours`],
    ["Devices", plan.deviceLimit ?? "Not recorded"], ["Package amount", `${receipt.amount} ${receipt.currency}`],
    ["Provider", receipt.provider], ["Provider reference", receipt.providerReference || "Not recorded for this historical payment"],
  ].map(([key, value]) => `<dt><strong>${h(key)}</strong></dt><dd>${h(value)}</dd>`).join("")}</dl><p>Provider fees, if any, are shown separately by your payment provider. This receipt records the package payment; check your dashboard for current access and refund status.</p><p>Keep this receipt for your records. You can print it or save it as a PDF from your browser.</p></main></body></html>`;
}

// External money operations are sent only after a durable claim. An uncertain
// submission is never automatically resent: recovery only reads provider state.
export function createBillingService({ store, payments, email, settle, now = () => new Date(), planFor,
  timeoutMs = 20000 }) {
  const stamp = () => now().toISOString();
  async function bounded(task) {
    let timer;
    try { return await Promise.race([task(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Provider unavailable")), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function startPayment(id) {
    const claim = await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (!p || p.creationState !== "reserved") return null;
      p.creationState = "submitted";
      p.submittedAt = stamp();
      return structuredClone(p);
    });
    if (!claim) return;
    let made;
    try { made = await bounded(() => payments[claim.provider].createPayment(claim)); }
    catch { /* The provider may have accepted the charge before the connection failed. */ }
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
  }
  async function recheckPayment(id) {
    const claim = await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (!p || p.provider === "mock" || p.refund || p.confirmedAt ||
        !["pending", "failed", "expired", "cancelled", "processing"].includes(p.status) ||
        Date.parse(p.verificationLeaseUntil) > +now() || Date.parse(p.nextVerificationAt) > +now()) return null;
      p.verificationToken = randomUUID();
      p.verificationLeaseUntil = new Date(+now() + timeoutMs + 5000).toISOString();
      return structuredClone(p);
    });
    if (!claim) return;
    let verified;
    try { verified = await bounded(() => payments[claim.provider].verifyPayment(claim)); } catch { /* retry reads later */ }
    await store.transaction(async (s) => {
      const p = s.payments.find((p) => p.id === id);
      if (!p || p.verificationToken !== claim.verificationToken) return;
      delete p.verificationToken; delete p.verificationLeaseUntil;
      p.nextVerificationAt = new Date(+now() + 5000).toISOString();
      if (p.confirmedAt || p.refund || s.vouchers.some((v) => v.paymentId === id)) return;
      if (!verified || !["paid", "pending", "failed"].includes(verified.status) ||
        !verified.providerReference || verified.transactionReference !== p.id ||
        Number(verified.amount) !== p.amount || verified.currency !== p.currency ||
        s.payments.some((other) => other.id !== id && other.provider === p.provider &&
          String(other.providerReference) === String(verified.providerReference))) {
        p.verificationError = "verification_unavailable_or_mismatched";
        // Local timeouts and missing transactions do not prove that no money moved.
        if (!p.providerFailedAt) p.status = "pending";
        return;
      }
      delete p.verificationError;
      p.providerReference = String(verified.providerReference);
      p.lastVerificationAt = stamp();
      if (verified.status === "paid") await settle(s, p, p.providerReference);
      else {
        p.status = verified.status;
        if (verified.status === "failed") { p.providerFailedAt = stamp(); p.failureReason = "Your provider confirmed that this payment failed."; }
      }
    });
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
    let result;
    try { result = await bounded(() => payments[claim.provider].refundPayment(claim)); } catch { /* never resubmit an uncertain refund */ }
    await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (!p || p.refund.id !== claim.refund.id || p.refund.status !== "pending") return;
      if (result) applyRefund(s, p, result);
      else p.refund.message = "Provider confirmation is unavailable. The request may have succeeded; support must verify it before any new refund.";
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
    let result;
    try { result = await bounded(() => payments[claim.provider].verifyRefund(claim)); } catch { /* pending remains pending */ }
    await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (p?.refund?.id === claim.refund.id && p.refund.status === "pending" &&
        result?.providerReference === claim.refund.providerReference) applyRefund(s, p, result);
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
    let delivered;
    try { delivered = await bounded(() => email.sendReceipt({ to: claim.email, receipt: claim.payment.receipt })); } catch { /* downloadable receipt remains available */ }
    await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === id);
      if (p?.receiptEmail?.token !== claim.payment.receiptEmail.token) return;
      p.receiptEmail.status = delivered ? "sent" : "failed";
      if (delivered) p.receiptEmail.sentAt = stamp();
      delete p.receiptEmail.token;
    });
  }
  let running;
  function run() {
    if (running) return running;
    running = (async () => {
      const state = await store.snapshot();
      for (const p of state.payments.filter((p) => p.creationState === "reserved" ||
        unresolvedPayment(p) || ["failed", "expired", "cancelled"].includes(p.status) && !p.providerFailedAt ||
        (p.confirmedAt || ["paid", "refunded", "refund-pending"].includes(p.status)) && p.receiptEmail?.status !== "sent")
        .sort((a, b) => (Date.parse(a.billingCheckedAt) || 0) - (Date.parse(b.billingCheckedAt) || 0)).slice(0, 25)) {
        await store.transaction((s) => { const current = s.payments.find((x) => x.id === p.id); if (current) current.billingCheckedAt = stamp(); });
        await startPayment(p.id); await recheckPayment(p.id); await recheckRefund(p.id); await sendReceipt(p.id);
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  return { startPayment, recheckPayment, requestRefund, submitRefund, recheckRefund, sendReceipt, run };
}
