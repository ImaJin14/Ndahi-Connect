# NDAHI Connect Product Improvement Checklist

Last reviewed: 2026-09-25

Use this document as the source of truth for product, engineering, security, and operational improvements. Mark a task complete only after its acceptance criteria have been verified.

## Status legend

- `[ ]` Not started
- `[-]` In progress
- `[x]` Complete
- `[!]` Blocked — add a short blocker note below the task

## Working rules

1. Reference the task ID in commits and pull requests.
2. Add implementation notes beneath the task when decisions affect future work.
3. Mark security, data, payment, and network tasks complete only after tests pass.
4. Mark production tasks complete only after deployment and production verification.
5. Update the review date whenever this checklist changes materially.
6. Update this tracker at the end of every improvement task with its status, verification results, remaining deployment steps, and revised totals.

## P0 — Launch safety and data protection

### Application security

- [x] **SEC-001 — Remove unsafe dynamic HTML rendering**
  - Replace untrusted `innerHTML` interpolation with DOM construction or escaped rendering.
  - Cover customer device labels, bundle names, API messages, customer data, voucher data, and administrator-controlled content.
  - Acceptance: stored HTML payloads render as text and automated injection tests pass.

- [x] **SEC-002 — Verify trusted proxy and client-IP handling**
  - Confirm Render's `X-Forwarded-For` behavior.
  - Accept forwarded addresses only from trusted proxies.
  - Acceptance: spoofed forwarding headers cannot bypass application rate limits.
  - Implementation: ignore `X-Forwarded-For`; deployments with `TRUST_PROXY=render` use Render/Cloudflare's overwritten `CF-Connecting-IP`, while other deployments use the socket peer address.

- [x] **SEC-003 — Add edge-level authentication rate limiting**
  - Cover customer PIN, voucher access, PIN reset, passkeys, TOTP, and administrator login.
  - Acceptance: limits work across multiple API instances and cannot be bypassed by restarting the application.
  - Implementation: durable pre-authentication counters are grouped into customer, PIN-reset, and administrator budgets and stored transactionally with the application state. Render defaults are configurable through `AUTH_EDGE_*` environment values.

- [x] **SEC-004 — Strengthen four-digit PIN protection**
  - Add progressive delay, account-level temporary lock, and security-event alerts.
  - Keep passkeys and authenticator login available as safer alternatives.
  - Acceptance: distributed and repeated guessing scenarios are tested.
  - Implementation: failed PIN attempts add 1, 2, 4, and 8-second account cooldowns, followed by a configurable 15-minute lock on the fifth failure. Lockouts emit high-severity security events; successful PIN resets or PIN sign-ins clear the failure state.

- [x] **SEC-005 — Complete CSRF coverage review**
  - Inventory every state-changing customer and administrator endpoint.
  - Confirm origin, CORS, cookie, and CSRF protections for each endpoint.
  - Acceptance: automated cross-origin negative tests cover every mutation class.
  - Inventory: [`docs/security/csrf-mutation-inventory.md`](security/csrf-mutation-inventory.md).

- [x] **SEC-006 — Harden browser security headers**
  - Add HSTS, `frame-ancestors`, Referrer-Policy, Permissions-Policy, and CSP reporting.
  - Acceptance: headers are verified on customer, administrator, and API production domains.
  - Implementation: customer and administrator pages use a restrictive CSP with first-party violation reporting; API responses use `default-src 'none'`. Production pages also enable one-year HSTS with subdomains and preload.

- [x] **SEC-007 — Establish secret rotation procedures**
  - Cover session secrets, peppers, payment credentials, email credentials, RouterOS, Omada, and administrator recovery secrets.
  - Acceptance: rotation runbook and non-destructive rotation test exist.
  - Runbook: [`docs/security/secret-rotation-runbook.md`](security/secret-rotation-runbook.md).

- [x] **SEC-008 — Run dependency and source security scanning in CI**
  - Add dependency auditing, secret scanning, and static analysis.
  - Acceptance: high-severity findings block deployment or require documented approval.
  - Policy: [`docs/security/ci-security-gates.md`](security/ci-security-gates.md).

- [!] **SEC-009 — Commission an external penetration test**
  - Include customer authentication, vouchers, payments, admin roles, APIs, and network-management bridges.
  - Acceptance: critical/high findings are resolved and retested.
  - Blocker: an independent assessor, testing window, named contacts, and explicit authorization must be selected by the product owner.
  - Prepared: [`penetration-test-brief.md`](security/penetration-test-brief.md) and [`penetration-test-findings.md`](security/penetration-test-findings.md).

### Data integrity and recovery

- [x] **DATA-001 — Normalize the PostgreSQL data model**
  - Replace the single JSONB state document with tables for customers, vouchers, payments, sessions, bundles, challenges, events, and audit logs.
  - Acceptance: schema has primary keys, foreign keys, indexes, unique constraints, and transactional migrations.
  - Implemented: normalized entity tables, relational constraints/indexes, transactional schema migration, and a compatibility store adapter.

- [x] **DATA-002 — Build a zero-loss migration from JSONB state**
  - Provide validation counts, relationship checks, rollback, and a migration rehearsal.
  - Acceptance: production-shaped test data migrates and reconciles successfully.
  - Implemented: transactional preflight/migration/reconciliation tooling and rollback runbook in [`docs/operations/normalized-state-migration-runbook.md`](operations/normalized-state-migration-runbook.md).

- [x] **DATA-003 — Define data retention and archival policies**
  - Cover sessions, challenges, security events, audit logs, payment records, and customer data.
  - Acceptance: scheduled cleanup/archive jobs and documented retention periods exist.
  - Implemented: daily transactional retention worker and [`docs/operations/data-retention-policy.md`](operations/data-retention-policy.md).
  - Extended (2026-09-25): AUTH-005's new security-alert delivery records are covered
    too (90 days online once in a terminal state, 2-year archive) so they don't grow
    unbounded; `test/retention.test.mjs` updated accordingly.

