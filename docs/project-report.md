# NDAHI Connect Project Report

**Report date:** 21 August 2026  
**Project:** NDAHI Connect Student-Zone Internet Access Platform  
**Production domain:** `ndahiconnect.net`  
**Status:** Pre-launch integration and operational-readiness phase

## 1. Executive summary

NDAHI Connect is a web-based platform for selling, activating, and managing Wi-Fi access across a student zone. It combines a customer portal, a secured administrator dashboard, a backend API, PostgreSQL persistence, Flutterwave Mobile Money collection, transactional voucher email, MikroTik hotspot enforcement, and Omada network monitoring.

The core application and its production deployment structure are implemented. Customer and administrator services are deployed separately on Render and attached to dedicated subdomains. The voucher system uses secure, fixed-format `NC-XXXX-XXXX` codes while keeping plan, customer, payment, usage, and expiry information in the database.

The principal external blocker to live payment testing is Flutterwave approval of the XAF payment method. Until Flutterwave approves XAF Cameroon Mobile Money collections, genuine MTN MoMo and Orange Money authorization prompts cannot be expected. Resend domain verification and network-controller connectivity must also be completed and validated before public launch.

## 2. Project objectives

The project is intended to:

- Provide students with a simple way to select and pay for internet packages.
- Issue secure vouchers only after verified payment.
- Allow customers to activate permitted devices and monitor their subscriptions.
- Enforce quota, expiry, and simultaneous-device limits on MikroTik.
- Give authorized staff operational, financial, customer, voucher, and network controls.
- Protect customer and administrator accounts with MFA and passkeys.
- Retain auditable, persistent production data.
- Support approximately 300 initial users across four buildings.

## 3. System scope

| Component | Production address | Responsibility |
|---|---|---|
| Customer portal | `https://portal.ndahiconnect.net` | Package selection, payment initiation, onboarding, login, voucher activation, devices, usage, and payment history |
| Admin dashboard | `https://admin.ndahiconnect.net` | Customers, vouchers, packages, payments, integrations, security, administrators, and audit records |
| Backend API | `https://api.ndahiconnect.net` | Authentication, business rules, payment verification, voucher issuance, integrations, and persistence |
| PostgreSQL | Render private network | Durable application state |
| Flutterwave | External provider | XAF MTN MoMo and Orange Money collection |
| Resend | External provider | Transactional voucher confirmation email |
| MikroTik bridge | Restricted on-site service | Voucher synchronization, quota enforcement, sessions, and disconnection |
| Omada controller | Restricted on-site service | Access-point and controller health visibility |

## 4. Architecture

The system is deployed as three isolated Node.js web services and one managed PostgreSQL database. The customer and admin frontends receive only the public API URL. All payment, email, router, controller, password, and signing secrets remain in the API environment.

The intended production flow is:

1. The customer selects a package and supplies a Cameroon Mobile Money number and email address.
2. The API creates a unique pending payment and initiates a Flutterwave charge.
3. The customer authorizes the request through MTN MoMo, Orange Money, or Flutterwave's required redirect flow.
4. Flutterwave sends a signed webhook to the API.
5. The API independently verifies transaction status, reference, amount, and currency.
6. The API creates a unique voucher and stores its subscription relationships.
7. The voucher is synchronized with the restricted MikroTik management bridge.
8. Resend emails the voucher and account-security link to the customer.
9. The customer enrolls TOTP MFA and a passkey, then manages access through the dashboard.

## 5. Implemented functionality

### 5.1 Customer experience

- Separate customer login, onboarding, and dashboard routes.
- Package catalogue retrieved from the backend API.
- MTN Mobile Money and Orange Money selection.
- Automatic opening of provider authorization when Flutterwave supplies a redirect.
- Polling for verified payment completion.
- Post-payment handoff to customer security enrollment.
- Voucher redemption using normalized codes.
- Active subscription, quota, expiry, payment, and device visibility.
- Customer-controlled device disconnection.
- TOTP authenticator enrollment and login.
- WebAuthn passkey enrollment and authentication.

### 5.2 Voucher management

