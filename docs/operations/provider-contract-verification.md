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

Record the commit, provider, test account designation, expected status and result
without credentials or customer data. Leave TEST-003 open until sandbox evidence
and the remaining charge/refund/webhook exercises have been recorded.