- [x] **DATA-004 — Automate encrypted PostgreSQL backups**
  - Configure frequency, retention, access control, and off-site protection.
  - Acceptance: backup status is monitored and failures alert operators.
  - Implemented: daily encrypted off-site Cloudflare R2 backup job and [`docs/operations/postgres-backup-runbook.md`](operations/postgres-backup-runbook.md).

- [!] **DATA-005 — Perform and document database restoration drills**
  - Define recovery point and recovery time targets.
  - Acceptance: a timed restore drill succeeds and the results are recorded.
  - Prepared: guarded restore tooling, RPO/RTO targets, validation, and drill record in [`docs/operations/postgres-restore-drill.md`](operations/postgres-restore-drill.md).
  - Blocker: requires a real encrypted DATA-004 backup, an isolated PostgreSQL target, and an authorized operator to run and record the timed drill.

### Payment and network consistency

- [x] **PAY-001 — Add automated payment reconciliation**
  - Compare local payments with MeSomb/Flutterwave provider status.
  - Acceptance: missing, duplicated, delayed, and mismatched payments are detected safely.
  - Implemented: scheduled provider verification, durable per-payment findings and worker leases, and an administrator reconciliation table. Detects missing settlements/provider records/vouchers, duplicate references/vouchers, delayed orders, mismatched details/status, and verification failures without changing financial state or issuing access.
  - Verified: 12 reconciliation tests, all 96 tests including the 300-user load test, and syntax checks passed on 2026-09-21. Deployment and live-provider verification are not yet performed.
  - Scope: reconciles existing local orders; provider-only transactions without a local order require provider export review. See [`payment-reconciliation.md`](operations/payment-reconciliation.md) for configuration, findings, and operator procedures.

- [x] **PAY-002 — Add webhook replay and dead-letter handling**
  - Preserve failed provider events for controlled retry.
  - Acceptance: retries are idempotent and cannot issue duplicate vouchers.
  - Implemented: authenticated MeSomb/Flutterwave events persist before processing; durable leases, bounded retries/backoff, dead-letter reasons, and owner/operator replay controls are available under Payments → Webhook recovery. Fulfillment and event completion commit atomically; unresolved events are excluded from retention cleanup.
  - Verified: 15 webhook recovery tests, all 111 tests including the 300-user load test, syntax checks, and diff checks passed on 2026-09-21. Covers duplicate/concurrent delivery, restarts, timeouts, fulfillment conflicts, refunds, CSRF, permissions, and replay audit entries. Deployment and live-provider verification are not yet performed.
  - Runbook: [`payment-webhook-recovery.md`](operations/payment-webhook-recovery.md).

- [x] **NET-001 — Add durable RouterOS command queues**
  - Queue voucher sync, disconnect, expiry, and usage operations outside request transactions.
  - Acceptance: commands survive process restarts and retry with bounded backoff.
  - Implemented: voucher sync/disconnect, device disconnect, inactive-session marking, and admin usage
    sync are recorded as durable commands (existing `events` table, `kind = 'router_command'`, no
    migration) and applied by a background worker outside any request or webhook transaction, so a slow
    or unreachable router can no longer hold the store's single write lock. Commands use lease-based
    crash recovery and exponential backoff capped at one hour, up to a bounded attempt limit
    (NET-003 adds dead-letter handling, alerting, and operator replay for commands that exhaust it).
    Resale voucher claim/redeem and admin usage sync still resolve synchronously by processing their
    one enqueued command inline, preserving prior response behavior.
  - Verified: 5 router-queue tests, all 122 tests including the 300-user load test, and syntax checks
    passed on 2026-09-21. Deployment and live-router verification are not yet performed.
  - Runbook: [`router-command-queue.md`](operations/router-command-queue.md).

- [x] **NET-002 — Add RouterOS reconciliation**
  - Regularly compare application vouchers/sessions with router state.
  - Acceptance: drift is reported and safely repaired.
  - Implemented: a periodic pass compares each voucher/session against a new `readState()` router-adapter
    contract (vouchers' enabled state, sessions' active state). A voucher active locally but missing on
    the router, or not active locally but still enabled on the router, is reported and repaired by
    enqueuing the matching NET-001 command; a session the router no longer reports is corrected locally
    with no network call needed. Entities with an in-flight repair are not re-reported. Router-only
    records with no local match are left for manual review rather than guessed at. Findings are visible
    on `GET /api/admin/dashboard` and in the admin dashboard under Connections.
  - Verified: 8 reconciliation tests, all 130 tests including the 300-user load test, and syntax checks
    passed on 2026-09-21. Deployment, live-router `readState()` support, and live-provider verification
    are not yet performed.
  - Runbook: [`router-reconciliation.md`](operations/router-reconciliation.md).

- [x] **NET-003 — Add network-operation dead-letter handling**
  - Record permanently failed commands with reason, attempts, and operator actions.
  - Acceptance: unresolved failures are visible in the admin dashboard and alerting system.
  - Implemented: a command dead-letters after a bounded attempt limit (`NETWORK_QUEUE_MAX_ATTEMPTS`,
    default 8, ~1 hour of retrying) or an unretryable failure (a `sync_voucher` for a voucher that no
    longer exists), recording reason, attempts, and timestamp; the affected voucher's `routerSyncStatus`
    reflects it too. A single fire-and-forget Slack-compatible webhook alert (`NETWORK_ALERT_WEBHOOK_URL`,
    same convention as the existing backup-failure alert) fires on the transition, never on repeat polls.
    Findings are visible on `GET /api/admin/dashboard` and under Connections → Network commands, with an
    owner/operator **Replay** action (`POST /api/admin/network/commands/replay`, same auth/CSRF/audit
    controls as webhook replay). Reconciliation (NET-002) leaves dead-lettered commands alone rather than
    silently resetting them, so the attempt history and one-time alert are not suppressed.
  - Verified: 10 router-queue tests (dead-letter transition, alert dispatch and failure isolation,
    replay validation, HTTP role/CSRF/audit) plus a reconciliation regression test, all 136 tests
    including the 300-user load test, and syntax checks passed on 2026-09-21. Deployment, a configured
    live alert webhook, and live-router verification are not yet performed.
  - Runbook: [`router-command-dead-letter.md`](operations/router-command-dead-letter.md).

