# Secret rotation runbook

Last reviewed: 2026-09-08

Use this procedure for scheduled rotation and immediately after suspected exposure. Never paste secret values into tickets, chat, source control, deploy logs, or screenshots. Record only the credential name, provider reference, operator, timestamps, and verification result in the change record.

## Preparation

1. Assign an operator and reviewer, announce the maintenance window, and confirm a recent database backup.
2. Confirm the current production deploy is healthy and save its deploy identifier for rollback.
3. Open the Render API service's Environment page and the relevant provider console in separate authenticated sessions.
4. Generate secrets with a cryptographically secure password manager. Application secrets must be at least 32 characters and unique to their purpose.
5. Do not revoke the current credential until the replacement has passed the checks below.

## Application secrets with overlap

The application accepts one current and one previous value for customer sessions, administrator sessions, and challenge hashing. New records always use the current value.

Rotate each pair separately:

| Current variable | Temporary overlap variable |
| --- | --- |
| `CUSTOMER_SESSION_SECRET` | `CUSTOMER_SESSION_SECRET_PREVIOUS` |
| `ADMIN_SESSION_SECRET` | `ADMIN_SESSION_SECRET_PREVIOUS` |
| `SECRET_PEPPER` | `SECRET_PEPPER_PREVIOUS` |

1. Copy the current value into its `_PREVIOUS` variable in Render.
2. Replace the current variable with the new secret and deploy.
3. Verify health, an existing customer session, an existing administrator session, a new login, and—when rotating the pepper—an access or PIN-reset challenge created before deployment.
4. Keep the previous session secret for at least the configured maximum session lifetime. Keep the previous pepper for at least the longest access/reset challenge lifetime. The current defaults require 30 minutes for sessions and 15 minutes for challenges; use 60 minutes as the normal overlap window.
5. Remove the `_PREVIOUS` value, redeploy, and verify new sign-ins again. Roll back before removal if any verification fails.

## Payment credentials

### MeSomb

Rotate `MESOMB_APPLICATION_KEY`, `MESOMB_ACCESS_KEY`, `MESOMB_SECRET_KEY`, and `MESOMB_WEBHOOK_SECRET` according to MeSomb's credential console. If parallel keys are supported, create the replacement, update Render, deploy, make and verify a low-value controlled payment, confirm its webhook creates exactly one voucher, and only then revoke the old key. If webhook secrets cannot overlap, schedule a payment maintenance window, pause new checkout, update both endpoints, deploy, replay the controlled event, and reopen checkout.

### Flutterwave

Rotate `FLW_SECRET_KEY` and `FLW_SECRET_HASH` in the same staged order. Keep `PAYMENT_MODE` unchanged during the test. Verify a controlled payment, signed webhook acceptance, transaction reference, amount, currency, and single-voucher issuance before revoking the previous credential.

After either provider rotation, inspect pending and failed payments and run the payment reconciliation procedure. Never mark an unverified payment paid manually.

## Email credential

Create a replacement Resend key with only sending access, update `EMAIL_API_KEY`, deploy, and send a controlled voucher email to an operator-owned address. Confirm delivery and recorded message ID before revoking the old key. Domain DNS credentials and the `EMAIL_FROM` identity are configuration, not API secrets; changes still require a delivery test.

## Network-management credentials

For RouterOS, create a new restricted bridge user/password, update `MIKROTIK_USER` and `MIKROTIK_PASSWORD`, deploy, run usage synchronization and a controlled voucher sync/disconnect, then disable the old user. For Omada, create a replacement site-scoped token, update `OMADA_API_TOKEN`, deploy, check controller status and access-point visibility, then revoke the old token. Do not broaden roles or expose either management interface publicly during rotation.

## Administrator recovery credentials

- Replace `ADMIN_BOOTSTRAP_PASSWORD` after first-owner bootstrap and after any exposure. Once administrator users exist, verify normal owner login before changing it; the bootstrap password must not be treated as a daily shared credential.
- `ADMIN_MFA_CODE` is temporary recovery/bootstrap material. Replace it for a controlled recovery event, verify the owner can enroll authenticator MFA, then remove it when the persisted authenticator secret is active.
- Rotate administrator authenticator enrollment from the secured profile workflow, verify a fresh code, and invalidate any superseded recovery record.

## Completion and rollback

Verify `/api/health`, customer login, administrator login with MFA, CSP/security-event intake, payment provider health, email delivery, RouterOS synchronization, and Omada status. Record the new provider credential identifiers and revocation timestamps without recording values.

If verification fails, restore the last known-good Render environment values, redeploy the saved release, confirm health, and leave the old provider credential active. Investigate before attempting another rotation. A database restore is not required for an environment-secret rollback.

The automated test `secret rotation preserves existing sessions and active access challenges` validates the application's non-destructive overlap behavior.
