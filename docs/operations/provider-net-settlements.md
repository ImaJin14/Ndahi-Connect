# Provider net settlements

The owner confirmed on 8 November 2026 that the dashboard amount must be **completed settlements after fees**, read directly from the gateway. A current account balance, successful collection total, local order sum or fixed fee estimate does not satisfy this requirement.

## Current implementation

`lib/provider-settlements.mjs` accepts provider settlement pages, includes only completed XAF settlements, validates pagination and unique records, and sums provider-reported `net_amount`. Incomplete provider coverage returns `amount: null` and Unavailable. Flutterwave implements the documented settlement endpoint. The current MeSomb adapter has no settlement history method; it intentionally cannot report a numeric settlement total.

The current report covers the configured provider account. It can include activity outside this platform when credentials are shared. Restricting the amount to NDAHI sales requires provider settlement-to-transaction allocation evidence; do not silently relabel the account total.

## MeSomb verification — 8 November 2026

Inspected the installed official `@hachther/mesomb` 3.0.2 SDK and the public OpenAPI schema linked from the official SDK repository:

- [Official API schema](https://mesomb.hachther.com/api/v1.1/schema/generator/?lang=en)
- [Official SDK](https://github.com/hachther/mesomb-js)
- [Fees and settlement definitions](https://docs.mesomb.com/introduction/fees-and-settlement)

The public schema lists `GET /api/v1.1/payment/status/` returning `PublicApplication`, including application balances. `GET /api/v1.1/payment/transactions/` requires `ids` and `source`; it is lookup of known transactions rather than complete settlement history. Neither this schema nor the installed PaymentOperation exposes a payment settlement-history resource. Wallet transaction search concerns a separate wallet product and does not establish payment application settlement history.

This is a verified limitation of the interfaces inspected, not a claim that MeSomb cannot provide a separate merchant reporting interface. No authenticated production request, real payment, withdrawal or account change was performed in this investigation.

## Request for MeSomb support

Please provide the supported **read-only settlement history/reporting API** for our payment application. We need completed settlement records after actual gateway fees and deductions, rather than current application balance or gross customer collections.

Please supply:

- API base URL/version, endpoint documentation, authentication and read permissions.
- Stable settlement ID, application identifier, currency, completed status and settlement timestamp.
- Gross amount, actual fees/deductions, net settled amount, and treatment of refunds, reversals and later adjustments.
- Date filters/timezone, complete pagination/cursors, history retention and rate limits.
- Transaction allocation if the provider account also contains non-NDAHI activity.
- Redacted response example and a sandbox fixture or reconciliation procedure against the merchant statement.

Do not share keys, tokens, withdrawal PINs or private statements in GitHub/chat. A dashboard statement/export can assist reconciliation, but a manual import alone would not satisfy the owner's direct gateway integration request.

## Completion criteria

Implement only the documented read-only interface; validate application/currency/status/net values, complete history and duplicates; exclude pending/reversed records according to the provider contract. On provider errors, missing deductions or incomplete history, retain Unavailable rather than estimate. Test redacted fixtures, authorization, pagination/conflicts and outage behavior, then reconcile a real statement privately before marking the amount provider-verified.

Track this blocker in [issue #191](https://github.com/ImaJin14/Ndahi-Connect/issues/191). Store receipts and collection fulfillment are separate from provider settlement reporting.
