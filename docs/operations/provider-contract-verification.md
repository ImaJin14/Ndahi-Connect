# Provider contract verification (TEST-003)

## Offline evidence

`npm run check:providers` runs the actual Flutterwave, MeSomb and Resend adapters
against synthetic SDK/fetch fixtures. CI runs it on each change. It verifies
success/pending/failure mapping, ID and external-reference lookup, missing
transactions, amount/currency/reference mismatch detection, repeated reads,
stable email idempotency keys, and receipt PDF attachment shape. Network guards
prevent fixture tests from reaching real providers. Use
`npm run --silent check:providers -- --json` for structured results; outputs
contain check names, status and error categories, without raw
provider responses or customer data.

`test/provider-request-contracts.test.mjs` adds 25 offline checks for exact
charge/verification/refund requests, the installed MeSomb SDK's signing,
webhook parsing/signatures, Resend message kinds and byte-identical idempotent
retries, and the exercise runner's guards, timeouts, recordings and fetch cleanup.
The JSON fixtures in `test/provider-contracts/fixtures/` are synthetic examples
shaped from adapter/SDK behavior and provider documentation. They are not captured
sandbox responses and do not prove that a provider accepts the integration.

## Dedicated sandbox configuration

No provider sandbox execution has been performed for this change. To verify an
existing synthetic transaction, configure the GitHub `provider-sandbox`
environment and manually dispatch **Provider sandbox contracts**. The workflow
performs reads only; charge creation, refunds and webhook delivery still need
separate sandbox exercises. It fails if required keys are missing. Credentials
are dedicated `CONTRACT_*` secrets; remaining identifiers and expected fields
are environment variables. Do not reuse production credentials.

