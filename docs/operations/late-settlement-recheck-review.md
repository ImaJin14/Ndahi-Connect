# Late-settlement rechecks after `lateCheckUntil` (BILL-001 review question)

Status: clarification for the product owner. No billing policy or code was changed.
Reviewed on `main` at `474d7e3`, 2026-10-05.

## Question

Should customers (or support) still be able to verify a closed checkout with the
payment provider after its late-check window, `lateCheckUntil`, has ended?

## Current behavior

- **Closing sets the window.** A checkout still unconfirmed after its approval window
  plus grace closes as `expired`. `lateCheckUntil` becomes the closing time plus
  `PAYMENT_LATE_CHECK_HOURS` (default 24). It is zero for reservations that never
  reached the provider (`lib/billing.mjs:25-35`). See
  [payment recovery](billing-experience.md#payment-recovery).
- **One code path verifies with the provider, and it stops at the cutoff.**
  `recheckPayment` refuses once `lateCheckUntil` has passed (`lib/billing.mjs:37,126`).
  The billing worker (`lib/billing.mjs:285-289`) and every status request, signed-in
  or guest (`lib/api/payments.mjs:185`), use this path. After the cutoff, polling
  stops and status requests stop contacting the provider. Within the window, status
  requests cannot add provider calls beyond one every 10 minutes (`nextVerificationAt`).
- **Customers have no recheck control for a closed checkout at any time.** The
  dashboard shows "Check payment status" only for `pending` and `processing`
  payments (`customer-app/app.js:36-37`). An `expired` payment shows the closure
  message and no recheck button, even inside the 24-hour window.
- **Signed webhooks still settle after the cutoff.** Webhook processing verifies with
  the provider directly, without the late-check gate (`lib/payment-webhooks.mjs:111`).
  A confirmed late payment then activates its package, or is held as `needs_review`
  if the customer has already bought again.
- **Reconciliation still sees the order but labels it vaguely.** When enabled in
  production, [payment reconciliation](payment-reconciliation.md) keeps reading
  every MeSomb and Flutterwave order without changing it. If an `expired` order is
  later `paid` at the provider, it is recorded as `payment_status_mismatch`, not
  `settlement_missing`. The `settlement_missing` finding is raised only for local
  `pending` or `failed` orders (`lib/payment-reconciliation.mjs:83-84`).
- **Support cannot re-verify.** No admin action re-runs payment verification (the
  admin route only rechecks refunds, `lib/api/admin.mjs:102`), and manual status
  overrides are rejected.

## Gap

Suppose a customer was charged, and the provider confirms only after the 24-hour
window without delivering a valid webhook (missed, rejected or dead-lettered). That
payment is never applied automatically. The customer has no self-service path. The
only signal is a generic reconciliation mismatch, and support has no supported action
to settle it.

## Options

1. **Keep the cutoff for customers (recommended).** It bounds provider reads. A
   customer-triggered recheck of an old order would let anyone holding a guest status
   key cause provider reads indefinitely. After a re-purchase, a late settlement can
   only produce `needs_review` anyway.
2. **Allow customer rechecks after the cutoff.** This would need a recheck control for
   `expired` payments, a rate limit, and an outer limit in days. It means more
   self-service but also more provider calls and UI work.
3. **Add a support re-verification action (recommended, with option 1).** An
   owner/operator action for closed payments past the cutoff. It would be audited, and
   it would use the same verification guards (exact transaction reference, amount and
   currency) and the same settlement path, so it cannot activate a mismatched
   payment. Pair it with a reconciliation change that reports a provider-paid
   `expired` order as `settlement_missing`, so it is clearly actionable.

## Decision needed

Choose option 1, 2 or 1+3. Until then the documented policy stands: the checks
stop after `PAYMENT_LATE_CHECK_HOURS`, and signed webhooks remain the only automatic
late-settlement path. The `settlement_missing` labelling and the support action
would be follow-up BILL-001 work, with their own tests.
