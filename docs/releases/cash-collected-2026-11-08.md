# Cash collection release — 8 November 2026

## Scope

Issue #198 replaces the unavailable settlement headline with cash collected before fees from 1 November 2026, 00:00 Africa/Douala onward. The baseline remains fixed in subsequent months. Saved gateway-confirmed XAF internet/store payments contribute; completed full refunds for that cohort are deducted. Pending/mock/older/future records and offline voucher/gift records do not contribute. Conflicting provider references or invalid confirmed financial evidence withhold the total rather than silently show a partial amount.

The UI labels the source and limitations explicitly. This does not implement MeSomb net-settlement history (#191), estimate gateway fees, or change gateway balances/payments. No database migration is required. Revert the application commit to roll back; do not restore an old database over newer payments.

## Peer review

The other PC handed off voucher printing after PR #197 merged at `0b29912` and verified deployment; its released dashboard file is integrated. That PC's older working copy still contains uncommitted catalogue-pricing/purchased-plan and related test drafts. They have not been handed off as a reviewed release commit, and are preserved. This release does not silently publish those draft prices. Store policies remain unpublished; checkout remains closed.

## Validation

- 27 targeted cash/API/settlement tests passed locally.
- Four integrated cash dashboard browser journeys passed at 320px/1280px for owner/reseller roles, including reload, source totals, removal of historical money summary and restricted financial access.
- Repository build/syntax and diff checks passed. Existing voucher-print browser regression is being verified before merge.
- No real charge/refund/withdrawal, private financial report fetch or physical-device acceptance performed.

## Deployment

Pending required hosted CI, merge, all Render service statuses and exact live API/frontend revision verification. Add final evidence after deployment.
