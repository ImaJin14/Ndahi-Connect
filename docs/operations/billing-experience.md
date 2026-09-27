# Billing experience (BILL-001–BILL-004)

Implemented and locally verified on 2026-09-25. This extends the authenticated
renewal/switching flow without changing package prices. Billing metadata is stored
inside existing payment JSON payloads in both the local store and PostgreSQL; no
schema migration is required.

## Payment recovery

The API commits a payment reservation before contacting a payment provider. A
second transaction claims that reservation for submission. The provider call runs
outside the database transaction. The persisted `submitted` marker prevents the
same operation being sent again after a crash or lost response. The existing
PostgreSQL advisory transaction lock serializes reservations across API instances;
only one unresolved checkout per customer is permitted, even with distinct keys.
Deploy all API instances together: an older instance does not enforce these rules.

Same-key repeats return the existing order. Reusing a key for a different plan or
action is rejected. Customers can recheck payments in the dashboard; authenticated
checkout also discovers pending payments after browser storage is lost. Guest
checkout stores the original input and random request key in local storage before
sending it. “Resume saved payment” uses `POST /api/purchase/recover`, which only
reads the matching phone/key reservation; it does not initiate a charge. If the
reservation never existed, the original request can be submitted with the same
key. Recovery continues to work when the original package is discontinued.

A clock timeout, missing provider transaction, or failed connection does not prove
that no money moved. These results keep checkout blocked while verification retries.
MeSomb is queried by external reference and Flutterwave falls back to verification
by merchant reference if a create response was lost. Only a matching provider
failure releases a live payment for a new checkout. Old local failed/expired/cancelled
records require provider verification before another charge can be created.
Manual administrator status overrides are rejected.

Confirmed payments use their saved package allowances. If an older competing
payment settles against a different active voucher, the money remains recorded as
paid, a receipt is retained, and activation is marked `needs_review`. It does not
replace the newer voucher or invite a second payment. Support must review the
transaction and, where appropriate, refund it.

## Receipts

The paid payment contains an immutable receipt snapshot: receipt ID, paid date,
provider/reference, package price, and allowances. Signed-in owners can download
an HTML receipt (also printable/saveable as PDF) from Payment history, including
after refund. Requests for another customer's receipt return 404. Historical
paid records get a receipt on retrieval or worker processing; unavailable
historical attributes are explicitly labeled rather than invented.

The billing worker sends receipts to the account email and retries failed delivery.
The email provider receives a stable per-payment idempotency key. The same receipt
remains downloadable during an email outage. “Email receipt” ensures delivery;
it does not send another copy after a recorded successful delivery. Receipt email
status is visible in the dashboard. An account email and configured email adapter
are required for real delivery.

## Refunds

Customers request a full refund with a reason. Owners/operators approve the request
in the admin Payments tab. Submission is committed before provider IO, and repeated
approval cannot send another refund. Both dashboards expose the same refund status:

| Status | Meaning |
| --- | --- |
| requested | Awaiting administrator review; no provider operation yet |
| pending | Submitted or submission outcome uncertain; payout not confirmed |
| completed | Provider confirmed the refund |
| failed | Provider explicitly reported refund failure; support review needed |

Provider refund references are stored separately from original payment references.
“Recheck refund” and the billing worker query the refund without resubmitting it.
Flutterwave's `completed` means initiation, so it remains pending; final payout
statuses such as `completed-momo` indicate completion. A failed disbursement in
provider metadata takes precedence. MeSomb uses the returned refund transaction
and checks its status, amount, and currency.

If a submission response was lost and no refund reference was saved, the request
remains pending with an explicit support message. Support must locate and verify
the original refund in the provider dashboard; this application deliberately has
no automatic resubmission or unverified “mark completed” action. Historical
refund-pending records also cannot be submitted a second time. Confirmed refund
revokes only still-active access originating from that payment, through the durable
router queue; later replacement packages are unaffected.

## Customer rules and worker

`customer-app/billing-terms.html` explains prepaid billing, no automatic renewal,
full-price renewal/switching, immediate replacement on verified payment, no carried
over time/data or automatic proration, Daily eligibility, cancellation before
submission, and refund review. These rules are linked from checkout and Payment
history; the key cancellation rules also appear directly before payment. New
payment records include the displayed policy version.

The billing worker runs every 30 seconds by default, with batches of up to 25 and
persisted check times for fair rotation. `BILLING_WORKER_ENABLED=false` disables
background recovery/email/refund checks; customer/admin manual checks still work.
Watch for `billing.worker_failed` logs, unresolved payments, receipt delivery
failures, pending refunds without references, and fulfillment requiring review.

## Verification

```bash
npm test
npm run check
PLAYWRIGHT_MODULE=/tmp/ndahi-browser-check/node_modules/playwright/index.mjs \
PLAN_CHROME_PATH=/usr/bin/google-chrome node scripts/check-billing-journeys.mjs
PLAYWRIGHT_MODULE=/tmp/ndahi-browser-check/node_modules/playwright/index.mjs \
PLAN_CHROME_PATH=/usr/bin/google-chrome node scripts/check-plan-journeys.mjs
```

Install Playwright outside the repository with
`npm install --prefix /tmp/ndahi-browser-check --no-audit --no-fund playwright`.
The browser harnesses use isolated in-memory data and simulated providers. They
never load `.env`. Billing screenshots are saved to `/tmp/ndahi-billing-checks`.
Override `BILLING_PORT`, `BILLING_API_PORT`, and `BILLING_ADMIN_PORT` if required.

Validation passed: 182 automated tests, syntax/whitespace checks, 8 billing browser
scenarios, and all 13 prior renewal/switching browser scenarios. Desktop, 390px,
and 320px screenshots were inspected. Tests cover concurrent requests, persisted
submission before provider IO, storage failure, restart recovery, uncertain
payments/refunds, receipt ownership and historical availability, email retries,
refund state consistency, and preservation of newer packages on refund.

Real Mobile Money settlement/refund payout, delivered production email, and router
disconnection still require verification with the deployed providers. Guest recovery
after clearing all browser storage requires the emailed confirmation or support.

Provider contracts: [Flutterwave refunds](https://developer.flutterwave.com/docs/refunds),
[fetch refund](https://developer.flutterwave.com/reference/get-transaction-refunds),
and [MeSomb payment operations](https://docs.mesomb.com/development/payment).
