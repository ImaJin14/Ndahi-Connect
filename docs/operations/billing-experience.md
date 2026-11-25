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
only one live, unconfirmed request per customer is permitted, even with distinct keys. Activation reviews and refunds remain recorded independently and do not create an indefinite checkout block.
Deploy all API instances together: an older instance does not enforce these rules.

Same-key repeats return the existing order and apply expiry immediately when its
request deadline has passed; they do not submit another charge or
create another order. Reusing a key for a different plan or
action is rejected. Customers can recheck payments in the dashboard; authenticated
checkout also discovers pending payments after browser storage is lost. Guest
checkout saves only the random request key, plan and (once known) payment ID before
sending the request, in an `ndahi-checkout` cookie (`Max-Age` bounded by the request deadline, `SameSite=Strict`,
`Secure` over HTTPS). The browser deletes it even if the device never opens the
portal again; name, phone and email are never stored on the device. Per-plan
`ndahi-payment-*` keys use the same cookies.

Every visit to the packages page checks a saved key with `POST /api/purchase/recover`,
which finds the reservation by key alone (portal keys are 32 random hex characters;
shorter keys need the matching phone, as older portals send), and returns only the name, number, email and network supplied for that guest checkout. Existing account profile fields are never used to prefill an unauthenticated form; legacy payment records without a guest-detail snapshot return blank name/email. Guest payment contact/name snapshots also use the guest request, while authenticated purchases retain account defaults. It
never initiates a charge. Expired or closed access is forgotten; a pending or paid checkout within its request window offers **Resume saved payment**. If the API does not
recognise the key, it is forgotten and the page explains that access may have expired: this does not establish whether money moved. It links to Payments and Help and retains any known payment reference on screen. Recovery never automatically starts a replacement charge.
A request the API rejects is not saved. Recovery continues to work when the original
package is discontinued. Records saved by earlier portal versions in localStorage are
moved to the cookie without their contact details on the next sign-in, dashboard or
packages visit.

Guest status reads at `GET /api/payments/:id/status` require the private request key
in `X-Checkout-Key`, or the payment owner's active session. An ID from a shared
receipt does not authorize status access or disclose an activation code. The key
expires at the same request deadline as the countdown and checkout guard. Provider expiry evidence can shorten it; the fallback is five minutes. Legacy grace cannot extend the approval deadline or private recovery credentials. Keys also stop working on provider failure, closure, PIN completion or exchange for PIN setup. Financial late-payment checks retain their separate polling window; extending `PAYMENT_LATE_CHECK_HOURS` does not extend guest access. Worker outages cannot keep a key valid. Authenticated checkouts require their owning account session and do not grant anonymous recovery through a request key. Afterwards status
and recovery with that key return 404. Deploy the API before the customer app for
this change; the API still accepts phone + key from pages already open on older versions. Missing
or incorrect proof returns 404 before provider verification or email work; the
response is authorized again inside the transaction. Account status reads continue
to require the owner's session. Guests without their saved key can sign in or use
their voucher email; historical payments without a key require the owner's session.
Deploy the API and customer app together so guest polling sends the new header.

A confirmed guest exchanges their key at `POST /api/account/setup/checkout` before the request deadline. The API revokes that key and sets a separate ten-minute HttpOnly, SameSite=Lax, Secure cookie scoped to `/api/account/setup`. It authorizes only PIN setup for the paid order's customer/voucher. Existing PIN accounts return to login; this flow cannot reset an existing PIN. The cookie survives reloads without storing voucher codes or contact details in browser storage, is consumed on PIN creation, and expires independently even if workers stop. Exchange retries reproduce the same cookie without extending expiry, and require the original key before its deadline. Stored grants contain a hash, never the cookie token. API replicas must share the customer session secret; the previous secret supports rotation during the short handoff.

Expired checkout access shows neutral payment guidance, links to Payments/Help and any known reference. It never claims a payment failed or starts a replacement charge automatically. Details from expired requests are not recovered or prefilled. A customer explicitly choosing another package sees its current price, allowances, validity and rules before requesting another payment. Historical payments, receipts and voucher codes remain accessible to their authenticated owner.

