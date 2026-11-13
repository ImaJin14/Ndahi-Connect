# Phase 6 sign-in: PIN and passkey

Redesign Phase 6 (`docs/redesign/execution-plan.md`, decisions in `docs/redesign/decisions.md`). It covers what changed, what to do before the cutover, and what the cutover does. The retirement itself is the existing gated script; see `authenticator-retirement.md`.

## What changed

**Administrators** sign in in two steps (canvas: AdminLogin):

1. Email + PIN. The username still works in the email field, so nobody is locked out before adding an email.
2. The passkey confirms the PIN. No session is issued until it verifies. The step is single use, expires in five minutes and is bound to the person's current credentials.

An administrator without a passkey depends on the cutover:

| | Before the cutover | After the cutover |
| --- | --- | --- |
| PIN-only administrator | The PIN alone still signs in (as today). | Adds a passkey on the sign-in page to finish. No session without one. |
| Administrator with a passkey | PIN, then passkey. | PIN, then passkey. |
| Passkey alone (no PIN) | Still accepted (v1's "Sign in with a passkey"). | Refused: sign in with email + PIN first. |

"After the cutover" means the store carries the retirement marker that `scripts/authenticator-retirement.mjs --apply` writes.

**Profile & security (v2)**
- Each person sets their sign-in email; it is unique across administrators and needs fresh verification.
- Change PIN uses 6–8 digits in the v2 form. The server still accepts existing credentials, so current passwords keep working until changed.
- Owners see staff emails and passkey counts. An owner can **remove a staff member's lost passkeys**: this signs them out, and they add a new passkey at their next sign-in. The action needs fresh verification and is audited.

**Customer support (v2 customer detail)**
- Owners can **remove a customer's lost passkeys**. It uses the same audited recovery form as the PIN support code: case reference, reason, identity check and fresh proof. The customer is signed out and alerted, keeps their PIN and backup codes, and adds a new passkey after signing in.

**Customers (v2 sign-in, canvas: PhoneLogin)**
- Phone + PIN is the main path; *Sign in with a passkey* is the other. *Use a voucher code* switches to the existing voucher path: phone + voucher, then the PIN, or a new PIN for a first voucher. The main-device approval gate stays on that path.
- Wi-Fi approval for new devices is enforced when a device connects, so PIN sign-in does not bypass the main device.
- A forgotten PIN is reset by email link (15 minutes, single use), as before.

**Not removed:** `verify.html` and `authenticator-management.js`. The plan listed them for removal, but `verify.html` is now the page where new customers create their PIN after paying, and the authenticator files are inert compatibility stubs. SMS and authenticator sign-in endpoints already answer `410 AUTHENTICATOR_RETIRED`.

## Before the cutover (owner)

1. Deploy this change. Nothing changes for PIN-only staff yet.
2. Ask every administrator to add their email and at least one passkey in Profile & security. Staff who skip it add a passkey at their first sign-in after the cutover, which needs a passkey-capable device.
3. Run the read-only readiness report: `node scripts/authenticator-retirement.mjs`. Contact anyone it lists as still depending on SMS codes or an authenticator.

## Cutover (owner)

Follow `authenticator-retirement.md`. Back up, run on staging, check the sign-in journeys there, then run on production with `--apply --expected-digest <reviewed digest>`. From that moment every administrator signs in with PIN + passkey.

## Evidence

- Unit: `test/phase6-sign-in.test.mjs` covers the two-step flow, the single-use step, the before/after cutover behaviour, email changes, owner removal of staff passkeys and support removal of customer passkeys. The retirement tests were updated to the two-step flow.
- Browser: `scripts/check-phase6-sign-in-journeys.mjs` uses a virtual authenticator. It covers a wrong PIN; adding a passkey to finish; PIN then passkey; *Use a different account*; and customer phone + PIN with the voucher path. The full v2 browser suite and v1 runs of the edited journeys pass.
- Not done: a real phone or security key, staging, or production. The cutover has not run.
