# Issue 253 — give a voucher to one customer

Implemented for a draft PR and owner review. Not merged, deployed or physically verified. Based on design dependency #265 (`docs/redesign-handoff`); the owner explicitly authorized the small server guard described below despite the issue’s original “No server change” constraint. Authentication, session, database schema and production defaults are unchanged.

Vouchers opens **For one customer** for owners/operators. Name/phone search uses the existing records API; the chosen account, bundle and Sold/Gift choice remain explicit. An active bundle disables submission until the operator confirms replacement. Customer detail's **Give a voucher (sold or gift)** opens this flow with confirmation unchecked. **Batch to print or sell** keeps the existing stock and thermal-print functions. Both58/80mm formats remain;58mm is default.

## Source/build evidence

References: `docs/redesign/screens/AdminVouchers.dc.html`, `AdminCustomerDetail.dc.html`.

| State | Native1280px comparison | Responsive390px build |
| --- | --- | --- |
| Search/matches | [compare](issue-253/initial-comparison-1280.png) | [phone](issue-253/initial-390.png) |
| No active bundle, Sold | [compare](issue-253/inactive-sold-comparison-1280.png) | [phone](issue-253/inactive-sold-390.png) |
| No active bundle, Gift | [compare](issue-253/inactive-gift-comparison-1280.png) | [phone](issue-253/inactive-gift-390.png) |
| Active, unconfirmed | [compare](issue-253/active-unconfirmed-comparison-1280.png) | [phone](issue-253/active-unconfirmed-390.png) |
| Active, confirmed Sold | [compare](issue-253/active-confirmed-comparison-1280.png) | [phone](issue-253/active-confirmed-390.png) |
| Active Gift, unconfirmed | [compare](issue-253/active-gift-unconfirmed-comparison-1280.png) | [phone](issue-253/active-gift-unconfirmed-390.png) |
| Active Gift, confirmed | [compare](issue-253/active-gift-confirmed-comparison-1280.png) | [phone](issue-253/active-gift-confirmed-390.png) |
| Gift receipt | [compare](issue-253/gift-success-comparison-1280.png) | [phone](issue-253/gift-success-390.png) |
| Sold replacement receipt | [compare](issue-253/sold-replacement-success-comparison-1280.png) | [phone](issue-253/sold-replacement-success-390.png) |
| Batch | [compare](issue-253/batch-comparison-1280.png) | [phone](issue-253/batch-390.png) |
| Batch ready | [compare](issue-253/batch-success-comparison-1280.png) | [phone](issue-253/batch-success-390.png) |
| Customer-detail entry | [compare](issue-253/customer-detail-comparison-1280.png) | [phone](issue-253/customer-detail-390.png) |

Focused readable comparisons: [replacement form](issue-253/active-unconfirmed-form-comparison.png), [receipt/actions](issue-253/gift-success-form-comparison.png). Additional truthful fallbacks: [unconfirmed creation result](issue-253/unknown-outcome-1280.png), [rejected stale replacement](issue-253/atomic-replacement-rejected-1280.png), [malformed-receipt fallback](issue-253/unexpected-replacement-1280.png), [French form](issue-253/french-inactive-390.png).

[Capture dimensions/manifest](issue-253/capture-manifest.json). Both sides are browser renders with deviceScaleFactor1,1280×900 viewport and full-page capture; neither side is scaled. Admin references have no phone variant;390px images check usability and overflow, not a shrunken desktop match. All accounts/transactions are synthetic and providers mocked. No live payment, email or router action was performed.

## Differences requiring owner visual acceptance

- Plan names, phone masks, amounts, validity, codes and counts are actual local API results rather than placeholders. Search starts empty; API results determine count/order. Unregistered-number reservation belongs to #254 and needs its backend. [Its comparison is explicitly blocked, not counted as implemented](issue-253/no-account-comparison-1280.png).
- Creation returns no email/notification-delivery outcome. The receipt confirms only the returned account/status/plan/Sold/Gift values. It does not promise an email. Replacement returns the ended voucher and queues disconnection; copy says queued and asks staff to check Devices for confirmation.
- The API has no batch identifiers, so the ready card reports the returned voucher count rather than inventing a batch reference. Existing custom-batch options, code disclosure, CSV/Close controls, record filters and Print/Revoke/classification remain available behind compact disclosures; voucher codes open Details. These controls extend the simpler reference. Recipient and Type columns are implemented using scoped existing reads. Name search in Recent vouchers is not offered because that endpoint searches codes/phones, whereas the customer picker does support names.
- The existing sidebar and other customer-support actions remain. Insights, outages and the other support redesigns have separate issues; this change adds the voucher entry, not those screens.
- Kit control/background tokens are retained. Expected data/evidence wording and the advanced controls cause some height/spacing differences. These are visible in the attached pairs and are not claimed to be pixel-identical.