A clock timeout, missing provider transaction, or failed connection does not prove
that no money moved. These results keep checkout blocked during its approval window
while verification retries.
MeSomb is queried by external reference and Flutterwave falls back to verification
by merchant reference if a create response was lost. A matching provider failure permits a new checkout immediately. Otherwise the
checkout closes at PAYMENT_PENDING_SECONDS (default 300), shortened by trusted gateway expiry evidence. PAYMENT_EXPIRY_GRACE_SECONDS is deprecated and ignored, permitting a customer-initiated new
payment. Closing does not establish that no charge occurred. Same-key retries
still return the original order; the browser releases its key for expired orders.
Closed submitted payments are checked every ten minutes for
`PAYMENT_LATE_CHECK_HOURS` (default 24) after closure. Signed webhooks remain
eligible for provider verification after that window. Never-submitted reservations
expire without contacting the provider. Paid, refunded and review-held orders are
never closed. Old unresolved records follow the same closure rules.
Manual administrator status overrides are rejected.

Confirmed payments use their saved package allowances. If an older competing
payment settles against a different active voucher, the money remains recorded as
paid, a receipt is retained, and activation is marked `needs_review`. It does not
replace the newer voucher or invite a second payment. Support must review the
transaction and, where appropriate, refund it.

## Low Mobile Money balance (18 November 2026)

No provider lets NDAHI read a payer's balance before a request (MeSomb's balance
endpoint is the merchant's own; MTN's is the same), so a low balance cannot be
detected before the charge is asked for. Instead:

