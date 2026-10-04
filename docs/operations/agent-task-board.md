# Shared agent task board

Updated: 2026-10-05. Delivery status remains in the
[product improvement checklist](../product-improvement-checklist.md). An assignment
does not mark its acceptance criteria complete.

## Starting point

Use public main commit `78eacae7cdeb3be3ccc0e0d2b4427fb1d0739c75` for this round.
[PR #20](https://github.com/ImaJin14/Ndahi-Connect/pull/20) is merged and its CI passed.
It includes the reviewed receipt/expiry work from PRs #15–#19, private-key guest
status authorization, and restored checkout review after expiry.
The older working tree at the project root is preserved; do not use it as a base.

## Assignments

| Agent | First task | Branch | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| Codex | Coordinate this round, review agent changes, validate integration, and prepare the combined PR. | `chore/agent-delegation` | This board, checklist verification notes, integration changes agreed with the relevant owner. | Record actual dispatch/results, inspect every diff, run relevant checks, and publish reviewable changes. |
| Claude Code | **BILL-001:** apply expiry when a customer repeats the same checkout key after its approval window. | `claude/checkout-expiry-idempotency` | `lib/domain/purchases.mjs`, `test/payment-expiry.test.mjs` | Return the original payment ID as expired; submit no new charge or order; preserve late verified settlement and in-window idempotency. Add meaningful deadline/repeat-key regressions. |
| Google Antigravity | **A11Y-002/003/005:** review receipt and recovery keyboard operation, focus, zoom and reflow. | `antigravity/receipt-recovery-accessibility` | New `docs/operations/receipt-recovery-accessibility-review.md` | Give concrete findings with source locations; distinguish source inspection from browser evidence. Verify rendered behavior at 200%/400% zoom if browser access is available. Propose UI changes for a separate review. |
| GitHub Copilot | **TEST-001:** add focused guest and owner status-authorization browser journeys; **TEST-002** remains in its follow-up queue. | `copilot/status-browser-tests` | New `scripts/check-status-authorization-journeys.mjs`, new `docs/operations/status-authorization-browser-tests.md` | Missing/wrong/another payment's checkout key cannot reveal payment data or codes; correct guest key works; owner succeeds, another owner and expired sessions fail. Use local mock fixtures and include a narrow mobile layout. Document a repeatable command. |

Each task has its own worktree under `/tmp/ndahi-task-claude`,
`/tmp/ndahi-task-antigravity`, or `/tmp/ndahi-task-copilot`. Codex coordinates in
`/tmp/ndahi-agent-delegation`. Task branches are local working branches;
reviewed commits are integrated into the published `chore/agent-delegation` PR.

## Dispatch status

| Agent | Actual dispatch status |
| --- | --- |
| Codex | Reviewed and integrated the returned artifacts, corrected Copilot fixture assumptions, reproduced Google's focus finding in Chrome, and updated this board and checklist. |
| Claude Code | Delivered the same-key expiry fix and three regressions through the installed Claude Code CLI. Codex verified all 13 expiry tests and the integrated full suite. |
| GitHub Copilot | Delivered the status-authorization script and run documentation through the installed Copilot CLI. Codex corrected fixtures and verified the authorization matrix and paid guest/PIN/dashboard journey at 390px. [Run instructions](status-authorization-browser-tests.md). |
| Google Antigravity | Returned a partial source review through the installed Antigravity CLI before its 120-second print timeout. Codex verified expired-recovery focus loss in Chrome. [Reviewed finding and remaining scope](receipt-recovery-accessibility-review.md). Full keyboard/zoom audit and UI correction remain open. |

Integrated local verification on 2026-10-05: 320 automated tests passed with 12
PostgreSQL-dependent skips; all 15 existing billing browser scenarios and the new
status-authorization suite passed. Syntax and whitespace checks passed. No live
provider or production verification was performed.

## Follow-up queue

- Claude Code: **TEST-003** provider sandbox contracts after the idempotency fix.
  Clarify customer rechecking after `lateCheckUntil` before changing that policy.
- Google Antigravity: fix the confirmed expired-recovery focus destination after
  agreeing ownership of `customer-app/onboarding.js`, add close/Escape focus
  assertions, and finish **A11Y-002/003/005** keyboard and 200%/400% zoom checks.
  Continue **A11Y-004/006/007** separately.
- Copilot: extend customer/admin browser coverage to signed webhook integration,
  receipt authorization, recovery races, and receipt-email retries; agree package
  and CI workflow edits with Codex before changing shared configuration.
- Codex: review the next changes, reconcile checklist evidence, and prepare their PRs.

## Coordination rules

Stay within assigned files and branches; coordinate shared-file edits first.
Return changed files, validation commands/results, and unresolved findings to Codex.
Codex handles final commits and publication after review. Do not include private
settings, credentials, or nested `.claude` worktrees in a commit.
