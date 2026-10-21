# Gated authenticator retirement (#82)

This core is prepared for review. It does not prove production readiness, activate
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
proof. Marker-aware API guards must prevent old clients from using or recreating
factor routes/grants; this core alone does not provide those API guards.

## Validation and remaining work

The focused regression suite covers read-only reports, stale/missing/changed
readiness evidence, credential version changes, exact challenge/grant removal,
preservation of independent recovery/contact/Wi-Fi/account data, commit rollback,
partial legacy state, bounded safe reports and idempotency. API/UI/configuration
compatibility and actual rollback/authentication/recovery pilots are separate
required evidence before activating this migration anywhere live.
