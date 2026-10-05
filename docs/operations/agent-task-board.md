# Shared agent task board

Updated: 2026-10-05. Delivery status remains in the
[product improvement checklist](../product-improvement-checklist.md). Assignments
and prepared configuration do not establish completed acceptance criteria.

## Starting point

[PR #21](https://github.com/ImaJin14/Ndahi-Connect/pull/21) is merged at
`474d7e3ca673a81172431592a60221bea4e7eb99`. This round starts from that main
revision, with a clean root checkout on `feat/quality-staging-next-batch`.
The older superseded root drafts were discarded at the owner's request.

## Assignments and results

| Agent | Task | Branch | Owned files | Actual result |
| --- | --- | --- | --- | --- |
| Google Antigravity | A11Y-002/003 checkout recovery focus | `antigravity/checkout-focus-return` | `customer-app/onboarding.js` | Delivered through the installed Antigravity CLI. Restores a connected available opener/package/action after recovery; pending checkout returns to its payment control. Codex corrected visibility/selector handling and added Chrome regressions. |
| GitHub Copilot | TEST-001/002 browser CI and admin authorization | `copilot/browser-ci-coverage` | `package.json`, CI workflow, status/admin journey scripts, browser verification doc | Delivered through the installed Copilot CLI. Codex corrected the password selector, CSRF fixture, both admin viewports, failure screenshots, commands and lockfile. |
| Claude Code | TEST-003 provider contracts; BILL-001 review | `claude/provider-contracts` | Provider runners, request/response fixtures and tests, late-settlement review | Delivered the initial runner and seven follow-up draft files. Codex integrated the request/signature/refund/email checks, hardened manual exercise guards and recording redaction, and preserved the late-settlement proposal without changing policy. |
| Codex | Review/integration; DEP-001/003/004 staging and release preparation | `feat/quality-staging-next-batch` | Integration changes, billing browser regressions, lockfile, staging Blueprint, environment checks, smoke workflow, runbook, checklist and this board | Reviewed every returned diff and ran isolated local tests. Separate staging resources and environment checks are prepared; remote provisioning and rollback execution remain pending. |

External agents used separate worktrees under `/tmp/ndahi-task-antigravity`,
`/tmp/ndahi-task-copilot` and `/tmp/ndahi-task-claude`, containing public repository
source only. They were not given private environment files or deployment access.
Codex runs terminal/browser validation; Antigravity's headless command/browser
capability limitations are unchanged.

## Verification

On 2026-10-05 the integrated automated suite passes 360 tests with 12
PostgreSQL-dependent local skips. The provider runner passes offline fixtures;
11 original contract regressions cover adapter behavior, guards, redaction and cleanup.
Claude's follow-up adds 25 request/signature/refund/email and exercise-runner
regressions, including explicit write selection, body timeouts, recording privacy
and shared fetch serialization. All 25 pass locally, including in the integrated suite.
Four staging isolation/CLI/smoke-target regressions pass. Syntax, YAML and whitespace checks
pass. Actual browser coverage includes customer status recovery at 1440px/390px,
all four admin roles at 1440px/390px, and billing/refund/receipt/checkout focus
journeys (19 scenarios), including mobile screens and terminal saved-payment recovery.

See [browser CI verification](browser-ci-verification.md),
[provider contracts](provider-contract-verification.md) and
[staging/release procedures](staging-release-runbook.md). No remote staging,
provider sandbox, production deployment or rollback drill has been performed.

## Follow-up queue

- Finish the keyboard, screen-reader and 200%/400% zoom audits.
- Extend customer/admin browser coverage to the remaining checklist journeys.
- Configure dedicated provider test credentials, record read-only sandbox
  evidence, and run the prepared manual charge/email/optional collection exercises.
  Refund creation and actual webhook delivery evidence remain pending. Resolve the
  Flutterwave header scheme against a sandbox delivery before compatibility changes.
- Decide the BILL-001 late-settlement/support proposal in the
  [review](late-settlement-recheck-review.md) before implementing policy changes.
- Provision staging with isolated DNS, database, provider accounts and hardware;
  run migrations, strict smoke tests and a timed rollback/forward-fix drill.
- Implement centralized error tracking (OBS-003), then continue the remaining
  WISP, admin, localization, support and privacy features from the checklist.

## Coordination rules

Stay within assigned files and branches; coordinate shared-file edits first.
Codex reviews, validates, commits and publishes integration changes. Do not commit
private settings, credentials, environment files or nested Claude worktrees.