## P1 — Reliability, operations, and customer-critical UX

### Customer dashboard and device access

- [x] **UX-001 — Reorder the dashboard around active service status**
  - Show remaining data, remaining time, plan, and connection state before device activation.
  - Acceptance: the primary account status is visible in the first viewport on desktop and mobile.
  - Implemented: the account status grid (active bundle, connected devices, manage plan, account
    security, history) now renders immediately after the welcome banner; the device-activation form
    moved below it in DOM order (source order, not just CSS order, so screen readers and sighted users
    see the same sequence). The header's connection-state indicator, previously `display:none` below
    620px, is now visible on mobile too so connection state is present in the first viewport there as
    well as desktop.
  - Verified: `npm test` (131/131) and `npm run check` passed on 2026-09-21, including a new regression
    test asserting `#dashboard` precedes `#activateDevice` in DOM order. No in-browser/visual
    verification was performed in this environment (headless, no browser tooling available) — the
    ordering is verified structurally, not by screenshot.

- [x] **UX-002 — Simplify authenticated device activation**
  - Do not ask signed-in customers to re-enter their phone number and voucher code.
  - Use the authenticated account and active voucher automatically.
  - Acceptance: connecting the current device requires at most a device name and one confirmation action.
  - Implemented: a new authenticated `POST /api/account/devices/connect` endpoint resolves the caller's
    active voucher from their session (no phone/code in the request). The dashboard's "Connected
    devices" card shows a one-field (device name, prefilled), one-button quick-connect form when this
    browser isn't already an active session and a slot is free; reconnecting the same device is
    idempotent rather than consuming a new slot. The original phone+code form is retained as a
    collapsed "Activate a different voucher code" disclosure (open by default only when the customer
    has no active bundle, since it's then the only way to activate one) for claiming a separate voucher.
  - Verified: 2 new integration tests (device limit enforcement, idempotent reconnect, no-active-bundle
    message) plus the existing CSRF-inventory exact-match test updated for the new route; `npm test`
    (133/133) and `npm run check` passed on 2026-09-21. No in-browser verification performed.

- [x] **UX-003 — Consolidate plan-management navigation**
  - Group browse, renew, and switch actions under one clear “Manage plan” area.
  - Acceptance: customers can identify the correct plan action without duplicate competing buttons.
  - Implemented: removed the welcome banner's "Browse packages" button and the JS-injected "Switch
    plan" button that duplicated `#managePlan`'s actions. `#managePlan` is now the sole plan-navigation
    area: a customer with a current plan sees Renew (or a discontinued notice) and Change/switch plan;
    a customer with none sees Browse packages. No page has more than one plan-navigation entry point.
  - Verified: 1 new regression test (no button in `.welcome`, exactly the three `onboarding.html` links
    all inside `#managePlan`) plus existing suite; `npm test` (134/134) and `npm run check` passed on
    2026-09-21. No in-browser verification performed.

- [x] **UX-004 — Make network status truthful and live**
  - Drive visible status from service/network health rather than static text.
  - Acceptance: online, degraded, offline, maintenance, and unavailable states are supported.
  - Comparison (2026-09-21): local and live public screens match, but both display “Network online” while the live API reports bootstrap mode and unavailable network provisioning. Prioritize this task next; the observation does not establish a physical outage. Fresh screenshots, runtime evidence, and remaining verification limits: [local/live comparison](reviews/local-live-2026-09-21/report.md). No implementation status changed by this review.
  - Implemented: `GET /api/status` (public) and `GET /api/account/dashboard` (authenticated) now report
    the real `zone.status` instead of a hardcoded `"online"`/`"Network online"` string. A shared
    `customer-app/network-status.js` module renders online/degraded/offline/maintenance with distinct
    labels and dot colors, and falls back to "unavailable" when the status can't be determined (fetch
    failure, or an unrecognized value). Wired on every customer-facing page that claimed a live status:
    the dashboard header (from the authenticated payload it already loads), and the login and onboarding
    pages (via `/api/status`, fetched on load since those pages have no session yet). Static HTML now
    shows a neutral "Checking status…" until the real value loads, instead of a false claim.
  - Verified: 2 new tests (server reflects zone status changes across both endpoints; no page hardcodes
    an online claim and all wire up the fetch) plus existing suite; `npm test` (136/136) and
    `npm run check` passed on 2026-09-21. No in-browser verification performed.

- [x] **UX-005 — Improve empty and first-use states**
  - Cover no active bundle, no connected devices, pending voucher, exhausted bundle, and failed provisioning.
  - Acceptance: every state explains what happened and gives one clear next action.
  - Implemented (all client-side; the data these states need — payment status, voucher status,
    `routerSyncStatus` — was already present in the dashboard response): the "Active bundle" card
    distinguishes never-purchased, pending-payment ("being confirmed"), exhausted, and expired states
    with copy explaining what happened, deferring to the single Renew/Switch/Browse action already
    consolidated in `#managePlan` (UX-003) rather than adding a second competing button. A voucher
    stuck mid-provisioning (`routerSyncStatus: "pending"`/`"dead_letter"`) shows an inline notice.
    "No connected devices" is distinguished from "no bundle to connect one to", and the UX-002
    quick-connect form is itself the one clear action for the former.
  - Verified: 1 new regression test locking in all eight distinct message branches, plus 1 integration
    test confirming the dashboard surfaces exhausted-bundle and pending-renewal-payment data correctly;
    `npm test` (138/138) and `npm run check` passed on 2026-09-21. No in-browser verification performed.

### Renewal and switching

