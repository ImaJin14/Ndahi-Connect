# Unified customer security — issue #129

Account → Security → **Manage PIN / Passkey** is the single settings entry for
PIN changes, passkey enrollment/removal, and recovery preparation. PIN, Passkeys
and Recovery are short panels within the same manager. There is no separate
PIN/recovery card. Sessions and security history stay in Activity.

Customers use PIN/passkey; administrators retain password/passkey. PINs and
WebAuthn credentials are separate. Wi-Fi approvals are not account credentials.
This change does not restore an authenticator flow or delete legacy account data;
the complete obsolete-MFA source/data cleanup is a separate workstream.

## Verification and cancellation

Every credential change needs a fresh current PIN or an action-bound, user-verified
passkey assertion. PIN setup for a PIN-less account requires its existing passkey
or the established recovery process. Browser validation of a leftover PIN does not
block the passkey alternative. Unsupported browsers show PIN/recovery guidance.

The manager locks competing controls while a verification/mutation runs. A native
passkey cancellation leaves the PIN alternative available. Cancel/Close/Escape
clears entered secrets and displayed backup codes and returns focus to the entry.
PIN changes rotate the current session, revoke other portal sessions and invalidate
previous backup codes. Bundles and router sessions are preserved. Removing the
last usable sign-in credential remains blocked by the server, even if the browser
or a caller submits the operation directly.

## Lost replies

The client supplies a random operation ID on final PIN/passkey/backup mutations.
The same transaction records a receipt in the initiating dashboard session (or the
new session after a PIN rotation). A read of
`GET /api/account/security/actions/:operationId` can confirm that committed change.
It contains only completion, action and timestamp; no PIN, assertion, code or key.
Other sessions, including another session of the same customer, cannot read it.
Receipts expire after ten minutes and each session retains at most ten.

After a transport/JSON failure the browser reads this status once. It never replays
an assertion or automatically submits another change. An unknown result offers
Refresh security and sign-in, without claiming success. If the PIN response and its
new session cookie were both lost, the user signs in using the new PIN. Existing
email/backup/audited-support recovery stays reachable at `/forgot-pin` and Help.

Backup codes are Argon2id-hashed in storage and shown only in the successful
mutation response. A receipt cannot retrieve them. If generation committed but the
response was lost, the customer waits for the existing one-minute rate limit and
generates a fresh set. The lost set is replaced; the app does not pretend to have
saved it. Downloaded files remain the customer's responsibility.

## Validation and rollout

Dedicated API tests cover incorrect/current proof, CSRF, PIN lockout, genuine
WebAuthn origin/RP/UV/session/target/expiry/credential checks, replay consumption,
last-credential rules, backup-code one-use, receipt isolation and commit failure.
A PostgreSQL test exercises atomic PIN/session/receipt persistence, rollback,
concurrent stale requests and reopening storage. No database schema change is
needed: receipts use the existing dashboard-session JSON payload.

`node scripts/check-unified-security-journeys.mjs` runs genuine Chromium WebAuthn,
mobile/desktop layout, cancellation, unavailable-passkey/blocked-storage fallback,
lost replies, backup downloads and focus/secret clearing. Existing recovery,
portal, security, current-device and pending-action suites remain required.

Source implementation and automated checks do not attest to a real customer's
recovery method. No real-account recovery, physical phone acceptance, merge or
production deployment is performed by this PR. Verify email/backup/support recovery
with designated test accounts and physical iOS/Android devices during release
acceptance. Deploy API support before the corresponding frontend.
