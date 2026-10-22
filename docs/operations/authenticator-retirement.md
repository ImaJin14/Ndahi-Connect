# Gated authenticator retirement (#82)

This integrated compatibility runtime and migration are prepared for review. It does not prove production readiness, activate
retirement on startup, merge a PR, deploy either app or change production data.
Customer final methods are PIN/passkey; administrator final methods are the
existing password/passkey. Main-device approval and Wi-Fi access codes remain.

## Gate and sequence

Deploy the compatible #81 preparation revision first. Every authenticator account
must actually verify its current retained PIN or passkey; a configured hash/key
alone is insufficient. Existing customer accounts without an authenticator keep
their configured methods. Every active administrator must verify their current
password/passkey. An active owner reviews actual recovery and authentication pilot
evidence and the exact compatible rollback commit, against the current credential
inventory digest. Changed credentials invalidate that review. Do not fabricate
readiness evidence to exercise retirement in production.

1. Review #81 readiness and unblock every account, recovery and pilot criterion.
2. Deploy compatible API/worker behavior that consults the retirement marker,
   rejects retired routes explicitly and cannot recreate TOTP material. Verify the
   rollback revision does the same. Update clients/configuration in the ordered
   rollout; do not remove environment values while an older API requires them.
3. Run the default read-only report with the target API's existing configuration:

   ```bash
   node scripts/authenticator-retirement.mjs
   ```

   `DATABASE_URL` selects the existing PostgreSQL normalized store. Snapshot uses
   a `REPEATABLE READ READ ONLY` transaction; it does not seed or migrate tables.
   For an offline JSON store, use `--file /path/to/db.json`. JSON apply requires
   the API to be stopped; JSON store locking is process-local and cannot safely
   arbitrate an online API writing the same file.

4. Only with actual readiness, the separately authorized operator passes the
   exact reviewed report digest:

   ```bash
   node scripts/authenticator-retirement.mjs --apply --expected-digest REVIEWED_DIGEST
   ```

   The migration recomputes readiness under the store's global exclusive
   transaction lock. Any changed digest or remaining blocker aborts before
   deleting anything. No `--force` or environment switch bypasses this gate.
   The CLI reports success only after the transaction commits.

5. Record the resulting marker revision/time, actual API/frontend revisions,
   strict smoke and actual customer/admin login, sensitive action, support
   recovery and Wi-Fi pairing tests. CI and deployment are separate evidence.

## Exact invalidation inventory

| Location | Retired data | Preserved data |
| --- | --- | --- |
| Customer | `totpSecret`, `totpEnrolledAt`, authenticator `recoveryCodes`, `authenticatorRecoveryPermit`, `mfaProofs`, `mfaCompletion`, `mfaCheck` | PIN/passkeys, `accountBackupCodes`, `pendingEmail`, profile, balances, main device |
| Global `adminProfile` and partial individual administrator factor fields | `totpSecret`, `totpEnrolledAt`, `mfaEnabled`, `mfaCodeHash` | Password/passkeys, roles, account state and other profile fields |
| `customerMfaChallenges` | All authenticator enrollment/replacement rows | Other challenge collections |
| `otpChallenges` | All rows: this collection is exclusively customer authenticator login in the reviewed baseline | Email verification and PIN recovery use `pendingEmail` and `pinResetChallenges` |
| `adminMfaChallenges`, `adminLoginChallenges` | All enrollment and already-issued password-to-MFA login challenges | Ordinary password/passkey login and current sessions |
| Customer passkey proofs | Exact types `authenticator_replace`, `authenticator_resume`, `migration_enroll_pin`, `migration_confirm` | Registration/login, contact, PIN change and account-backup proofs |
| Admin passkey proofs | Exact types `sensitive:migration_confirm`, `sensitive:auth_cutover_attestation` | Ordinary registration/login and other fresh supported-action proofs |
| Customer/admin sessions | `mfaRecoveryGrant`, pending `authMigrationIntent` | Session identity, CSRF, remembered Wi-Fi association |

Independent `accountBackupCodes` reset the customer PIN and are distinct from
authenticator `recoveryCodes`. Preserve their existing hashes; the final recovery
route intentionally removes the retired extra TOTP requirement while retaining
its bounded verification and credential/session invalidation. The #81 owner
review must verify this final recovery policy in the pilot. No shared naming
rule removes unrelated codes, permits or all-purpose recovery data.

`pinResetChallenges`, `customerAccessChallenges`, `wifiPairingRequests`,
`wifiDeviceGrants`, router sessions/commands, vouchers, payments and app device
associations are untouched. The source inventory is explicit; update it if a
future revision adds another authenticator-only field or collection.

## Marker, reruns and rollback

The atomic `zone.authenticatorRetirement` version 1 marker is written last and
stores the pre-cutover readiness digest, reviewed rollback revision, evidence
reference, review/retirement time and aggregate removal counts. It stores no
TOTP secret, recovery hash, phone number or passkey material. Rerunning version 1
is a no-op and preserves later payment/account activity. An older tool rejects
a newer retirement version.

Rollback uses the exact marker-aware preparation commit recorded in the review;
it preserves current account data and the retirement marker. Never restore
deleted factor secrets, restore an old database over new activity, remove the
marker, or deploy a revision that can ignore it. Existing factor-derived sessions
remain sessions; every sensitive action still requires fresh current supported
proof. The integrated API rejects old clients with HTTP410 `AUTHENTICATOR_RETIRED` and a refresh/PIN/passkey message. It cannot recreate legacy factors even if obsolete environment values or partial stored factor fields remain. Fresh proof protects credential enrollment/removal and staff changes during preparation too.