- **When the operator refuses the request for its balance**, the payment closes at
  once as a confirmed failure (`creationState: "refused"`, `status: "failed"`, no
  money taken) and the customer sees why straight away, instead of waiting out the
  five-minute approval window. They can pay again immediately. MeSomb answers with
  HTTP 400 `subscriber-insufficient-balance` (reason `low_balance`) or an answer
  that also covers account limits, such as `CUSTOMER_BALANCE_INVALID` (reason
  `check_balance`, kept for support records). The portal shows the canvas "Not
  enough Mobile Money" screen for both; the design has no separate view. Since
  19 November every payment screen also says, before paying, that the balance must
  cover the total including the Mobile Money fee (see "Mobile Money fee and total
  before paying" below), and the failure names that total. MeSomb's catch-all
  `subscriber-internal-error` names no single cause and is not treated as a
  balance refusal.
- A balance failure reported later (webhook, status check or reconciliation)
  gets the same reasons.
- Any other submission error still leaves the payment uncertain and checked with
  the provider; it is never closed on a guess.
- Refusals are counted as `outcome="refused"` in `ndahi_dependency_calls_total`, so
  customers with low balances do not set off the payment-provider failure alerts.
- The device store checkout is unchanged: a refusal there is still verified as
  uncertain.

## Mobile Money fee and total before paying (19 November 2026, #297)

MeSomb is asked with `fees: false` (`lib/payments.mjs`), so the payer approves the
price plus MeSomb's fee. The customer now sees the price, the fee for their network
and the total before paying, and a low-balance failure names that total. Who pays
the fee is unchanged.

- **Where the fee comes from.** MeSomb has no call that quotes its fee before a
  charge. Its `getPricing()` response is undocumented beyond the application's key
  and name. It reports the fee it charged (`fees`, and `trxamount` = price + fee)
  on a transaction. So the quote comes from one rule per network on the API
  service, set from the MeSomb contract:

  ```text
  PAYMENT_FEE_MTN="percent=…,on=price|gross,fixed=…,min=…,max=…,round=up|down|nearest"
  PAYMENT_FEE_ORANGE="…"
  ```

  `percent` is 0–50 with up to 4 decimals. `on=price` takes that share of the
  price; `on=gross` takes it of the total collected (total = price / (1 − percent)).
  `fixed`, `min` and `max` are whole FCFA. Rounding defaults to `up`, so "your
  balance needs at least {total}" stays true. Any invalid rule counts as not set.
  The rules apply only with `PAYMENT_MODE=mesomb` (or `mock` in tests).
- **No rule, no number.** Without a rule the fee is `null` and every screen shows
  the price "plus the Mobile Money fee shown in your prompt". The front ends never
  work a fee out.
- **One quote, kept.** `lib/payment-fees.mjs` `quotePayment(price, network)`
  returns `{ price, fee, total, network }`. `GET /api/plans` and the dashboard's
  `availablePlans` carry `paymentQuotes` per network, and the store catalogue
  carries one per quantity. The quote is saved on the payment or store order as
  `fee` and `total` when the charge starts; `amount` stays the price sent to
  MeSomb.
- **What MeSomb reports.** When a transaction succeeds, MeSomb's `fees` and
  `trxamount` are saved as `providerFee` and `providerTotal`. They replace the quote
  on the payment view and the receipt, since they are what was taken. A pending
  request's fee is not trusted (it may not be set yet). A difference from the quote
  is logged once as `payment.fee_mismatch` or `store.fee_mismatch`.
- **Screens.**
  - v2 buy a bundle, buy for someone else, renew, both store checkouts and the
    failure screen follow `docs/redesign/screens/`: a breakdown, "Pay {total}",
    the amber balance note, a waiting screen that shows the total, and failure
    details with the fee and the total.
  - `check_balance` keeps the softer "check your balance covers {total}" wording.
  - v1 replaces its old fee note with the fee and the total.
- **Receipts.** Bundle receipts (email, PDF, portal) and store receipts list the
  price, the fee and the total paid when a fee is known. Older payments keep their
  original receipt.
- **Setting or checking the rule.** In the API service's shell on Render, run:

  ```sh
  node scripts/check-payment-fees.mjs [--limit 30]
  ```

  It is read-only. It prints MeSomb's pricing answer with the key removed, and for
  recent paid MeSomb payments the fee MeSomb charged as a share of the price and of
  the total, then whether the configured rule reproduces every fee. No phone
  numbers, names or keys are printed. Set `PAYMENT_FEE_MTN` and
  `PAYMENT_FEE_ORANGE` on `ndahi-api` once the rule matches, and run it again
  after a contract change.

## Verified 2% fee and reconciliation before activation (25 November 2026, #432)

From the 24 Nov brief (`docs/redesign/specs/catalogue-and-payment-update-2026-11-24.md` §2).

### Showing the 2% fee: only once it is verified, per network

The screens show **Bundle Price · Mobile Payment Fee (2%) · Total to Pay** for a network only when that network has a fee rule (see above). Until then they show the base price, and say the Mobile Money fee appears in the operator prompt. They never show a percentage or total that hasn't been confirmed.

To verify a network:

1. Make one real bundle payment on it, for example Personal Unlimited 24 hours at 500 XAF.
2. In the MeSomb dashboard, and on the payer's Mobile Money statement, write down what was **debited from the customer**, the **processing fee**, and what was **credited to the NDAHI account**.
3. Compare them with `node scripts/check-payment-fees.mjs` (read-only), which shows MeSomb's `fees` and `trxamount` for recent payments.
4. If the customer debit is the base price plus `Math.round(base × 0.02)`, and the credit is the base price, set on `ndahi-api`:

   ```text
   PAYMENT_FEE_MTN="percent=2,on=price,round=nearest"
   PAYMENT_FEE_ORANGE="percent=2,on=price,round=nearest"
   ```

   Set each network only after checking it. `round=nearest` gives 250 → 255, 500 → 510, 2,500 → 2,550 and 6,000 → 6,120 XAF.
5. Record the check below.

| Network | Date | Base price | Customer debit | Processing fee | Merchant credit | `fees` | `trxamount` | Rule set |
|---|---|---|---|---|---|---|---|---|
| MTN MoMo | | | | | | | | |
| Orange Money | | | | | | | | |

**What `trxamount` means.** MeSomb reports `amount` (the price we sent), `fees` and `trxamount`. On the records seen so far, `trxamount` = `amount` + `fees`, which looks like the customer's debit. It is saved as `providerTotal` beside the quote, and it is **not** used to decide anything until the table above confirms it against the dashboard and statement. Reconciliation uses `amount`, the merchant credit.

### One rule set before anything is activated

The checkout status poll (`lib/billing.mjs`) and authenticated webhooks (`lib/payment-webhooks.mjs`) apply the same rules (`lib/payment-verification.mjs`) before a bundle is activated:

- **Status:** exactly MeSomb's `SUCCESS`. Another success word ("SUCCESSFUL", "SUCCEEDED") is *unconfirmed* and is never activated.
- **Identity:** the transaction is this payment's (`trxID`), its provider reference is the authenticated webhook's (when polling, the one recorded at creation), and no other payment holds it.
- **Currency:** `XAF`.
- **Merchant credit:** `amount` equals the base price stored on the payment.

**When the money moved but the details don't match.** If the provider reports success (or an unconfirmed success) and any rule fails, the payment goes to reconciliation:

- `reconciliation.status = "needs_review"`, with the issue (`amount_mismatch`, `currency_mismatch`, `identity_mismatch` or `provider_status_unconfirmed`) and what the provider reported.
- A `payment.reconciliation_issue` event, and an entry under Admin → payment reconciliation.
- Nothing is activated, and the checkout stays unresolved, so the customer isn't asked to pay again.
- Support checks the MeSomb records, then either fulfils the bundle by hand or refunds.

A mismatch on a pending or failed answer only counts as unverified, as before.

**Activation is once per payment.** Polls, repeated webhooks and the late checks all settle through the same path. A payment that already has its voucher is never settled again.

**Older payments are unchanged.** Payments made before this change keep their recorded amounts, quote and receipt.

## Payment states, retry and the cheaper bundle (25 November 2026, #433)

From the 24 Nov brief §3, with the canvas PhonePaymentFailed (#409) and PhoneReceipt (#369).

### Seven states

Every provider answer becomes one state (`lib/payment-states.mjs`), whether it comes from the checkout poll, an authenticated webhook, or a refusal when the request is created:

| State | When |
|---|---|
| `paid` | MeSomb's own `SUCCESS`, and the verification rules hold (#432). |
| `pending` | MeSomb is still waiting for the customer. |
| `expired` | The request expired or timed out, or the checkout's window closed. |
| `cancelled_or_pin` | The customer cancelled, or entered a wrong PIN. |
| `invalid_subscriber` | The number isn't on that network's Mobile Money. |
| `insufficient_funds` | The balance was too low (or the operator's combined balance-or-limit answer). |
| `unclear` | Anything ambiguous: MeSomb's catch-all ("it can be: insufficient fund, timeout, wrong secret code…"), a failure with no reason, an answer that couldn't be confirmed, or a payment held for review. A cause is never guessed. |

**How an answer is read:**
- **Codes first.** The provider's error code (`subscriber-insufficient-balance`, `CUSTOMER_BALANCE_INVALID`, …) wins over the message.
- **PIN before number.** An explicit PIN error is read before invalid-number wording, so "wrong PIN for the number …" is `cancelled_or_pin`.
- **Refused at creation.** Only a balance refusal is final there, as before. Any other rejection stays `unclear` until the provider answers, rather than guessing.

**What the payment view returns:**
- `state`, `retryAllowed`, `reference` (the provider's, or the NDAHI payment ID when there is none) and `paymentConfirmed`;
- `activation` on the checkout status: `activating`, `active`, `waiting_first_connection` or `review`. Payment confirmed and Wi-Fi active stay separate.

The older `failureCode` and English sentences stay, so the current screens keep working until #409 rebuilds them.

### Retry and a second charge

- **Retry** (`retryAllowed`) only once the attempt has certainly ended: the provider confirmed the failure or expiry, the request never reached the provider, or the checkout's window closed.
- **While pending or unclear,** a new checkout is refused (`PAYMENT_IN_PROGRESS`, or `PAYMENT_UNDER_REVIEW` for a payment held by #432), and checking continues.
- **A later success activates once,** by poll or webhook. A late failure event never downgrades a paid payment.

### The cheaper bundle after insufficient funds

The checkout status adds `cheaperBundle` for `insufficient_funds`, **only when the network's fee is verified** (it has a numeric quote). The bundle is chosen this way:
1. The highest-priced bundle on sale strictly below the attempted base price, of the same kind: fixed-data, Personal Unlimited or Home WISP.
2. On a tie, the device count closest to the one asked for.
3. Then the longer validity.
4. Then the display order.

The response gives its price, fee and total. With no eligible bundle there is no suggestion. The screen opens that bundle's confirmation; the customer still taps Pay Now.

### Short codes

`*126#` (MTN) and `#150#` (Orange) appear in customer copy only once verified for Cameroon. Set `PAYMENT_SHORT_CODES=verified` on `ndahi-api` after checking them; until then `shortCodes` is `null`, and the expired message reads "Payment request expired. Tap Retry to send a new pop-up."

### Messages

The English and French strings for each state are in `shared-app/i18n/customer.js` (`payState…`), word for word from the brief and the canvas. `test/payment-states.test.mjs` checks them.

## Receipts

The paid payment contains an immutable receipt snapshot: receipt ID, paid date,
provider/reference, mobile-money network, package price, and allowances. Signed-in
owners open receipts in a dashboard dialog and download an actual PDF, including
after refund. Requests for another customer's receipt return 404. Historical
paid records get a receipt on retrieval or worker processing; unavailable
historical attributes are explicitly labeled rather than invented.

The receipt uses the same branded design as the voucher email (`lib/receipt.mjs`):
amount paid, package allowances, receipt number, billed-to name, payment method,
provider reference and total, with times in Africa/Douala. MTN Mobile Money and
Orange Money labels come from the recorded network, rather than the payment
processor. Old snapshots gain a network only when their saved payment records it;
records without that information display “Mobile Money.” Frozen amounts and
allowances are preserved.

The authenticated receipt endpoint returns `application/pdf` with an attachment
filename ending in `.pdf`. `?format=json` provides the same details for the dialog,
plus current refund status. Both responses use `Cache-Control: no-store`. PDF
generation (`lib/receipt-pdf.mjs`) runs outside the state transaction and loads
no external assets. Email keeps its HTML/plain-text body and attaches the same
PDF; fixed snapshot timestamps make attachment bytes stable across retries.
Embedded DejaVu Sans fonts preserve extended Latin names and supported Unicode.
Characters outside the font's coverage show `�` in the PDF; the dialog retains
the original text. Large historical references can continue onto additional pages.

Expired, failed and cancelled transactions offer no payment/refund checks or new
refund requests in the dashboard. Confirmed payments retain their receipts. Late
payment reconciliation continues automatically, and pending payments/refunds
retain their relevant status checks.

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
full-price renewal/switching only after expiry or data exhaustion, protection of
active allowances from customer replacement, no automatic proration, Daily eligibility, cancellation before
submission, and refund review. These rules are linked from checkout and Payment
history; the key cancellation rules also appear directly before payment. New
payment records include the displayed policy version.

Issue #132 supersedes early replacement: guest upgrades and authenticated
renew/switch cannot replace active access. Eligibility is rechecked at reservation,
before provider submission and at settlement. Conflicting received money remains
paid with a receipt and needs review. Explicit audited administrator replacement
remains separate. See [active subscription protection](active-subscription-protection.md).

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

## Gateway expiry and blocked-new-user repair (23 October 2026)

The prior guard combined live requests, paid activation reviews and refunds.
The latter could block a new customer indefinitely. It also added120 seconds
after approval expiry and mapped MeSomb EXPIRED to pending.

New purchase attempts read the previous live request's provider state before
rejecting them (four-second maximum, durable lease and one-second retry throttle).
Verified expired/failed/cancelled requests release the guard. Verification still
requires matching amount, currency, internal and provider references. When
returned, an explicit provider expiry timestamp shortens the saved deadline.
Same-key replay returns the same order; a new payment needs a new key.

Direct MeSomb collection is used here. Its installed SDK does not offer a collect
expiry/cancel parameter. Do not invent one or claim local closure cancels a
gateway prompt. With no provider expiry timestamp, the configured finite window
is the fallback; current gateway status is checked on retry. Late confirmation
remains accounted for and cannot replace a newer active bundle. Official
[collection/verification API](https://docs.mesomb.com/development/payment).

The conflict screen offers resume/check/sign-in/help instead of a generic
resubmission. No timer submits a charge. Paid activation review is displayed as
received money requiring review, while preserving that record and allowing
unrelated purchases. Only authenticated owners receive their request details;
anonymous conflicts expose a bounded retry interval and generic guidance.
Guest active-bundle errors no longer disclose usage/expiry. Canonical account
suspension is checked before reservation and fulfillment.

Exact automated/CI evidence belongs in the PR. Actual blocked customer records
have not been privately inspected or edited. No real charge, gateway cancellation,
merge, deployment or physical Mobile Money acceptance is implied by these tests.