- Fixed `NC-XXXX-XXXX` format.
- Eight cryptographically random uppercase alphanumeric characters.
- Exclusion of ambiguous `0`, `O`, `1`, `I`, and `L` characters.
- Database-backed uniqueness checks.
- Case-insensitive and hyphen-tolerant input normalization.
- No customer, package, price, or expiry information encoded in voucher strings.
- Transactional migration for legacy voucher codes.
- Preservation of existing status, usage, relationships, activation, expiry, and device limits during migration.
- Standard assigned vouchers and custom resale voucher batches.
- First-redemption activation for resale inventory.
- Voucher revocation and router disconnection.

### 5.3 Administration

- Dedicated admin application and authentication boundary.
- Named administrator accounts and role-based authorization.
- Operational dashboard metrics.
- Package creation, editing, and safe deletion rules.
- Customer suspension and restoration.
- Customer authenticator reset.
- Payment status and refund operations.
- Voucher inventory, generation, revocation, and email-delivery status.
- Manual retry of failed voucher emails.
- MikroTik usage synchronization and Omada connectivity checks.
- Tabbed navigation for cleaner operational workflows.
- Audit and security-event records.
- CSV reporting and voucher exports.

### 5.4 Payment processing

- Flutterwave is the sole production payment provider.
- Server-side Francophone Mobile Money charge initiation for XAF.
- MTN and Orange network mapping.
- Signed Flutterwave webhook validation.
- Independent transaction verification before voucher issuance.
- Amount, currency, reference, and duplicate-transaction protection.
- Idempotent voucher issuance when webhook events are repeated.
- No collection or storage of a customer's Mobile Money PIN.

### 5.5 Transactional email

- Resend API adapter for voucher confirmation.
- HTML and plain-text email bodies.
- Package, payment, quota, device-limit, expiry, voucher, and portal information.
- Provider idempotency keys to reduce duplicate sends.
- Persistent email status, attempt count, provider message ID, timestamps, and errors.
- Rate-limited automatic retries and an administrator retry action.
- Email failure does not reverse payment or deactivate the voucher.

## 6. Security controls

The implemented security model includes:

- Argon2id administrator password hashing.
- Separate password and MFA stages for administrator login.
- TOTP support compatible with Google Authenticator and similar applications.
- WebAuthn passkeys for customers and administrators.
- Hashed, opaque server-side sessions.
- Separate customer and administrator session cookies.
- `HttpOnly`, `Secure`, and appropriate `SameSite` cookie attributes in production.
- Exact-origin credentialed CORS rather than wildcard access.
- CSRF protection for authenticated production mutations.
- Login attempt throttling and temporary lockouts.
- Server-side role checks for all administrative actions.
- Security-event and audit logging.
- Backend-only provider, database, and network credentials.
- Signed webhook validation and transaction re-verification.
- Fixed request-size limits and API-only backend routing.

Recommended operational controls still include an administrator VPN or access proxy, encrypted backups, monitored secret rotation, centralized alerts, and periodic access reviews.

## 7. Infrastructure and deployment

The Render Blueprint defines:

- `ndahi-customer` web service.
- `ndahi-admin` web service.
- `ndahi-api` web service.
- `ndahi-postgres` managed PostgreSQL database.

The domain is managed through IONOS. The application subdomains point to their matching Render services:

```text
portal.ndahiconnect.net → ndahi-customer
admin.ndahiconnect.net  → ndahi-admin
api.ndahiconnect.net    → ndahi-api
```

The email sending subdomain is planned as:

```text
updates.ndahiconnect.net
```

Render environment variables separate public URLs from secrets. The repository contains one local `.env` file, which is excluded from Git and must never be copied into source control.

## 8. Verification and quality assurance

The automated suite currently contains 39 passing tests. Coverage includes:

- Plan catalogue and device-limit rules.
- Voucher format, randomness, uniqueness, and normalization.
- Legacy voucher migration and transactional rollback.
- Payment creation, webhook authentication, and transaction verification.
- Voucher issuance and redemption.
- Subscription stacking and daily-plan restrictions.
- Session, quota, device, and expiry enforcement.
- Customer authenticator throttling.
- Admin password and MFA separation.
- Customer/admin application isolation.
- CORS, cookie, and cross-role session controls.
- Administrative CRUD and audit operations.
- Router and Omada adapter behavior.
- Resend message content, idempotency, and failure handling.
- A 300-user concurrency and data-integrity harness.

The latest full automated execution reported 39 passes and no failures. Automated success does not replace live acceptance tests against approved payment rails, on-site controllers, real DNS, and representative customer devices.

