# Cash collected since November 2026

## Cash and settlements screen (#379, 25 November 2026)

The owner chose, on 25 November ([#379](https://github.com/ImaJin14/Ndahi-Connect/issues/379#issuecomment-7153994690)), to build the drawn screen from saved payments.

- **Periods:** Today, 7 days and Month replace the fixed total, for every figure on the screen.
  - Today starts at midnight in Douala.
  - 7 days starts at midnight six days before today.
  - Month starts on the 1st.
  - No period starts before the 1 November 2026 baseline below.
  - The screen opens on 7 days, and changing the period fetches `GET /api/admin/cash?period=today|week|month` (owners and operators).
- **Figures:**
  - internet payments, store purchases and completed refunds, on the basis below;
  - the cash resellers handed over in the period.
- **Net provider settlements, per network (MTN MoMo, Orange Money):** the network is the one saved on the payment, or else the one the payer's number suggests (`shared-app/cameroon-phone.js`).
  - **Confirmed collections:** the count of payments.
  - **Cash before fees:** what customers paid, which is the price plus the fee saved on the payment. That fee is MeSomb's reported fee (from 25 Nov), else the quoted one (from 19 Nov), else none.
  - **Fees:** those saved fees.
  - **Refunds:** completed refunds.
  - **Net to settle:** prices collected less refunds. Each row adds up: cash before fees − fees − refunds = net.
- **This is what MeSomb should pay into the bank, not a completed settlement read from MeSomb.** That still waits for #191 (`provider-net-settlements.md`).
- **The accountant's CSV:** the table for the chosen period, one row per network.

The fixed report below is unchanged. v1's dashboard and Admin home's "Revenue today" (from Douala midnight, #377) use it.

## Fixed report (8 November 2026)

The owner requested displaying only cash generated from this month onward on 8 November 2026. The baseline is fixed at **1 November 2026, 00:00 Africa/Douala** (`2026-10-31T23:00:00Z`). It does not reset to December when the next month begins.

The admin headline is **Cash collected before fees**. It sums saved gateway-confirmed XAF internet and hardware payments whose `confirmedAt` falls between that baseline and the report time. Only real supported providers with a provider reference qualify; mock, pending/unconfirmed, older and future confirmations are excluded. Offline voucher sales, complimentary vouchers and order creation alone do not contribute.

Completed full refunds for the included payments are deducted. Pending/uncertain refunds remain collected until completion is confirmed. This is a collection-cohort total, not a period bank cash-flow statement: refunds of pre-November payments are outside the selected cohort. Current application flows support full refunds only; a future partial-refund feature must extend this report before release.

Provider references are deduplicated across internet and store records. Conflicting references, malformed confirmed financial evidence or numeric overflow withhold the total for review rather than show an incorrect figure. Historical records without a confirmation timestamp are not assumed to have been confirmed in November.

These are **saved gateway confirmations**, not a new direct gateway history fetch, a current gateway balance, business profit or completed net settlements after gateway fees. MeSomb net settlements remain a separate blocked integration tracked in #191. Existing financial records and settlement APIs remain intact.

Automated validation covers the Douala date boundary, confirmation versus creation time, fixed baseline across months, real/mock/pending records, hardware payments, completed/pending refunds, duplicate/conflicting references and malformed money/evidence. Actual live financial reconciliation remains a separate acceptance step.
