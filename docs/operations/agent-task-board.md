# Agent task board

Updated: 2026-10-04. The [product improvement checklist](../product-improvement-checklist.md)
remains the source of truth for delivery status. Queued assignments below do not
change its checkboxes or claim completed implementation.

## Published work

Claude's receipt and checkout work is already on `main`, including subsequent integration
and PDF fixes. Preserve these merged changes when reviewing older local edits.

| PR | Result | Status |
| --- | --- | --- |
| [#15](https://github.com/ImaJin14/Ndahi-Connect/pull/15) | Branded receipts | Merged |
| [#16](https://github.com/ImaJin14/Ndahi-Connect/pull/16) | Checkout expiry and late settlement | Merged |
| [#17](https://github.com/ImaJin14/Ndahi-Connect/pull/17) | Expired saved-checkout recovery | Merged |
| [#18](https://github.com/ImaJin14/Ndahi-Connect/pull/18) | Integration into main | Merged |
| [#19](https://github.com/ImaJin14/Ndahi-Connect/pull/19) | PDF receipts and terminal billing actions | Merged |

## Current integration and reviews

Codex owns the active **BILL-001** follow-up: restore package allowances and payment
rules before restarting an expired guest checkout, preserve saved customer details,
and require the owner's session or private checkout key for payment-status access.
The status authorization fix addresses Claude Code's verified finding that a shared
receipt disclosed the identifier used to retrieve an activation code. Branch:
`fix/checkout-recovery-review`. Owned paths include the checkout UI, payment routes,
CORS middleware, focused regressions, and this board.

| Agent | Actual review of public main at `960c8da` | Result |
| --- | --- | --- |
| Codex | Billing, receipts, current branch history, and integration | Implemented checkout review and guest-status authorization fixes. Syntax/whitespace checks, 317 tests, and 15 local billing browser scenarios passed; 12 PostgreSQL-dependent tests skipped locally. |
| Claude Code | Read-only billing and webhook review | Completed. Guest status authorization finding verified and addressed by this PR. Other proposed findings require validation; the reconciliation mismatch already emits a review event. |
| Copilot | Read-only test coverage review | Completed; no correctness blockers reported. Follow-ups cover signed-webhook route integration, expiry boundaries, receipt authorization, recovery races, and receipt-email retries. |
| Antigravity | Read-only receipt, PDF, and onboarding review attempted | Incomplete: Google account eligibility retrieval timed out before source review. Accessibility review remains queued. |

## Queued assignments

These are separate proposed follow-ups, not implemented or completed. Each owner should
start from current `main` after the active recovery change merges and use its own branch.

| Owner | Task and acceptance | Proposed branch and owned paths |
| --- | --- | --- |
| Claude Code | **BILL-001** expiry/idempotency follow-up: review the same-key retry path, which currently returns before applying checkout expiry, and cover a retry after the deadline while preserving the original payment ID and avoiding a new charge. **TEST-003**: add meaningful MeSomb, Flutterwave, and Resend sandbox contract checks with reproducible results. | `claude/expiry-provider-contracts`; `lib/billing.mjs`, `lib/domain/purchases.mjs`, `test/payment-expiry.test.mjs`, new provider-contract tests and their run documentation. |
| Antigravity | **A11Y-002/003/005**: verify keyboard operation, focus after errors/recovery/dialog close, and receipt/recovery reflow at 200% and 400% zoom. Record evidence and concrete findings; propose any UI fixes separately. | `antigravity/receipt-recovery-accessibility`; new accessibility verification report under `docs/operations/`. Read customer receipt and recovery UI; do not edit Codex's active paths. |
| Copilot | **TEST-001/002**: automate customer and administrator browser journeys, including recovery, receipt ownership, refunds, and role restrictions. Cover desktop/mobile and meaningful behavior regressions, with a repeatable CI command. Include the completed review's webhook-route, deadline, authorization, recovery-race, and email-retry test gaps. | `copilot/customer-admin-browser-tests`; new browser suites and fixtures, browser-test configuration, and a dedicated CI workflow. Coordinate any shared package-script changes with Codex. |

Claude Code's review should also clarify whether manual payment verification should be
available after `lateCheckUntil`. The shared polling cutoff is a review question, not a
confirmed bug or an instruction to change the late-settlement policy.

Keep commits limited to the assigned work. Do not commit `.claude` settings or nested
worktrees. Coordinate changes to another owner's paths before editing them, and update
the source checklist only when its acceptance criteria have evidence.
