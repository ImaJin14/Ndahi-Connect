# Account recovery, backup codes, security alerts and payment support verification

This document covers account recovery without email, in-app PIN changing, owner support recovery, security notices, previous-email replacement alerts, and support-initiated payment rechecks past the automatic late cutoff.

## 1. Account backup codes

Customers can generate offline account backup codes from the Account view under **PIN and account recovery**.

- **Format and storage**: Five cryptographically secure tokens (`NC-REC-...`). Codes are hashed with Argon2id before storage; plaintext codes are never retained on the server and are shown to the customer only once.
- **Generation**: `POST /api/account/security/account-backup/generate` requires fresh credential proof (PIN or WebAuthn passkey assertion, plus authenticator OTP if enrolled). Cooldown is rate-limited to once every 60 seconds.
- **Auto-refresh deferral**: While sensitive backup codes are visible on screen (`data-sensitive-output`), automatic app background updates are deferred so codes are not cleared accidentally.
- **Recovery usage**: On `/forgot-pin`, the customer selects **Use an account backup code**, providing their account phone number, backup code, optional authenticator OTP if enrolled, and new four-digit PIN.
- **Constant-time verification**: Account recovery runs fixed-count Argon2id verification work (including against dummy hashes) even for non-existent accounts or accounts with no codes, preventing timing enumeration.
- **Revocation**: Resetting the PIN via a backup code immediately revokes all backup codes in the set, revokes all other portal sessions, resets the PIN, and queues a security alert.

## 2. In-app PIN change

Customers can change their account PIN directly in the Account view:

- **Verification**: `POST /api/account/security/pin` accepts `currentPin` (or passkey assertion from `/api/account/security/pin/options`), `newPin`, `confirmPin`, and authenticator `otp` when enrolled.
- **Revocation & continuity**: All other browser sessions and outstanding login/challenge records are revoked. The current browser receives a fresh customer session cookie and CSRF token without forcing a login round-trip. Earlier account backup codes are invalidated.
- **Alerting**: Queues a `pin_changed` security alert.

## 3. Owner-approved customer support recovery

When a customer loses access to their PIN, email, passkeys, and backup codes:

- **Endpoint**: `POST /api/admin/customers/recovery` is restricted strictly to the `owner` role.
- **Verification requirements**: Requires case reference (3–80 alphanumeric chars), detailed justification (12–500 chars), verified verification method (`in_person` or `existing_verified_channel`), explicit identity confirmation (`confirmedIdentity: true`), owner password, and owner MFA code when MFA is enabled.
- **Rate limiting**: Max 1 recovery code per customer per minute; 5 failed verification attempts in 15 minutes locks admin verification for 15 minutes.
- **Token issuance**: Produces a one-time 32-byte secure token expiring in 15 minutes stored in `pinResetChallenges` with source `"support"`.
- **Customer redemption**: The customer visits `/forgot-pin`, opens **Use a support recovery code**, and submits the code with their new four-digit PIN to `POST /api/account/pin-reset/confirm`.
- **Auditing**: Records audit action `customer.support_recovery.approved` and queues a `support_recovery` security alert to the customer.

## 4. Security notices and email change alerting

- **Security notices view**: Account view displays recent security notices (`securityNotices`) directly in the portal. Customers without an email address on file can view critical account security events (PIN changes, recovery approvals, backup code generation).
- **Previous email alerting**: When a linked email is replaced via `/api/account/profile/email/confirm`, `queueSecurityAlert` sends an `email_replaced` notification directly to the `previousEmail` address, ensuring that account takeover attempts remain visible to the original mailbox owner.

## 5. Support payment verification past late cutoff

Addressing option 3 from the BILL-001 late-settlement review:

- **Problem**: When a payment remains unconfirmed past the approval window and the 24-hour `lateCheckUntil` cutoff without a webhook delivery, automatic polling stops.
- **Admin action**: An owner or operator can trigger `POST /api/admin/payments/verify` on any unconfirmed provider payment (`pending`, `processing`, `failed`, `expired`, `cancelled`).
- **Bypassing cutoff**: `billing.recheckPayment(paymentId, { support: true })` bypasses the `lateCheckUntil` cutoff while maintaining strict transaction reference, currency, and amount validation guards.
- **Throttling**: Limited to at most 1 check per minute per payment; concurrent or repeated calls return 429 (`outcome: "busy"`).
- **Settlement & Audit**: If verified as `paid`, the payment settles and activates access (or holds for review if a conflicting purchase exists). Audits `payment.support_verification.requested` and `payment.support_verification.completed`.
- **Payment reconciliation**: Payment reconciler reports local `expired` or `cancelled` payments found `paid` at the provider as `settlement_missing`, making them actionable by support.
- **Admin UI**: Payment records table in admin dashboard provides a **Check provider** button for eligible unconfirmed provider payments.

