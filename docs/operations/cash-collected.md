# Cash collected since November 2026

The owner requested displaying only cash generated from this month onward on 8 November 2026. The baseline is fixed at **1 November 2026, 00:00 Africa/Douala** (`2026-10-31T23:00:00Z`). It does not reset to December when the next month begins.

The admin headline is **Cash collected before fees**. It sums saved gateway-confirmed XAF internet and hardware payments whose `confirmedAt` falls between that baseline and the report time. Only real supported providers with a provider reference qualify; mock, pending/unconfirmed, older and future confirmations are excluded. Offline voucher sales, complimentary vouchers and order creation alone do not contribute.

Completed full refunds for the included payments are deducted. Pending/uncertain refunds remain collected until completion is confirmed. This is a collection-cohort total, not a period bank cash-flow statement: refunds of pre-November payments are outside the selected cohort. Current application flows support full refunds only; a future partial-refund feature must extend this report before release.

Provider references are deduplicated across internet and store records. Conflicting references, malformed confirmed financial evidence or numeric overflow withhold the total for review rather than show an incorrect figure. Historical records without a confirmation timestamp are not assumed to have been confirmed in November.

These are **saved gateway confirmations**, not a new direct gateway history fetch, a current gateway balance, business profit or completed net settlements after gateway fees. MeSomb net settlements remain a separate blocked integration tracked in #191. Existing financial records and settlement APIs remain intact.

Automated validation covers the Douala date boundary, confirmation versus creation time, fixed baseline across months, real/mock/pending records, hardware payments, completed/pending refunds, duplicate/conflicting references and malformed money/evidence. Actual live financial reconciliation remains a separate acceptance step.
