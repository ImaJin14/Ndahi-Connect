# Active subscription purchase protection

Issue: [#132](https://github.com/ImaJin14/Ndahi-Connect/issues/132)

Customers keep their current usable allowance. Guest checkout (including the
legacy upgrade flag), authenticated renewal and switching cannot replace an
active bundle. The same rule is checked inside reservation and settlement
transactions, with a further eligibility check before provider submission. An old
`replaceVoucherId` is not an exemption.

## Eligibility

An active voucher blocks a new customer purchase until server time reaches its
expiry, or its finite data allowance reaches zero. Unlimited bundles remain
protected until expiry. Pending, expired, exhausted and cancelled vouchers do not
themselves establish a usable allowance. Invalid active expiry/quota information
fails closed until reconciled. Account suspension blocks reservation and causes
already received payments to need review before activation.

The existing lifecycle cleanup marks expired/exhausted vouchers and queues their
network removal. A new purchase does not rewrite those historical records as an
early renewal/switch. New payment records snapshot billing policy version `2026-10-24`; historical
receipts keep their existing policy. Full catalogue prices, validity starting at verified
payment and the Daily seven-day eligibility rule remain in effect.

## Checkout and recovery

The dashboard exposes `subscriptionPurchaseAccess` separately from Wi-Fi purchase
coverage. Renew/switch/quick-renew and catalogue purchase links are hidden while
blocked; direct onboarding/quick/upgrade links cannot enable checkout. A guest
entering an active account's number, or a resale claim overtaken by a new
activation before PIN verification, receives only a code and safe guidance with
**Sign in to connect**. Account data is displayed after authentication.

Same-key replay still retrieves its existing payment and never submits another
charge. Genuine pending requests retain their finite duplicate-payment guard.
The shared gateway/local request deadline, recovery keys, receipts and late
reconciliation from PR #126 remain intact. Account/balance/history and existing
payment recovery stay reachable off-network.

If a previously submitted or late payment conflicts with an active bundle, record
it as paid with a receipt/provider reference and `fulfillmentStatus: needs_review`.
Do not replace/disconnect the existing voucher or its devices, create another
voucher, promise a refund or ask the customer to pay again. Support uses the
existing review/refund workflow; a review is not proof of a completed refund.
Duplicate callbacks remain idempotent, including a payment already fulfilled.

Explicit administrator replacement from issue #105 is separate: its existing
permission, confirmation, audit and exact-voucher router commands are preserved.
Customer parameters cannot invoke this exception.

## Persistence and release

No new table, migration, credential or infrastructure is required. The existing
PostgreSQL normalized tables, unique phone/provider-reference/voucher-code
constraints, customer-scoped advisory locks and transactional fulfillment remain
the concurrency boundary. Dedicated PostgreSQL tests exercise two API/store
instances, guest/account contention, callback replay and rollback.

Roll out compatible API behavior before or with customer assets. Older portals
receive a safe rejection from the new API; they cannot bypass it. Already issued
vouchers/accounts/payments are not deleted or migrated. A legacy pending early
replacement can now enter paid review rather than consuming a live allowance.

Rollback uses the previously recorded successful service deployments or a reviewed
Git revert. It changes future purchase policy back; do not restore a database
backup over newer payments. Preserve review/receipt/history records and inspect
pending checkout state before any operator action.

## Validation and evidence

- `npm test`: policy, privacy, suspension, pending expiry, legacy replacement,
  competing settlement, duplicate callback, rollback and existing regressions.
- With `TEST_DATABASE_URL` set, the dedicated PostgreSQL races run in disposable
  schemas. A local skip is not PostgreSQL evidence.
- `npm run check:subscription:browser`: desktop/390px/320px dashboard and direct
  link protection, private guest rejection, sign-in/reconnect, expiry/exhaustion,
  stale-page refusal, legacy pending recovery and eligible renewal/switch cases.
- Existing billing, account, coverage, authorization, receipt/refund and device
  journeys remain required. Run `npm run check`, provider fixtures and the
  established CI checks before merging.
- Record exact commits, executed checks and service deployment/release evidence
  on issue #132 and its PR. Production smoke checks establish health/assets, not
  a real Mobile Money charge or physical router/device acceptance. Do not perform
  real charges or mutate private production accounts merely to populate evidence.