## Replacement and retry limits

A fresh read detects a changed active bundle before submission and clears consent. A409 does the same, with no automatic retry. A pending flag blocks duplicate submissions. After an unknown mutation result the form stays locked, re-reads once, reports any newer recorded bundle, and offers Recent vouchers. It never assumes the request failed or blindly retries.

The individual v2 workflow now sends `expectedActiveVoucherId` with the exact confirmed voucher ID, or explicit `null` when no active voucher was shown. Inside the existing serialized write transaction, the server compares it with the current active voucher before adding any custom plan, voucher, replacement audit or router command. A mismatch returns409 `ACTIVE_BUNDLE_CHANGED` with the current bundle ornull. The form updates that evidence, clears confirmation and requires another explicit submission. Two concurrent requests with the same expectation can commit only once; PostgreSQL’s existing exclusive transaction advisory lock covers independent API/store instances.

This API extension was explicitly authorized by the owner on14Nov2026. The field is optional for compatibility: v1 and legacy callers that omit it retain their previous behavior. The individual v2 flow always supplies it, includingnull. There is still no idempotency key or durable browser request identity across reloads. Unknown outcomes therefore remain locked and direct staff to Recent vouchers; reload/retry is not guaranteed idempotent. Defensive receipt checks still warn and withhold printing if an inconsistent server response is received.

## Verification

- `npm run check` and explicit syntax checks for new files pass. CI now syntax-checks every admin-v2 module and browser regression; no dependency was added.
- `npm test`:1,302 passed,0 failed;43 PostgreSQL tests skipped locally without TEST_DATABASE_URL. CI supplies PostgreSQL separately.
- New browser regression:24 scenarios, including Sold/Gift accounting, explicit consent, A→B changes before and after the final read,409/reconfirmation, double submit, four inconsistent returned receipt fields,503 preflight and post-success refresh,400 rejection, lost committed reply, suspended customer, stale search, roles, French, keyboard, contrast, console and thermal print. No unexpected page/console/CSP errors in the new flow.
- Atomic API regression: concurrent replacement and concurrent first grant, changed/disappeared bundle, invalid expectations, no partial custom-plan/audit/router writes, and independent PostgreSQL store/API instances (the PostgreSQL cases run in CI). Existing legacy caller tests pass.
- Admin app:15 v1 and40 v2 journeys. Admin authorization and cash collected pass on both. Voucher details/thermal/QR journeys pass on both; reseller-ledger journeys pass on both. Fixed test ports can be overridden to avoid concurrent agents' fixtures.
- The registered customer/batch/customer-detail previews rendered6 source/build captures,0 blocked,0 failed. This is capture readiness, not owner visual approval.
- The console regression found old inline styles in the v2 thermal-slip renderer that its CSP rejected. Browser markup now uses its existing external thermal classes; email-mode inline styling remains. v1 is frozen for this v2-only issue and its renderer is unchanged. Both variants' print journeys are checked.
- [Claude Code review](issue-253/claude-review.md): four read-only reviews. The latest verified the guard, locking, explicitnull, legacy compatibility and client recovery; it found no P0/P1 code issue and two stale-wording P2s, both corrected in this update. Earlier P1/P2 implementation findings were addressed and regression-tested. It did not execute tests or grant visual acceptance.

## Success measure and checklist handoff

Staff median task time under30s must be measured with the five-person usability protocol in `docs/redesign/usability-test.md`: time from opening Vouchers to the receipt, record the chosen account/type and any mistaken replacement. The synthetic journey proves behavior, not staff task time. Production replacement reviews use the existing `voucher.admin_replaced` audit and support reports. No production sample or physical disconnect is claimed.

Peer-owned product checklist entry: “#253 individual existing-customer voucher flow implemented/tested, linked draft PR; Sold/Gift, atomic server guard for fresh replacement consent, honest receipts and thermal-only printing; owner visual acceptance, deployment and physical verification pending.” This entry is handed off without overwriting the other PC's checklist draft.