For Flutterwave, set `CONTRACT_FLW_SECRET_KEY` to a `FLWSECK_TEST-` test key and
set `CONTRACT_FLW_TRANSACTION_ID`, `CONTRACT_FLW_TX_REF`,
`CONTRACT_FLW_EXPECTED_AMOUNT`, `CONTRACT_FLW_EXPECTED_CURRENCY` and optionally
`CONTRACT_FLW_EXPECTED_STATUS`. The runner verifies the same transaction by ID
and [transaction reference](https://developer.flutterwave.com/reference/verify-transaction-with-tx_ref).
Choose a settled test transaction so its status is stable between repeated reads.

For MeSomb, first confirm the account is still in test mode in its dashboard.
Account verification can end test mode; the runner cannot independently establish
the account state ([test-mode documentation](https://docs.mesomb.com/development/test-mode)).
Set `CONTRACT_MESOMB_TEST_ACCOUNT_ACK=I_CONFIRM_MESOMB_TEST_MODE_ACCOUNT`,
`CONTRACT_MESOMB_APPLICATION_KEY`, `CONTRACT_MESOMB_ACCESS_KEY`,
`CONTRACT_MESOMB_SECRET_KEY`, `CONTRACT_MESOMB_TRANSACTION_REF`,
`CONTRACT_MESOMB_EXPECTED_AMOUNT`, `CONTRACT_MESOMB_EXPECTED_CURRENCY` and optionally
`CONTRACT_MESOMB_EXPECTED_STATUS`. Only a single SDK `EXTERNAL` lookup is allowed.
The adapter's normalized transaction reference comes from the requested ID;
this check does not independently prove that a provider payload echoed that ID.

For Resend, set a dedicated `CONTRACT_RESEND_API_KEY` with read access and
`CONTRACT_RESEND_EMAIL_ID` for a pre-existing synthetic test email. This retrieves
the [sent email](https://resend.com/docs/api-reference/emails/retrieve-email)
without sending another message.

Local invocation uses environment variables only; the script never loads `.env`:

```sh
npm run check:providers -- --sandbox --provider=flutterwave --json
npm run check:providers -- --sandbox --provider=mesomb --json
npm run check:providers -- --sandbox --provider=resend --json
```

## Optional Resend test send

The manual GitHub workflow never sends email. For an explicit local receipt-send
exercise, additionally configure `CONTRACT_RESEND_FROM` and pass
`--resend-test-send` with the Resend sandbox command. The runner permits only
`delivered@resend.dev`, with no CC/BCC, and retries the same synthetic receipt
idempotency key. Resend's test addresses simulate delivery and consume sending
quota ([test email documentation](https://resend.com/docs/dashboard/emails/send-test-emails)).
This does not establish delivery to real recipients or webhook delivery.

## Manually selected sandbox exercises

`npm run check:providers:exercise` is a separate local tool for fresh synthetic
charges and email sends. No workflow schedules or dispatches it. It requires an
explicit `--provider` selection; a selected provider with missing or unsafe
configuration fails the run. It refuses `NODE_ENV=production`, credentials that
match their production variables, redirects, unlisted hosts/endpoints, refund
writes and unexpected recipients. It never loads `.env`.

Writes additionally require `--allow-writes`. Without this flag, configured
Flutterwave and Resend exercises fail before contacting their providers. MeSomb
can perform application-status and transaction reads without the flag, but needs
the test-account acknowledgement even for reads.

- **Flutterwave:** set `CONTRACT_FLW_SECRET_KEY` to a dedicated `FLWSECK_TEST-`
  key. Optional `CONTRACT_FLW_PHONE`, `CONTRACT_FLW_NETWORK` (`mtn`/`orange`),
  `CONTRACT_FLW_AMOUNT` and `CONTRACT_FLW_EMAIL` customize the synthetic charge.
  Amounts must be positive safe integers; the email must use `example.com` or
  `example.test`. The runner creates a charge, verifies it by ID and reference,
  and checks unknown-reference handling. To read a pre-existing test refund,
  provide numeric `CONTRACT_FLW_REFUND_ID`, `CONTRACT_FLW_REFUND_TRANSACTION_ID`
  and `CONTRACT_FLW_REFUND_AMOUNT` together. It never creates a refund.
- **MeSomb:** provide the three dedicated keys and
  `CONTRACT_MESOMB_TEST_ACCOUNT_ACK=I_CONFIRM_MESOMB_TEST_MODE_ACCOUNT` after
  confirming account test mode. Optional `CONTRACT_MESOMB_TRANSACTION_REF` with
  `CONTRACT_MESOMB_EXPECTED_AMOUNT`, or `CONTRACT_MESOMB_REFUND_ID` with
  `CONTRACT_MESOMB_REFUND_AMOUNT`, enable single known-transaction reads.
  Collection also requires `CONTRACT_MESOMB_ALLOW_COLLECT=true`, `--allow-writes`
  and `CONTRACT_MESOMB_PAYER` chosen from the provider's
  [test-number scenarios](https://docs.mesomb.com/development/test-mode).
  The runner checks number format; it cannot establish account mode or whether
  the supplied number is a provider-approved test number. Optional
  `CONTRACT_MESOMB_NETWORK` and `CONTRACT_MESOMB_AMOUNT` select the service/amount.
  The collection is verified by external reference; refund creation is blocked.
- **Resend:** provide a dedicated `CONTRACT_RESEND_API_KEY` and
  `CONTRACT_RESEND_FROM`. The only recipient is `delivered@resend.dev`
  (`CONTRACT_RESEND_TO` may explicitly select the same address). The runner checks
  an identical retry, a changed-payload idempotency conflict, a receipt attachment,
  retrieval and an invalid key. Test sends consume provider quota.

```sh
npm run check:providers:exercise -- --provider=flutterwave --allow-writes
npm run check:providers:exercise -- --provider=mesomb
npm run check:providers:exercise -- --provider=mesomb --allow-writes
npm run check:providers:exercise -- --provider=resend --allow-writes --record=/tmp/ndahi-contract-evidence-new
```

These commands are instructions, not execution evidence. Optional `--record`
creates private files in a new output directory and refuses to overwrite existing
files. Recordings retain only known response enums/numeric amounts; identifiers,
free text and unknown fields are redacted. Console results contain check names,
status and safe failure categories, without raw provider messages. Review recordings
and replace identifiers with synthetic values before using them as fixtures.
Recording files use a per-check capture format and cannot directly replace the
named replay fixtures. Requests and response bodies are bounded; concurrent
exercise/read-only runs share fetch serialization and restore the original transport.

## Findings that need separate confirmation or a product decision

The offline webhook checks pin the adapter's existing Flutterwave HMAC scheme.
Flutterwave's [v3 webhook documentation](https://developer.flutterwave.com/docs/webhooks)
describes a plain `verif-hash` scheme, which this adapter rejects. Confirm the
actual test-account delivery/header scheme before deciding whether to add legacy
compatibility. Offline fixtures do not establish successful provider webhook delivery.

The [late-settlement review](late-settlement-recheck-review.md) documents the
existing verification cutoff and proposes a support re-verification path.
It changes no billing policy or settlement behavior.

Record the commit, provider, test account designation, expected status and result
without credentials or customer data. Leave TEST-003 open until sandbox evidence
and the remaining charge/refund/webhook exercises have been recorded.
