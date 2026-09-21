# Payment reconciliation (PAY-001)

The API checks stored MeSomb and Flutterwave orders against provider verification
responses every five minutes, including failed orders that could settle late and
paid orders with missing vouchers. Mock payments are excluded. Checks start when
the API listens in production; bootstrap mode disables the default. Existing
provider credentials are reused; no new service or database migration is required.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAYMENT_RECONCILIATION_ENABLED` | true in production outside bootstrap | Explicit `true`/`false` override |
| `PAYMENT_RECONCILIATION_INTERVAL_SECONDS` | 300 | Schedule and minimum time between checks per order |
| `PAYMENT_RECONCILIATION_BATCH_SIZE` | 25 | Maximum orders per pass, capped at 100 |
| `PAYMENT_RECONCILIATION_DELAY_SECONDS` | 900 | Age at which pending orders are flagged |

Oldest-checked orders are selected first. Each provider read has a 20-second
deadline and runs outside the database write transaction. A persisted per-order
lease prevents concurrent workers checking the same order; abandoned leases
expire after 50 seconds. Results are discarded when payment details or status
change while verification is running. Transient failures are retried on later
passes. At high volume, increase the batch size or reduce the interval and monitor
the last-checked timestamps; a full sweep can take multiple passes.

## Operator review

Open **Payments → Payment reconciliation** in the admin application. All recorded
unresolved findings are included, even for orders outside the recent-payment list.
Each payment stores its latest check and findings in its existing JSON payload.
Changes also emit `payment.reconciliation_issue` or
`payment.reconciliation_resolved` events without customer data or raw provider
responses. A worker-level storage failure emits `payment.reconciliation_failed`
to the API error log.

- `settlement_missing`: provider says paid; local order is pending or failed.
- `provider_payment_missing`: MeSomb explicitly returned no transaction.
- `provider_reference_missing`: local order has no provider transaction reference.
- `voucher_missing` / `duplicate_vouchers`: a paid order has no voucher, or an
  order has multiple vouchers.
- `duplicate_provider_reference`: multiple local orders claim the same transaction
  from the same provider.
- `payment_details_mismatch`: provider order ID, amount, currency, transaction
  reference, or response shape does not match expectations.
- `payment_status_mismatch`: other differences, including refund states requiring
  operator verification.
- `delayed_payment`: local payment remains pending beyond the configured age.
- `verification_unavailable`: provider timeout, authentication failure, invalid
  reference, or other unsuccessful verification. This does not mean unpaid.

Verify flagged orders in the provider console before taking action. Never create
a replacement charge to resolve a discrepancy. A transient failure must not be
interpreted as a failed payment. Duplicate references and mismatched amounts need
manual investigation before any access is granted or refund is attempted.

This task implements **detection**, not automatic financial correction. It never
changes payment statuses, issues vouchers, sends emails, charges, or refunds.
Existing verified webhook and checkout handling remain responsible for settlement.
Webhook replay is PAY-002. Findings clear after a later successful matching check.

Coverage is local-order-to-provider reconciliation. Transactions that exist only
at the provider and have no local order cannot be discovered through these
single-order verification APIs; compare provider exports separately. Flutterwave
lookup failures are conservatively reported as unavailable, not proof of absence.
Provider refund verification remains limited by existing adapter status mapping.

## Verification

Run `node --test test/payment-reconciliation.test.mjs`, `npm run check`, and
`npm test`. Tests use stub providers and do not charge customers. Before production
rollout, enable checks in staging with provider sandbox credentials and confirm
the last-checked times and admin findings. Deployment and live provider validation
must be recorded separately from local automated test results.