## Validation and remaining work

The focused regression suite covers read-only reports, stale/missing/changed
readiness evidence, credential version changes, exact challenge/grant removal,
preservation of independent recovery/contact/Wi-Fi/account data, commit rollback,
partial legacy state, bounded safe reports and idempotency. API/UI/configuration
compatibility and actual rollback/authentication/recovery pilots are separate
required evidence before activating this migration anywhere live.

## Two-phase deployment prerequisite

Deploy and test the complete compatibility runtime while the retirement marker is **absent**. Keep existing legacy environment values through this phase; do not sync their Blueprint removal while an older API or a still-dependent account requires them. The updated code accepts preparation and final policy. The final Blueprint cleanup belongs after the gated cutover, and does not itself activate retirement.

Drain every older API/worker revision sharing the database before applying the CLI. A rolling deployment with an old factor-enrollment worker still running is not sufficient. First establish real PIN/password/passkey and audited recovery pilots, including passkey cancellation/unsupported devices, actual fresh sign-in, required user verification, independent account-backup recovery and unchanged Wi-Fi pairing authority.

Record the exact tested compatibility-runtime SHA as the preparation rollback revision. The original PR87 head `7564e9c` is **not** a sufficient post-cutover rollback target: marker awareness without the complete fresh sensitive-action policy is insufficient. Use the final tested runtime candidate recorded in the PR evidence. Rehearse it against synthetic retired state while preserving current account data and marker. Owner review must reference that tested candidate, not merely an arbitrary SHA.

After compatibility deployment, obtain the protected production aggregate inventory. Owner review binds that exact current inventory, the tested recovery/authentication evidence and rollback SHA. Any intervening credential/account change invalidates it. Passing CI, a configured password/public key, or an owner session alone cannot establish readiness. Only then may a separately authorized operator apply the CLI with its exact digest. This task authorizes neither that operation nor a production deployment.

After cutover, remove obsolete environment values and verify both app/API revisions. `SMOKE_EXPECT_AUTHENTICATOR_RETIRED=true npm run check:deployment` additionally checks the persisted public policy: customer PIN/passkey, admin password/passkey. `GET /api/authentication-policy` contains only method policy and a nonsecret API revision; it returns no customer/readiness details and is not cached. Complete actual account login/sensitive-action acceptance separately from this public smoke.

## Integrated implementation and evidence

The effective marker controls both apps, API projections, old authenticator routes and extra factor gates. Security cards, main-device/Forget/disconnect, login, PIN/backup recovery and customer/admin passkey actions retain their supported fresh proofs. Customer Home keeps the reviewed collapsed Manage devices UI and account-scoped identity work from #78/#79. Historical security notices retain truthful past events; Wi-Fi access/pairing codes never become account credentials.

Synthetic signed-protocol tests reject UV=false, wrong account/session/purpose/target, expired/replayed assertions and legacy session-only enrollment. Modern registration that already passed fresh supported proof can finish across cutover; obsolete unbound registration cannot. The versioned migration invalidates every authenticator-specific challenge/secret/grant atomically. PostgreSQL tests cover persisted marker/credential state, reopen, rollback and idempotency when `TEST_DATABASE_URL` is supplied.

The independent zone and last-verified-admin-credential regressions are integrated. Zone updates require POST and disclose only public fields, preserving internal retirement/review metadata. Credential removal requires a verified remaining supported method. Exact full-suite/browser/CI evidence and runtime candidate are recorded in the PR and the dedicated tracker handoff.

Production inventory, real recovery/authentication pilots, compatible production rollback rehearsal, Render revisions and physical installed-app/router acceptance remain **pending**. No secret deletion, live cutover, merge, deployment or router operation was performed for this implementation.

## 22 October review candidate

Compatibility-runtime candidate: `74ae34a4d6124baba1539f2e5d1782780f58fa41`. This integrates preparation `e205725`, identity `08adcf3`, Home/history `dd2c6ae` and the peer-reviewed collapsed-device regression fix `9f88a5b`. The latest full authentication unit/API suite passed 838 tests, with 16 PostgreSQL cases skipped locally; CI runs the PostgreSQL cases. Eight retirement browser journeys passed. The full integrated browser rerun and exact final CI status are recorded on the draft PR. This records a review candidate, not an operationally accepted rollback revision or completed pilot.

## Guided owner readiness follow-up (#82)

The admin preparation report now includes **Record completed rollout checks**.
Its form stays disabled while account-method blockers remain. The owner supplies
completed authentication/recovery/rollback evidence, confirms both checks, and
uses fresh password or user-verified passkey proof. The server requires the exact
report digest for both review challenges and saved evidence; an inventory change
returns `409 READINESS_CHANGED` without recording a review. Refresh clears the
form and its confirmations. Saving evidence never runs the retirement migration.

Use [the evidence record](authenticator-retirement-evidence.md) for the outstanding
real acceptance. The public API was verified at merged revision `8323878` with
retirement still disabled on 22 October 2026. Protected aggregate account readiness,
real recovery/rollback results and both frontend revisions remain unverified.
