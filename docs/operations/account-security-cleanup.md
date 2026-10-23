# Account settings and runtime authenticator removal

The user requested temporarily disabling theme/language selection, removing the
remaining authenticator application flows, and reorganizing Account. Customers
use PIN/passkey; administrators use their existing password/passkey. This change
is separate from the already deployed payment retry repair in PR #126.

## Runtime behavior

- Account groups name, account number, email, PIN/passkeys, account recovery and
  sessions. Editing is expandable; optional email linking starts collapsed.
  Security and recent sign-in history stay in Notifications.
- Theme/language controls and initialization are commented out. Saved dark/French
  preferences and OS dark mode do not activate the experimental features.
- Customer/admin authenticator enrollment, replacement, verification, recovery
  sign-in and extra authenticator requirements are removed. Historical requests
  receive HTTP 410 and never disclose a setup secret or establish a session.
- PIN/passkey proof still protects customer profile/device/credential changes.
  An authenticator code cannot create a replacement PIN or count as an alternate
  credential when the last passkey is removed. Old factor-derived pending PIN
  intents are rejected; a new intent requires a fresh passkey assertion and
  separate session-bound PIN confirmation.
- Administrators retain password/passkey proof. The password field takes
  precedence over a legacy PIN alias; proof challenges bind both stored hashes
  so a password rotation cannot leave an earlier proof usable. Old PIN-named
  request fields verify the current password; a distinct stale alias cannot
  establish readiness or preserve an earlier reviewed inventory.
- Account backup codes, confirmed-email PIN recovery, audited owner support
  recovery, and Wi-Fi approval/access codes remain distinct supported flows.
- Public authentication policy version 2 advertises runtime retirement even if
  the historical credential-purge marker is absent. Customer/admin UI never
  resurrects a factor based on leftover fields or a failed policy request.

## Historical state and rollout

Runtime removal does not erase account credentials or invent migration evidence.
The guarded offline inventory/purge procedure remains separate, retaining its
reviewed recovery/rollback checks. Its persisted marker also has existing
session/rollback contracts; this UI cleanup does not silently change them.
Historical factor fields remain private and cannot authorize a runtime operation.

Before deploying runtime removal, check the private credential inventory and
verify supported access/recovery for accounts that had only an authenticator.
An authenticated browser session, voucher, phone number or old OTP alone must
never set an owner's replacement PIN. Such customers use an existing passkey,
confirmed-email/account backup recovery or audited support recovery. No real
account readiness, recovery pilot or purge attestation is manufactured by tests.

Deploy the API before the customer/admin assets. Old open pages receive explicit
retirement responses and can reload to PIN/passkey. A real phone/passkey/recovery
acceptance check remains separate from automated browser tests.

## Verification evidence

The cleanup PR records final revision and CI. Local checks cover the full suite,
real signed WebAuthn proofs, OTP/recovery replay rejection, PIN failure/backoff,
secret-free projections, profile/device ownership and request commit rollback.
Browser coverage includes saved preferences plus OS dark mode at 320/390/768/1280px,
PIN/passkey sign-in, enrollment/removal, cancellation and fallback, old cached
challenges, one-use support recovery, sessions and duplicate submits. PostgreSQL
checks run in CI; local skips are never reported as passes.

The reduced legacy-MFA test count reflects replacement of obsolete enrollment
and OTP acceptance tests with rejection/unchanged-state tests. Account recovery,
Wi-Fi approval, billing and genuine passkey signature checks remain covered.
