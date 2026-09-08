# CSRF mutation inventory

Last reviewed: 2026-09-08

All production browser `POST` requests require an allowed `Origin`. Requests without an origin are rejected before route handling. The only exceptions are payment webhooks, which authenticate with provider signatures and do not use browser session cookies.

## Public browser mutations

These routes have no authority-bearing session requirement, but still require the customer or administrator origin in production:

- Purchase and payment: `/api/purchase`, `/api/payments/:id/confirm`
- Voucher and account access: `/api/vouchers/redeem`, `/api/account/access/begin`, `/api/account/access/complete`, `/api/account/setup/pin`
- Customer sign-in: `/api/account/login/pin`, `/api/account/login/request-authenticator`, `/api/account/login/verify-authenticator`, `/api/account/passkey/options`, `/api/account/passkey/verify`
- PIN recovery: `/api/account/pin-reset/request`, `/api/account/pin-reset/confirm`
- Administrator sign-in: `/api/admin/login`, `/api/admin/login/mfa`, `/api/admin/passkey/options`, `/api/admin/passkey/verify`

These routes rely on input validation, rate limits, one-time challenges, and credential verification for authorization. They do not accept a logged-in user's authority merely because a cookie is present.

## Customer session mutations

These routes require the customer cookie, an allowed customer origin, and the matching `X-CSRF-Token` bound to that dashboard session:

- `/api/account/plan/purchase`
- `/api/account/logout`
- `/api/account/security/mfa/enroll`
- `/api/account/security/mfa/confirm`
- `/api/account/passkeys/options`
- `/api/account/passkeys/verify`
- `/api/account/devices/disconnect`

Customer cookies are `HttpOnly`, `Secure` in production, and `SameSite=Lax`. The CSRF token is returned only by the authenticated dashboard response.

## Administrator session mutations

Every non-`GET`/`HEAD` route below `/api/admin/` requires the administrator cookie, an allowed administrator origin, the session-bound `X-CSRF-Token`, and an authorized role. This includes logout, users, profile security, bundles, vouchers, customers, devices, payments, network integrations, and zone configuration.

Administrator cookies are `HttpOnly`, `Secure` in production, and `SameSite=Strict`.

## Signed server-to-server exceptions

- `/api/webhooks/flutterwave`
- `/api/webhooks/mesomb`

These endpoints accept originless requests because payment providers call them directly. Each adapter verifies its provider-specific webhook signature before changing state. They never authorize from customer or administrator cookies.

## Verification expectations

- Missing, unapproved, and cross-origin browser mutations return `403` in production.
- A correct origin without the session CSRF token still returns `403` for authenticated mutations.
- Tokens are session-specific and compared in constant time.
- CORS credentials are returned only for explicitly approved origins.
- Provider webhooks remain usable without browser headers and reject invalid signatures.