## 9. Current status and blockers

| Area | Status | Notes |
|---|---|---|
| Customer portal | Implemented/deployed | Final live acceptance testing required |
| Admin dashboard | Implemented/deployed | Production account and passkey review required |
| API | Implemented/deployed | Final environment validation required |
| PostgreSQL | Provisioned | Backup and restore drill still required |
| DNS/TLS | Connected in principle | Confirm all certificates and redirects |
| Voucher system | Implemented and tested | Run production legacy migration once if applicable |
| Flutterwave integration | Implemented | **XAF payment method remains under Flutterwave review** |
| Live phone authorization | Blocked | Cannot be validated until XAF collection approval |
| Resend integration | Implemented | Domain/API-key verification and live delivery test required |
| MikroTik | Adapter implemented | Secure bridge and field validation required |
| Omada | Adapter implemented | Controller token and field validation required |
| Resend delivery webhooks | Not implemented | API acceptance is recorded; delivered/bounced/complained events are not yet reconciled |
| Monitoring and alerts | Partial | Production alerting and incident procedures required |

## 10. Key project risk

The immediate launch risk is external payment availability. Pending transactions and absent phone prompts are expected while XAF Mobile Money remains under review. The application must not manually mark these transactions as paid, because doing so would issue service without trusted provider verification.

Once approval is granted, all tests must use newly created payments. Old pending transactions should not be treated as evidence that the corrected live configuration is failing.

Additional risks include public exposure of on-site controller interfaces, incomplete backup verification, inadequate monitoring, email bounce handling, and premature removal of bootstrap safeguards.

## 11. Recommended next actions

### Launch-critical

1. Complete Flutterwave's XAF review and confirm live Cameroon MTN/Orange collections.
2. Verify that Render uses the live v3 Flutterwave secret key and matching webhook hash.
3. Perform a new low-value live payment and confirm phone authorization, webhook receipt, transaction verification, voucher issuance, and dashboard access.
4. Complete Resend SPF/DKIM verification for `updates.ndahiconnect.net` and perform an end-to-end voucher email test.
5. Connect MikroTik and Omada through a restricted HTTPS bridge or private tunnel.
6. Validate voucher synchronization, quota enforcement, simultaneous-device limits, expiry, and forced disconnects on real hardware.
7. Confirm PostgreSQL backups and perform a restore exercise.
8. Review all production environment variables, remove temporary credentials, and rotate exposed or shared secrets.
9. Set `BOOTSTRAP_MODE=false` only after every launch-critical integration passes.

### Immediately after launch

1. Add a signed Resend webhook for delivered, delayed, failed, bounced, suppressed, and complained events.
2. Add scheduled reconciliation of pending Flutterwave payments as a fallback to webhooks.
3. Add uptime, error-rate, payment-failure, email-failure, database, and network-controller alerts.
4. Place the administrator portal behind an access proxy, VPN, or explicit IP restrictions where practical.
5. Establish an incident-response and customer-refund procedure.
6. Define audit-log, payment, customer, and email-event retention periods.

## 12. Production acceptance criteria

NDAHI Connect should be considered ready for public launch only when:

- All three public hostnames have valid TLS and route to the intended services.
- Customer and administrator roots consistently lead to their login experiences.
- Live XAF Mobile Money authorization works on both supported networks.
- Successful payment creates exactly one voucher and one customer entitlement.
- Failed, canceled, or unverified payment creates no voucher.
- Voucher email is delivered to a real mailbox.
- TOTP and passkey enrollment succeed on production hostnames.
- MikroTik enforces quota, expiry, and device limits.
- Omada and hotspot health are observable by administrators.
- Database backup restoration has been demonstrated.
- Monitoring and operational ownership are assigned.
- No mock adapters, placeholder credentials, or insecure production URLs remain.

## 13. Conclusion

NDAHI Connect has progressed from a functional pilot into a substantially production-oriented platform with separated services, secure authentication, persistent data, opaque vouchers, verified-payment controls, transactional email, network adapters, administrative workflows, and automated quality checks.

The application software is largely complete for the initial deployment scope. Production launch is presently dependent on Flutterwave XAF approval and final validation of Resend and the on-site network integrations. Completion of the launch-critical checklist will convert the current pre-launch deployment into an operational student internet service.
