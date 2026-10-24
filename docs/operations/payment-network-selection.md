# Payment network suggestions (#140)

Checkout suggests the likely Mobile Money provider from the actual payer number.
It accepts a local nine-digit number or `+237`, `237`, `00237` and usual spaces,
parentheses or hyphens. The browser and API share the same normalizer. Arbitrary
letters or wrong country codes are not stripped into an apparently valid number.

## Numbering data and limits

The maintained verified subset comes from Cameroon's ART communication in the
[ITU Operational Bulletin 1063, 2014, Cameroon numbering plan, pages 6–12](https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.1063-2014-OAS-PDF-E.pdf):

| Number starts with | Suggested provider |
| --- | --- |
| 67, 650–654 | MTN Mobile Money |
| 69, 655–659 | Orange Money |
| Other valid prefixes, including 66/68 | Manual selection |

This is a conservative allocation-based suggestion, not a current carrier lookup
or proof of ownership. Do not infer all 68 numbers belong to one provider from an
unverified list. Add later allocations only with a regulator/operator source and
boundary tests. New, reassigned, ported or uncertain numbers remain usable through
the visible manual selector. The API validates the phone format and supported
provider; it does not reject a manual correction because it differs from a prefix.

## Checkout behavior

The suggestion never submits payment. An explicit manual choice is kept for that
normalized payer during the current page lifetime, including formatting changes
and closing/reopening the checkout. Changing to a different payer recomputes its
suggestion. Unknown prefixes require an explicit choice.

Account checkout uses `payerPhone`, rather than the account contact field. An
alternate number stays on that transaction and never changes the profile default.
The existing pending request is authoritative on resume: disabled fields retain
the original provider and number, even when a prefix would suggest differently.
Retries keep their original request key and backend idempotency rules.

The [MeSomb collect contract](https://docs.mesomb.com/development/payment) uses a
local-format payer, an explicit payment service and country/currency. Existing
MeSomb and Flutterwave service mapping, fees, confirmation, expiry, status checks
and fulfillment are unchanged. A suggestion is not confirmation that an account
has Mobile Money or that a payment succeeded.

## Verification and release

- `node --test test/payment-network.test.mjs` covers normalization, exact mapping
  boundaries, unknown prefixes, manual state, malicious provider/phone input,
  alternate payers and immutable retries with an isolated fake gateway.
- `npm run check:payment-network:browser` covers 320px/1280px checkout, manual
  corrections, successful/duplicate confirmation, lost responses, failed/replayed
  requests and account alternate payers.
- Existing billing/provider-contract and full CI suites remain required.

Implementation and synthetic tests do not establish a real gateway transaction or
production release. Verify those separately after approved deployment; do not
make test charges against a customer account.
