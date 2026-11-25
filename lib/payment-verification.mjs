// One set of rules for a provider's answer about a bundle payment, used by the
// synchronous check (billing.mjs) and by authenticated webhooks
// (payment-webhooks.mjs), before anything is provisioned (#432; 24 Nov brief,
// docs/redesign/specs/catalogue-and-payment-update-2026-11-24.md §2):
//
// - the provider confirmed success: for MeSomb, `transaction.status` is exactly
//   "SUCCESS" (lib/payments.mjs maps anything else away from "paid");
// - the identity matches: the transaction is this payment's (`trxID`), its
//   provider reference is the authenticated webhook's (or, polling, the one
//   recorded), and no other payment holds it;
// - the currency is XAF, as recorded;
// - the merchant credit the provider reports equals the base price stored on
//   the payment. With `fees: false` the provider reports `amount` (what the
//   merchant is credited) and `fees`, and `trxamount` = amount + fees, which
//   is recorded as the customer's debit beside the quote (payment-fees.mjs).
//
// A provider that reports money taken (or a success it can't confirm) for
// details that don't match goes to reconciliation for support review: never
// activated, never retried into a second charge. Anything else that fails these
// rules is treated as unverified, as before.
import { randomUUID } from "node:crypto";

const STATUSES = ["paid", "pending", "failed", "refunded", "unconfirmed"];
// The provider says money may have moved: a mismatch needs a person.
const moneyMoved = (verified) => ["paid", "unconfirmed"].includes(verified?.status);

export function verificationVerdict(s, p, verified, { transactionId } = {}) {
  const mismatch = (issue) => ({ ok: false, issue, reconcile: moneyMoved(verified) });
  if (!verified || !STATUSES.includes(verified.status) || !verified.providerReference) return { ok: false, issue: "verification_unavailable", reconcile: false };
  // The provider reference is checked against the best evidence each path has:
  // an authenticated webhook's transaction id, else the reference recorded at
  // creation. (MeSomb's creation answer can carry its request reference rather
  // than the transaction's, so the webhook's id wins when there is one; a
  // recorded reference that is only our own payment id carries no identity.)
  const reference = String(verified.providerReference), recorded = p.providerReference && String(p.providerReference) !== p.id ? String(p.providerReference) : null;
  const expected = transactionId ? String(transactionId) : recorded;
  if (verified.transactionReference !== p.id || (expected && expected !== reference) ||
      s.payments.some((other) => other.id !== p.id && other.provider === p.provider && String(other.providerReference) === reference))
    return mismatch("identity_mismatch");
  if (verified.currency !== "XAF" || verified.currency !== p.currency) return mismatch("currency_mismatch");
  if (!Number.isFinite(Number(verified.amount)) || Number(verified.amount) !== p.amount) return mismatch("amount_mismatch");
  if (verified.status === "unconfirmed") return mismatch("provider_status_unconfirmed");
  return { ok: true };
}

// Holds the payment for support review with what the provider reported, once
// per distinct issue (repeated callbacks and polls add nothing new).
export function routeToReconciliation(s, p, issue, verified, now) {
  const at = new Date(now).toISOString(), previous = p.reconciliation || {};
  const issues = [...new Set([...(previous.issues || []), "payment_details_mismatch", issue])];
  const reported = { status: verified?.status ?? null, providerStatus: verified?.providerStatus ?? null, amount: Number.isFinite(Number(verified?.amount)) ? Number(verified.amount) : null,
    currency: verified?.currency ?? null, providerReference: verified?.providerReference ? String(verified.providerReference) : null,
    ...(Number.isFinite(verified?.providerFee) ? { fee: verified.providerFee, total: verified.providerTotal } : {}) };
  const same = JSON.stringify(previous.issues || []) === JSON.stringify(issues);
  p.reconciliation = { ...previous, status: "needs_review", issues, checkedAt: at, reported };
  // The money may have moved: the checkout is held open (never closed as
  // expired) and blocks another charge until support fulfils or refunds it.
  // Kept apart from the periodic reconciler's record, which it rewrites.
  p.verificationHold ??= { issue, at, reported };
  p.failureReason = "Payment received. It needs a support check before your bundle starts. Do not pay again.";
  if (!same) {
    s.events ??= [];
    s.events.unshift({ id: randomUUID(), type: "payment.reconciliation_issue", at, meta: { paymentId: p.id, provider: p.provider, issues, source: "verification" } });
    s.events = s.events.slice(0, 500);
  }
  return p.reconciliation;
}
