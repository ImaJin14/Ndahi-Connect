# NDAHI Connect external penetration-test brief

Status: Ready for independent assessor engagement  
Prepared: 2026-09-08  
Test standard: OWASP ASVS 5.0, OWASP WSTG, and OWASP API Security Top 10 2023

## Objective

Independently assess whether an attacker can obtain connectivity, customer data, payment state, administrator authority, or control-plane access beyond their authorization. The assessor must be organizationally independent from the implementation team and must deliver a written report plus a remediation retest.

## In-scope systems

- Customer portal: `https://portal.ndahiconnect.net`
- Administrator portal: `https://admin.ndahiconnect.net`
- API: `https://api.ndahiconnect.net`
- Customer PIN, voucher, Google Authenticator, passkey, PIN-reset, and session flows
- Administrator password, MFA, passkey, roles, CSRF, session, and audit flows
- Voucher generation, resale, redemption, device limits, expiry, disconnect, renewal, and switching
- MeSomb and Flutterwave checkout, callbacks/webhooks, idempotency, refunds, and voucher issuance
- Resend email delivery and reset-link handling
- API authorization, object/property authorization, input validation, rate limits, resource exhaustion, CORS, CSP, and error handling
- RouterOS and Omada server-side adapters, management-bridge trust boundaries, credential exposure, command authorization, and failure behavior
- PostgreSQL persistence, concurrency behavior, exported data, logs, and secret-handling boundaries

Source-assisted review is permitted for this repository and its deployment configuration. Provider internals, Render infrastructure, Cloudflare infrastructure, mobile-money networks, customer devices, and unrelated NDAHI systems are excluded unless separately authorized in writing.

## Required test coverage

1. Map all routes, roles, identifiers, trust boundaries, and sensitive data flows.
2. Test broken object- and function-level authorization across customer, reseller, operator, auditor, and owner roles.
3. Test authentication enumeration, brute force, distributed guessing, lockout bypass, challenge replay, session fixation, token rotation, logout, and recovery abuse.
4. Test voucher guessing, reassignment, stacking, quota/device bypass, race conditions, replay, and activation/expiry manipulation.
5. Test payment amount/reference substitution, unsigned or replayed webhooks, duplicate fulfillment, refund authorization, delayed callbacks, and provider/API response tampering without initiating unauthorized real charges.
6. Test XSS, injection, request smuggling indicators, SSRF, path traversal, unsafe file/content handling, mass assignment, and excessive data exposure.
7. Test CSRF, CORS, cookie scope, security headers, CSP bypass, clickjacking, caching, TLS configuration, and origin/proxy-header spoofing.
8. Test rate-limit behavior from multiple sources without creating a denial of service.
9. Review secrets, logs, CI/CD controls, Render configuration, database access, RouterOS/Omada privileges, and external-service failure modes.
10. Confirm security events and audit records contain useful evidence without leaking credentials or unnecessary personal data.

## Rules of engagement

- Prefer an isolated staging environment containing synthetic customers, vouchers, payments, and devices. Production testing requires a separately signed window and named incident contact.
- The client supplies dedicated accounts for customer, reseller, operator, auditor, and owner roles plus synthetic vouchers and provider sandbox credentials.
- No social engineering, physical intrusion, DDoS/stress testing, malware, persistence, destructive database actions, credential reuse against third parties, or tests against real customers.
- Do not access, alter, download, or retain real customer records. Stop immediately if real personal data or a live secret is exposed.
- Mobile Money tests use sandbox/test modes or an explicitly capped operator-owned account. No refund, charge, or webhook test may target an uninvolved person.
- RouterOS and Omada tests use an isolated lab site or a specifically approved device and window. Do not interrupt public connectivity.
- Rate testing must stay within the agreed request ceiling. Any higher-volume test requires written approval and live operator monitoring.
- Report critical evidence through the agreed encrypted channel immediately. Do not place secrets or exploitable evidence in email, chat, or public issue trackers.
- The assessor may demonstrate impact only to the minimum degree needed for proof and must remove created data and credentials at the end of testing.

## Stop conditions and contacts

Before testing, the client must fill in the engagement owner, technical contact, emergency phone, approved source IPs, dates/times with timezone, request ceiling, staging URLs, and encrypted reporting channel. Testing stops on service instability, real-data access, unexpected charges, network interruption, scope ambiguity, or a request from the incident contact.

| Required engagement value | Value |
| --- | --- |
| Engagement owner | To be assigned |
| Technical contact | To be assigned |
| Emergency/stop contact | To be assigned |
| Testing window and timezone | To be assigned |
| Approved source IPs | To be assigned |
| Maximum request rate | To be assigned |
| Test environment | To be assigned |
| Encrypted reporting channel | To be assigned |

No testing authorization exists until every value is completed and both parties approve the rules in writing.

## Deliverables and acceptance

The assessor must provide:

- Executive summary, methodology, dates, targets, source IPs, tooling, and limitations
- Finding identifier, affected component, severity and scoring rationale, reproducible steps, evidence, impact, and remediation guidance
- Explicit coverage matrix mapped to this brief, OWASP ASVS 5.0, WSTG, and API Security Top 10 2023
- Separate inventory of untested or partially tested areas
- Immediate notification for critical findings
- Evidence-handling and data-deletion confirmation
- Retest report showing the status of every critical and high finding

SEC-009 is accepted only when the independent report is received, every critical/high finding is resolved or formally risk-accepted by the product owner with an expiry date, and the assessor confirms the fixes in a retest.

## Assessor selection checklist

- Demonstrated web/API, payment, WebAuthn, and network-control-plane testing experience
- Named testers and a clear statement of independence and conflicts
- Professional liability coverage and secure evidence-handling practices
- Sample report with reproducible technical findings and useful executive reporting
- Written scope, fixed deliverables, retest terms, disclosure terms, and data-deletion commitment
- References for comparable customer portals or connectivity/payment systems

Obtain at least two comparable proposals. Evaluate scope and tester quality before price; automated vulnerability scanning alone does not satisfy this engagement.
