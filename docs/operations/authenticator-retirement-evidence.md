# Authenticator retirement evidence record (#82)

This is an empty record template. It is not proof that a pilot or cutover ran.
Keep the filled record privately; do not put account names, phone numbers, PINs,
passwords, passkey responses, factor secrets or recovery codes in GitHub.

## Current verified state, 22 October 2026

A read-only request to `https://api.ndahiconnect.net/api/authentication-policy`
returned HTTP 200, API revision `8323878ea6a2345e13aae876f9f8eb3625af8bf6`,
and `authenticatorRetired: false`. This proves the compatibility API is live.
It does not establish account migration, frontend revisions, recovery readiness,
physical authentication acceptance or rollback acceptance. The user has no
existing readiness evidence to identify. No retirement mutation was run.

## Gather readiness without changing methods

1. Sign in to the admin app as an active owner. Open `/dashboard#connections` (Connections & security) and find **Prepare password & passkey access**. Open
   **Authentication readiness report**. Refresh and record aggregate counts
   privately. Do not export account credentials or the database.
2. Each affected customer opens Account → Prepare PIN & passkey access and
   verifies their replacement. Each active administrator verifies an existing
   password or passkey in the preparation panel. Merely adding a key or setting
   a PIN/password is not the verification step.
3. Reopen the owner report. Missing replacements, unverified authenticator
   accounts, or unverified active administrators must be resolved before review.
   Suspended authenticator accounts still require an accessible recovery plan.

## Run and record actual acceptance

| Check | Environment/revision | Result/date | Private evidence reference |
| --- | --- | --- | --- |
| Customer PIN login, logout/relogin and supported sensitive actions | Pending | Pending | Pending |
| Customer passkey login/actions; cancelled and unsupported prompt → PIN fallback | Pending | Pending | Pending |
| Admin password login and supported actions; current role enforcement | Pending | Pending | Pending |
| Admin passkey login/actions; cancellation → password fallback | Pending | Pending | Pending |
| Account recovery, missing replacement account and support audit | Pending | Pending | Pending |
| Wi-Fi main-device approval/code remains separate and works | Pending | Pending | Pending |
| Compatible rollback preserving accounts, new activity and supported credentials | Pending | Pending | Pending |
| Exact API and both frontend deployed revisions; strict smoke | Pending | Pending | Pending |

Use staging/test accounts for recovery and rollback rehearsals. Do not deliberately
lock out or reset a real customer's credentials to produce evidence. A synthetic
browser test is recorded as automated validation, never as this real acceptance.

## Owner records the completed review

After the actual checks above, use **Record completed rollout checks** under the
report. Enter the full tested compatible rollback commit and a private evidence
reference. Both confirmations start unchecked. Verify with the owner password or
a user-verified passkey. An updated inventory invalidates a stale report: refresh,
review the current counts and re-enter the evidence. Ordinary staff cannot attest.

Saving a review only records reviewed evidence against that inventory. It neither
invalidates credentials nor activates retirement. A separately authorized operator
must follow [the gated cutover runbook](authenticator-retirement.md), obtain the
current read-only readiness result and apply only its reviewed digest. Never fill
in missing results with assumptions, CI success or a configured credential.