- [x] **UX-006 — Create a compact authenticated renewal experience**
  - Remove the acquisition hero from focused renewal tasks.
  - Show current plan, renewal date, price, eligibility, and confirmation.
  - Acceptance: renewal uses only the current eligible plan and keeps the session active.
  - Implemented: `/onboarding.html?action=renew` hides the acquisition hero and shows only the
    customer's current plan (status, expiry, price) plus a single card for that same plan, filtered
    from the catalogue by `renewalEligibility()` (`customer-app/plan-presentation.js`). Ineligible
    renewals (discontinued plan, Daily's 7-day cooldown) show the reason and next eligible time
    instead of a purchasable card. `POST /api/account/plan/purchase` re-validates eligibility
    server-side and is idempotent per `requestKey`. The new `GET /api/account/payments/:id/status`
    route (owner-checked, 404 for any other customer's payment) replaces public polling for
    authenticated flows and refreshes the customer's dashboard session on every poll, so renewal
    confirmation never drops the session.
  - Verified: `npm test` (166/166) and `npm run check` passed on 2026-09-23, including dedicated
    integration coverage for renewal eligibility (current, discontinued, no-plan), Daily cooldown
    down to the exact eligible timestamp, session persistence through polling, and payment-status
    ownership (401 unauthenticated, 404 for another customer's payment). Manually exercised the full
    purchase → confirm → PIN setup → authenticated renew → poll → confirm cycle against a locally
    running API and customer app; the dashboard reflected the renewed plan and the session cookie was
    unchanged throughout. Subsequent rendered browser checks on 2026-09-23 verified renewal,
    failed-payment retry, closed-page confirmation, and authenticated polling with a real browser
    cookie jar; see the [verification runbook](operations/renewal-switching-verification.md).

- [x] **UX-007 — Create a comparative switching experience**
  - Show the current plan beside each alternative.
  - Acceptance: differences in price, data, validity, and device limits are explicit.
  - Implemented: `/onboarding.html?action=switch` renders every non-current, non-discontinued plan as
    a table (`comparePlans()` in `customer-app/plan-presentation.js`) with the current and proposed
    values side by side for package price, data, validity, and simultaneous devices, plus a plain-text
    delta per row (e.g. "500 FCFA more", "2 days shorter"). The same comparison renders again in the
    checkout modal before payment. Unlimited-data comparisons are described in words rather than a
    numeric delta.
  - Verified: `npm test` (166/166) and `npm run check` passed on 2026-09-23, including
    `plan-presentation.test.mjs` unit coverage of `comparePlans()` (price/data/validity/device deltas,
    both-unlimited and unlimited-either-side cases) and integration coverage confirming switching
    charges the full destination-plan price and keeps the session across the flow. Manually verified a
    live switch (weekly → monthly) via the running API: payment created with `action: "switch"` and
    `replaceVoucherId` set, dashboard's `currentPlan.planId` updated to the new plan only after
    payment confirmation. Subsequent rendered browser checks verified the full switch checkout,
    comparisons, and session preservation on desktop and mobile (2026-09-23).

- [x] **UX-008 — Label upgrade, downgrade, and lateral changes**
  - Explain when the existing package ends and the new package begins.
  - Acceptance: consequences are visible before checkout.
  - Implemented: each switch candidate is labeled "Upgrade — higher package price", "Downgrade —
    lower package price", or "Lateral change — same package price" via `classifyPlanChange()`
    (price-based, not an assumed allowance improvement). A policy line on every plan card and in the
    checkout modal states, before payment, that the current package ends immediately on confirmation
    with no proration or carried-over data/time, and that the full destination price is charged. The
    checkout acknowledgement checkbox requires the customer to confirm this before submitting.
  - Verified: `npm test` (166/166) and `npm run check` passed on 2026-09-23, including unit coverage
    of `classifyPlanChange()`'s three outcomes and the undefined-price fallback. Rendered browser
    checks subsequently verified the policy disclosure, required acknowledgement, and a custom
    same-price lateral change (2026-09-23).

- [x] **UX-009 — Add a clear horizontal-scroll affordance or responsive alternative**
  - Avoid hidden package cards on desktop, mobile, and high zoom.
  - Acceptance: all packages are discoverable by pointer, keyboard, touch, and screen reader.
  - Implemented: wrapping grids replace the horizontal package rail. Comparison tables remain
    within each package, with named articles, table captions, row/column headers, and described
    buttons. Checkout contains keyboard focus and restores it when closed.
  - Verified: browser checks at 1440px, 390px, and 320px confirmed no horizontal page/control
    overflow, access to the last package, keyboard focus behavior, touch selection, and accessible
    table/article names. Desktop/mobile screenshots were inspected. The 320px check covers
    narrow/high-zoom reflow equivalence; a hardware screen-reader audit remains separate.

- [x] **UX-010 — Keep package comparisons clear and concise**
  - Show package price, included data, validity, and device limits clearly.
  - Acceptance: customers can compare package totals and allowances, with explicit differences
    between their current plan and each switching alternative.
  - Product decision (2026-09-23): per-GB/per-day rates and their explanatory text were removed
    at the owner's request. Packages show the total price and included allowances; switching
    retains explicit differences in price, data, validity, and devices. Prices are unchanged.
  - Copy decision (2026-09-23): remove the generic "One-time package" and "Available once every
    7 days" badges and the "across full validity" suffix. Keep renewal and upgrade/downgrade/lateral
    labels where relevant. The Daily seven-day purchase restriction remains an enforced rule,
    explained in eligibility and checkout details rather than a promotional badge.
  - Verified: comparison tests cover price/data/validity/device differences, unlimited allowances,
    and custom durations. The final PR checkout, including the copy and rate-display removals,
    passed all 166 automated tests, 13 browser scenarios, syntax checks, and the whitespace check
    on 2026-09-23. Browser coverage includes a 36-hour package. Commands and remaining billing
    scope are documented in the
    [verification runbook](operations/renewal-switching-verification.md).

### Billing experience

- [x] **BILL-001 — Add pending-payment recovery**
  - Let customers safely resume or recheck an interrupted payment.
  - Acceptance: refresh, closed tabs, and temporary provider failures do not create duplicate charges.
  - Implemented: durable reservations and a single unresolved checkout per customer; provider calls
    run after commit. Lost responses resume the same order. Dashboard rechecks and saved guest
    checkout survive refresh/tab closure; uncertain provider outcomes never create an automatic retry.
  - Verified (2026-09-25): concurrent-key, lost-response, storage-failure, restart, timeout and
    provider-verification tests, plus guest/account browser recovery. See the [billing runbook](operations/billing-experience.md).

- [x] **BILL-002 — Add customer receipts**
  - Provide downloadable and emailed receipts with provider reference and package details.
  - Acceptance: every paid transaction has a retrievable receipt.
  - Implemented: immutable package/payment receipt snapshots, authenticated HTML downloads
    (printable to PDF), emailed receipts and delivery retries, including historical paid records.
  - Verified: ownership isolation, historical availability, snapshot stability, HTML escaping,
    email failure/retry/idempotency, and rendered download/email actions.

- [x] **BILL-003 — Expose refund status clearly**
  - Show requested, pending, completed, and failed refund states.
  - Acceptance: customers and administrators see consistent provider-backed status.
  - Implemented: customer requests, owner/operator approval, durable once-only provider submission,
    separate refund references, and manual/background verification. Flutterwave initiation is kept
    pending until payout; provider failures remain visible. Confirmed refunds revoke only associated
    active access. Unknown submissions and historical pending refunds cannot be sent twice.
  - Verified: all four states, repeated approval, response-loss recovery, matching dashboard status,
    provider status mapping, and preservation of newer packages. Live-provider payout verification
    remains an operational check.

- [x] **BILL-004 — Document switching, renewal, cancellation, and proration rules**
  - Acceptance: rules appear before payment and in customer-facing terms.
  - Implemented: checkout disclosure and [billing rules](../customer-app/billing-terms.html) cover
    prepaid/manual renewal, full-price immediate replacement, no carryover or automatic proration,
    cancellation boundaries, pending-payment recovery, and refund review/status.
  - Verification for BILL-001–004 (2026-09-25): 182 automated tests, 8 billing browser scenarios,
    13 renewal/switching regression scenarios, syntax and whitespace checks passed. Screenshots
    inspected at desktop, 390px and 320px. [Commands and deployment limits](operations/billing-experience.md).

### Authentication and account controls

- [x] **AUTH-001 — Add customer session and device history**
  - Show recent logins, active browser sessions, and enrolled security methods.
  - Acceptance: customers can identify unfamiliar activity.
  - Implemented: `GET /api/account/security` returns every active `dashboardSessions`
    entry for the caller (creation time, last-seen time, IP, user agent, and which one
    is the current browser), the last 20 recognized login events (PIN, authenticator,
    passkey, recovery code, voucher activation) from the existing security-event log,
    and enrolled methods (PIN, authenticator, passkey list with labels, unused
    recovery-code count). Session records gained `id`/`createdAt`/`lastSeenAt`/`ip`/
    `userAgent` fields at issuance (all three login paths now route through one
    `issueCustomerSession()`); existing sessions age out within `CUSTOMER_SESSION_SECONDS`
    as before, so no migration is needed. Rendered under a "Sessions & activity"
    disclosure on the dashboard.

- [x] **AUTH-002 — Add "Log out everywhere"**
  - Acceptance: all customer sessions are invalidated immediately and audited.
  - Implemented: `POST /api/account/security/logout-everywhere` removes every
    `dashboardSessions` row for the caller's customer ID, including the one making the
    request, and logs a high-severity `customer.sessions.revoked_all` security event
    with the count revoked. A companion `POST /api/account/security/sessions/revoke`
    lets a customer sign out one specific session (e.g. an unfamiliar device from
    AUTH-001) without touching the others; revoking the current one also logs it out.
    Ownership is checked server-side (`customerId` match); a 404 is returned for
    another customer's session ID.

- [x] **AUTH-003 — Add passkey naming and removal**
  - Acceptance: customers can distinguish and revoke enrolled passkeys safely.
  - Implemented: new passkeys default to `Passkey N` or an optional customer-supplied
    label at enrollment; `POST /api/account/passkeys/rename` and `.../passkeys/remove`
    let an owner rename or delete an enrolled credential (404 for another customer's
    or an unknown passkey ID). Removal queues an AUTH-005 security alert. PIN sign-in
    always remains available, so removing every passkey cannot lock an account out.

- [x] **AUTH-004 — Add authenticator recovery codes**
  - Store only hashed recovery codes and make each single-use.
  - Acceptance: regeneration invalidates previous unused codes.
  - Implemented: `POST /api/account/security/recovery-codes/generate` (requires
    authenticator 2FA already enabled) returns ten `XXXX-XXXX` codes once; only their
    HMAC-SHA256 hash (existing `hashSecret`/`SECRET_PEPPER`) is stored, replacing any
    prior batch outright so old codes stop matching immediately. `POST
    /api/account/login/verify-authenticator` accepts a `recoveryCode` as an alternative
    to the six-digit `otp`; a match marks that one code `usedAt` (single-use) and signs
    in normally. An administrator's authenticator reset (`/api/admin/customers/reset-authenticator`)
    now also clears `recoveryCodes`, so a stale code can't resurface if the customer
    later re-enrolls TOTP — a gap fixed while wiring this up.
  - Verification note: recovery codes require normalizing the customer's typed input
    back to the stored `XXXX-XXXX` shape before hashing/comparing (mirrors
    `normalizeActivationCode` for vouchers) — a hyphen-stripping-only normalizer was
    tried first and failed a round-trip test before this fix.

- [x] **AUTH-005 — Add security notifications**
  - Notify customers about PIN resets, new passkeys, authenticator changes, and suspicious login activity.
  - Acceptance: notifications contain no secrets and delivery failures are tracked.
  - Implemented: a new durable outbox (`lib/security-alerts.mjs`, stored in the existing
    `events` table as `kind = 'security_alert'`, no migration) queues an alert inside
    the same transaction as the triggering change and delivers it on its own 30-second
    worker (`SECURITY_ALERTS_ENABLED`, mirrors the billing worker's claim/send/retry
    shape) so a slow or failing email provider never blocks the request. Triggers: PIN
    reset completed, PIN sign-in locked after repeated failures, authenticator 2FA
    enabled, a passkey added or removed, and a recovery-code sign-in. Failed deliveries
    retry with capped exponential backoff and move to `failed` after 8 attempts;
    skipped (no account email) and failed states are recorded with a reason. Alert
    bodies describe the event only ("Your PIN was reset") and never include PIN
    digits, codes, or secrets.
  - Verified (2026-09-25): 197/197 tests (`test/security-alerts.test.mjs` for the
    worker's delivery/retry/skip behavior and no-secrets-in-payload check;
    `test/auth-account.test.mjs` for all five AUTH routes, ownership checks, the
    recovery-code login/regeneration/admin-reset paths, and that each trigger queues
    its alert) and `npm run check` passed. 4 browser scenarios in
    `scripts/check-security-journeys.mjs` (session list/cross-device sign-out,
    passkey rename/remove, recovery-code generation through a real
    `/verify.html` sign-in, log out everywhere) passed headless against a real
    Chrome build; `sessions-desktop.png` screenshot inspected. Live email delivery
    of security alerts is not yet verified against a deployed provider.

## P1 — Production engineering

### Architecture and performance

- [ ] **ARCH-001 — Split the API into domain modules**
  - Separate HTTP utilities, customer auth, admin auth, vouchers, payments, bundles, network operations, and reporting.
  - Acceptance: `server.mjs` becomes composition/routing rather than the full application.

- [ ] **ARCH-002 — Introduce a service/repository boundary**
  - Keep business rules independent from PostgreSQL and HTTP response handling.
  - Acceptance: core workflows are unit-testable without starting a server.

- [ ] **PERF-001 — Establish production performance targets**
  - Define latency and throughput objectives for login, dashboard, payment creation, voucher redemption, and admin operations.
  - Acceptance: dashboards and alerts measure each target.

- [ ] **PERF-002 — Replace global write serialization**
  - Use targeted row locking and transactions after normalization.
  - Acceptance: unrelated customer operations execute concurrently.

- [ ] **PERF-003 — Add pagination and server-side filtering**
  - Cover customers, vouchers, payments, sessions, events, and audit logs.
  - Acceptance: admin pages remain responsive with production-scale datasets.

- [ ] **PERF-004 — Optimize and cache static assets**
  - Add compression, immutable asset caching, versioned filenames, and image optimization.
  - Acceptance: repeat visits avoid unnecessary transfers and stale deployments.

- [ ] **PERF-005 — Measure Core Web Vitals on mobile networks**
  - Acceptance: agreed LCP, CLS, and INP targets are monitored in production.

### Observability

- [ ] **OBS-001 — Add structured application logging**
  - Include severity, service, event, request ID, and safe identifiers.
  - Acceptance: secrets, PINs, vouchers, and personal data are excluded.

- [ ] **OBS-002 — Add request correlation IDs**
  - Propagate IDs across API, payment, email, and network adapters.
  - Acceptance: one customer operation can be traced end to end.

- [ ] **OBS-003 — Add centralized error tracking**
  - Acceptance: frontend and backend failures are grouped, alerted, and linked to releases.

- [ ] **OBS-004 — Add service dashboards and alerts**
  - Monitor API health, database, payments, email, RouterOS, Omada, authentication, and queue backlogs.
  - Acceptance: warning and critical thresholds have named responders.

- [ ] **OBS-005 — Define service-level objectives**
  - Cover portal availability, payment completion, voucher provisioning, and network enforcement.
  - Acceptance: objectives and error budgets are reviewed regularly.

### Deployment safety

- [ ] **DEP-001 — Introduce a production-like staging environment**
  - Acceptance: migrations, provider sandboxes, and critical flows are tested before production.

- [-] **DEP-002 — Add database migration gates**
  - Acceptance: incompatible application versions cannot deploy before required migrations.
  - Prepared (2026-09-21): read-only `npm run check:database` checks connectivity, required normalized tables, and SELECT access. The Render API Blueprint runs it as a pre-deploy command. Missing tables fail early with their names; no automatic data migration is performed. Full schema-version compatibility and production verification remain pending.
  - PR #6 integration verification: merged main `0ae49d6`, preserving UX-001–005 and deployment checks; all 149 tests, syntax checks, and diff checks passed.
  - Confirmed incident cause: the Render Shell connects to PostgreSQL but reports `customers`, `payments`, `vouchers`, `events`, `audit_logs`, and `app_settings` absent. Its running commit is `b29b289`, so the earlier missing `healthCheck()` method came from the old instance. Prepared a Node-based `npm run migrate:postgres` runner to apply schema migrations and the existing guarded legacy-data conversion without relying on `psql`. All 141 local tests and syntax checks pass. Production migration requires the documented backup/write-pause procedure and remains outstanding.

- [ ] **DEP-003 — Add post-deployment smoke tests**
  - Cover health, plans, customer login, admin login entry, CORS, and provider configuration.
  - Acceptance: failed smoke tests stop or roll back a release.
  - Deployment-timeout remediation (2026-09-21): readiness now uses a dedicated, bounded PostgreSQL schema/connectivity probe instead of loading or rewriting application state. Both bootstrap and operational health routes return `503` within four seconds on failure. Node is constrained to `22.x`, matching CI, instead of the open-ended `>=20` range that selected Node 26 in the supplied Render log.
  - Confirmed evidence (2026-09-21): Render deployed `9542aa5` on Node 22 but still timed out. A Render Shell probe confirmed database connectivity and missing normalized tables; the Shell was on old commit `b29b289`. Missing schema is the confirmed blocker, not the Node version or physical router.
  - Verification: all 141 local tests, syntax checks, and diff checks pass. Safe database failure codes/hints and a read-only pre-deploy gate are prepared. Production migration, redeployment, and smoke-test automation remain outstanding. See [API deployment readiness](operations/api-deployment-readiness.md).

- [ ] **DEP-004 — Add automatic rollback procedures**
  - Acceptance: application rollback and database forward-fix procedures are documented and rehearsed.

- [ ] **DEP-005 — Add environment-drift validation**
  - Reconcile Render Blueprint defaults with live environment settings.
  - Acceptance: unexpected `BOOTSTRAP_MODE`, mock adapters, URLs, and missing secrets are detected before deployment.

- [ ] **DEP-006 — Document incident response and ownership**
  - Acceptance: payment, security, database, and network incidents have clear escalation paths.

## P2 — Accessibility, quality, and design consistency

### Accessibility

- [ ] **A11Y-001 — Complete a WCAG 2.2 AA contrast audit**
  - Include lime text, muted text, borders, disabled controls, focus rings, and status colors.
  - Acceptance: automated and manual contrast results are recorded.

- [ ] **A11Y-002 — Verify keyboard-only operation**
  - Cover login, PIN visibility, passkeys, checkout, plan cards, modals, dashboard, and admin tabs.
  - Acceptance: focus order is logical and no keyboard trap exists.

- [ ] **A11Y-003 — Verify focus management**
  - Cover progressive login fields, modal open/close, errors, success states, and redirects.
  - Acceptance: focus moves to the changed state or relevant heading.

- [ ] **A11Y-004 — Test screen-reader announcements**
  - Cover errors, payment progress, voucher activation, connection state, and dynamic dashboards.
  - Acceptance: VoiceOver or TalkBack testing is documented.

- [ ] **A11Y-005 — Test zoom and responsive reflow**
  - Cover 200% and 400% zoom without clipped content or two-dimensional scrolling.
  - Acceptance: package comparison remains operable at high zoom.

- [ ] **A11Y-006 — Verify touch targets and mobile form behavior**
  - Acceptance: controls meet target-size guidance and correct mobile keyboards appear.

- [ ] **A11Y-007 — Support reduced motion and timing needs**
  - Acceptance: nonessential motion can be reduced and timed states provide recovery.

### Testing

- [ ] **TEST-001 — Add browser-driven customer journey tests**
  - Cover voucher/PIN setup, returning login, passkey fallback, forgot PIN, checkout, payment recovery, renewal, switching, and device connection.
  - Acceptance: tests run in CI against desktop and mobile viewports.

- [ ] **TEST-002 — Add administrator browser tests**
  - Cover authentication, bundle management, voucher generation, suspension, refunds, integrations, and audit logs.
  - Acceptance: critical role restrictions have positive and negative tests.

- [ ] **TEST-003 — Add provider sandbox contract tests**
  - Acceptance: MeSomb, Flutterwave, and Resend request/response assumptions are tested regularly.

- [ ] **TEST-004 — Add automated accessibility testing**
  - Acceptance: severe accessibility violations fail CI while manual verification remains documented.

- [ ] **TEST-005 — Add visual regression testing**
  - Cover customer and administrator critical screens at representative viewports.
  - Acceptance: intentional visual updates require reviewed baselines.

- [ ] **TEST-006 — Add failure and chaos scenarios**
  - Cover delayed webhooks, provider outages, database disconnects, email failures, RouterOS failures, process restarts, and duplicate requests.
  - Acceptance: customer data and payment state remain consistent.

- [ ] **TEST-007 — Add sustained and larger-scale load tests**
  - Move beyond the current 300-user burst test.
  - Acceptance: soak tests demonstrate stable latency, memory use, and database behavior.

### Design consistency

- [ ] **DES-001 — Create documented design tokens**
  - Cover color, typography, spacing, radius, elevation, breakpoints, and interaction states.
  - Acceptance: customer and admin styles consume shared documented values where appropriate.

- [ ] **DES-002 — Build reusable interface components**
  - Standardize buttons, fields, alerts, cards, tables, tabs, modals, and status badges.
  - Acceptance: equivalent components have consistent states and accessibility behavior.

- [ ] **DES-003 — Review responsive package presentation**
  - Acceptance: package discovery and comparison work without hidden affordances across supported screens.

- [ ] **DES-004 — Improve loading, success, warning, and empty states**
  - Acceptance: every asynchronous customer and admin operation has a consistent state model.

## P2 — WISP operations and administration

### Multi-site WISP capabilities

- [ ] **WISP-001 — Replace remaining student-zone runtime terminology**
  - Update internal zone defaults, status responses, documentation, and coverage descriptions.
  - Acceptance: public and operational language consistently reflects a managed public Wi-Fi WISP.

- [ ] **WISP-002 — Support multiple sites and coverage zones**
  - Acceptance: customers, vouchers, routers, access points, bundles, and reports can be scoped by site.

- [ ] **WISP-003 — Support multiple routers, SSIDs, and access points**
  - Acceptance: device inventory and health are visible per network component.

- [ ] **WISP-004 — Add outage and maintenance management**
  - Acceptance: operators can publish scoped notices with start time, updates, and resolution.

- [ ] **WISP-005 — Add bandwidth and fair-use policy profiles**
  - Acceptance: package limits map predictably to RouterOS enforcement and customer-facing descriptions.

- [ ] **WISP-006 — Add network capacity and coverage reporting**
  - Acceptance: operators can identify congestion, weak coverage, and overloaded access points.

- [ ] **WISP-007 — Conduct physical network resilience testing**
  - Test UPS, surge protection, grounding, uplink failure, walls, roofing, interference, and weather exposure.
  - Acceptance: findings and remediation are documented per site.

### Administrator workflows

- [ ] **ADMIN-001 — Add approval workflows for sensitive operations**
  - Cover refunds, large voucher batches, privilege changes, and destructive actions.
  - Acceptance: configurable two-person approval exists where required.

- [ ] **ADMIN-002 — Refine role permissions**
  - Define owner, operator, reseller, support, finance, and read-only capabilities.
  - Acceptance: every endpoint has explicit permission tests.

- [ ] **ADMIN-003 — Add pagination, search, filters, and saved views**
  - Cover customers, vouchers, payments, devices, events, and audit records.
  - Acceptance: operators can find production records quickly without loading the full dataset.

- [ ] **ADMIN-004 — Add safe bulk operations**
  - Acceptance: previews, validation, partial-failure reporting, confirmation, and audit trails exist.

- [ ] **ADMIN-005 — Improve audit-log investigation tools**
  - Acceptance: logs can be filtered by actor, customer, action, date, IP, and correlation ID.

- [ ] **ADMIN-006 — Add operational reports and exports**
  - Cover revenue, active customers, voucher inventory, failed payments, network usage, reseller activity, and refunds.
  - Acceptance: exports respect role permissions and privacy rules.

## P3 — Growth, support, and governance

### Localization

- [ ] **I18N-001 — Complete French localization**
  - Cover customer UI, admin UI, validation, payment states, emails, dates, currency, and support content.
  - Acceptance: language switching persists across sessions.

- [ ] **I18N-002 — Introduce a maintainable translation system**
  - Acceptance: user-facing copy is not duplicated across templates and scripts.

### Privacy and compliance

- [ ] **PRIV-001 — Publish privacy and service terms**
  - Cover personal data, network metadata, payments, vouchers, acceptable use, refunds, and service limitations.
  - Acceptance: legal review for applicable Cameroon requirements is complete.

- [ ] **PRIV-002 — Add customer data export and deletion workflows**
  - Acceptance: identity verification, retention exceptions, audit history, and completion records are defined.

- [ ] **PRIV-003 — Minimize personal data collection and exposure**
  - Acceptance: every stored field has a documented purpose and retention period.

- [ ] **PRIV-004 — Document breach-response procedures**
  - Acceptance: detection, containment, notification, evidence preservation, and post-incident review are assigned.

### Customer support

- [ ] **SUP-001 — Add in-product help and support contacts**
  - Acceptance: customers can reach support from login, payment, voucher, and dashboard screens.

- [ ] **SUP-002 — Add payment troubleshooting guidance**
  - Cover pending prompts, rejected payments, duplicate concerns, provider downtime, and refunds.
  - Acceptance: guidance links to the relevant recovery action.

- [ ] **SUP-003 — Add voucher recovery and ownership procedures**
  - Cover lost codes, incorrect phone linkage, resale disputes, expired codes, and transfers.
  - Acceptance: support actions are identity-verified and audited.

- [ ] **SUP-004 — Add customer-facing outage information**
  - Acceptance: affected customers see current status and estimated restoration information.

- [ ] **SUP-005 — Build administrator support tooling**
  - Acceptance: support staff can diagnose account, payment, voucher, device, and provisioning state without unrestricted access.

### Product analytics

- [ ] **AN-001 — Define privacy-conscious product events**
  - Cover package views, checkout starts, payment results, voucher claims, renewals, switches, connection failures, and support-triggering errors.
  - Acceptance: events exclude PINs, voucher codes, secrets, and unnecessary personal data.

- [ ] **AN-002 — Build conversion and reliability funnels**
  - Acceptance: operators can identify where acquisition, payment, activation, and reconnection fail.

- [ ] **AN-003 — Measure retention and plan health**
  - Track renewal, switching, exhaustion, inactivity, churn, and package utilization.
  - Acceptance: metrics have documented definitions and owners.

### Documentation

- [ ] **DOC-001 — Align authentication documentation with voucher-first login**
  - Acceptance: README, operator guidance, support content, and diagrams match implemented behavior.

- [ ] **DOC-002 — Remove stale campus/student terminology**
  - Acceptance: runtime status, RouterOS notes, deployment docs, reports, and public copy use approved WISP terminology.

- [ ] **DOC-003 — Document business rules**
  - Cover voucher ownership, activation, expiry, stacking, renewal cooldown, switching, devices, refunds, and reseller inventory.
  - Acceptance: each rule has an owner and corresponding automated tests.

- [ ] **DOC-004 — Document APIs and external integrations**
  - Acceptance: endpoint contracts, authentication, idempotency, webhook signatures, and failure behavior are versioned.

- [ ] **DOC-005 — Maintain operational runbooks**
  - Cover deployment, rollback, migrations, backups, restore, payment incidents, email incidents, and network incidents.
  - Acceptance: each runbook has been exercised and dated.

## Existing verified foundations

These are already implemented and should remain protected by regression tests.

- [x] **BASE-001 — Separate customer, administrator, and API services**
- [x] **BASE-002 — Use distinct hashed customer and administrator sessions**
- [x] **BASE-003 — Hash customer PINs with Argon2id**
- [x] **BASE-004 — Support voucher-first account setup and returning login**
- [x] **BASE-005 — Provide single-use email PIN recovery**
- [x] **BASE-006 — Support passkeys and authenticator verification**
- [x] **BASE-007 — Sanitize customer-facing WebAuthn errors**
- [x] **BASE-008 — Preserve and roll authenticated plan-management sessions**
- [x] **BASE-009 — Verify provider-backed payments before voucher issuance**
- [x] **BASE-010 — Sign and validate payment webhooks**
- [x] **BASE-011 — Enforce voucher quota, expiry, and device limits**
- [x] **BASE-012 — Maintain administrator roles, MFA, CSRF checks, and audit events**
- [x] **BASE-013 — Validate production configuration at startup**
- [x] **BASE-014 — Run automated integration, separation, security, and 300-user tests**

## Progress summary

Update these totals whenever tasks are completed.

- P0 pending: 0
- P1 pending: 27
- P2 pending: 24
- P3 pending: 17
- Verified foundations complete: 14
- Recommendation tasks complete: 27
