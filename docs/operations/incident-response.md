# Incident response and ownership (DEP-006)

This is the procedure for payment, security, database and network incidents: who responds,
how far to escalate, what to do first, and how to tell customers. Severity response times
are **proposed** until the product owner agrees them.

Named people are kept in one place: the responder roster in
[service monitoring](service-monitoring.md#responders). Vendor contacts are below. **Both must
be filled in before launch; until then every escalation path ends at the product owner.**

## Severity

| Severity | Examples | Acknowledge | Customer update | Review |
| --- | --- | --- | --- | --- |
| SEV1 | Most customers cannot buy, connect or sign in; paid customers left without access; confirmed security compromise or data exposure; possible data loss | 15 min, day or night | Within 30 min, then every 30 min | Within 5 working days |
| SEV2 | One payment provider, the email service or one site failing; provisioning delayed; suspected compromise; backups failing; any critical alert without the SEV1 impact | 1 h during the day, 15 min at night if paging | When customers are affected | Within 5 working days |
| SEV3 | A warning alert with no current customer impact; a single customer's issue | Next working day | Not needed | Optional |

Any critical alert is at least SEV2. When in doubt, declare the higher severity; it can be lowered.

## Roles

- **Incident lead:** by default, the first responder from the owning role. Coordinates,
  makes the containment decisions, keeps a timeline, and hands over explicitly if needed.
- **Responders:** the owning role from the table below, plus anyone the lead pulls in.
- **Product owner:** final escalation. Approves customer messages for SEV1, decisions about
  money (refunds, credits), and any legal or regulatory notification.

## Escalation paths

Escalate when the step's time passes without acknowledgement or mitigation, or immediately
when the "escalate now" condition applies.

| Incident type | 1. First responder | 2. Backup | 3. Product owner | Escalate to the product owner now if | External |
| --- | --- | --- | --- | --- | --- |
| Payment | `payments-owner` | after 15 min (SEV1) / 1 h | after 30 min unmitigated | Money taken without service for any customer, suspected duplicate charges, or a provider dispute | MeSomb or Flutterwave support |
| Security | `security-owner` | after 15 min | immediately on any confirmed compromise | Data exposure, administrator compromise, or a leaked secret | Render support; legal counsel through the product owner |
| Database | `platform-on-call` | after 15 min | after 30 min down, or at once if data may be lost | Possible data loss, corruption, or a restore | Render support |
| Network | `network-operations` | after 15 min (SEV1) / 1 h | after 1 h down, or all sites affected | Every site down, or vouchers not enforced | On-site technician, uplink provider, power |
| API, email, monitoring | `platform-on-call` | after 15 min (SEV1) / 1 h | after 30 min unmitigated | Customers cannot receive vouchers or reset PINs | Resend, Render support |
| Portal speed (Web Vitals) | `frontend-owner` | next working day | after a week unresolved | — (SEV3 unless pages stop loading, which the availability objective pages) | — |

Responders work in their role's alert channel; the incident lead posts the start, each
decision and the resolution there so the timeline is reconstructable.

## Payment incidents

**Signals:** `NdahiPaymentProviderDown` / `Errors`, `NdahiWebhookDeadLetters`,
`NdahiPaymentsNeedReview`, a `payment_completion` burn alert, `payment.provider_failed` logs,
or a customer reporting a charge without a voucher.

1. **Contain.** Payments cannot be marked paid by hand; the API only settles provider-verified
   payments. Checkout retries never resend an uncertain charge, so a provider outage does not
   cause double charges on its own. Publish a `degraded` status (see
   [customer communication](#customer-communication)). If the provider itself is charging
   wrongly and checkout must stop, there is no checkout-only switch: use an
   [emergency control](#emergency-controls) that stops the API.
2. **Diagnose.** Trace one affected purchase by its checkout request ID
   ([tracing a request](logging.md#tracing-a-request)). Check the provider's status page.
3. **Recover.** Replay failed provider events under Payments → Webhook recovery once the cause
   is fixed ([webhook recovery](payment-webhook-recovery.md)); review reconciliation findings
   ([payment reconciliation](payment-reconciliation.md)); handle refunds and payments needing
   review under Payments ([billing experience](billing-experience.md)).
4. **Escalate.** Give the provider the provider references and amounts only, never customer
   PINs, voucher codes or full phone numbers unless their verified process requires them.

## Security incidents

**Signals:** `NdahiAdminLoginAttack` / `Failures`, `NdahiCustomerLoginFailuresHigh`,
`NdahiSecurityAlertBacklog`, a secret-scanning or CodeQL finding, unexpected audit-log
entries (for example `admin.authorization.denied` or configuration changes), or a customer
reporting an unknown session.

1. **Contain**, depending on what happened:
   - **Leaked secret:** rotate it with the [secret rotation runbook](../security/secret-rotation-runbook.md).
     For a leaked `CUSTOMER_SESSION_SECRET` or `ADMIN_SESSION_SECRET`, skip the overlap period
     so existing sessions end immediately. Rotate `SECRET_PEPPER` with the normal overlap.
   - **Compromised administrator:** an owner deactivates the account, which ends its sessions
     at once and blocks further sign-in (see [deactivating an administrator](#deactivating-an-administrator)).
     If an owner account itself is compromised, or the attacker may have created other
     sessions, also end every administrator session by replacing `ADMIN_SESSION_SECRET` in
     Render with a new random value of at least 32 characters, without setting
     `ADMIN_SESSION_SECRET_PREVIOUS`, and deploy. Then review the audit log for that account's
     actions. Deactivation cannot be undone; give the person a new account with new credentials.
   - **Compromised customer account:** in Admin, suspend the customer (this disconnects their
     active vouchers) and reset their authenticator; ask them to use "Log out everywhere" and
     reset their PIN.
   - **Login attack:** edge rate limits already throttle by client address; confirm `throttled`
     responses on the service dashboard. If the attack continues, contact Render support, which
     operates the edge in front of the services.
2. **Preserve evidence** before retention removes it: export the audit log and security events
   covering the incident ([data retention](data-retention-policy.md)). Do not delete accounts
   or records involved.
3. **Escalate.** Any confirmed compromise or data exposure goes to the product owner at once.
   Whether customers or authorities must be notified is decided by the product owner with legal
   counsel; the breach-notification procedure is PRIV-004 and is not yet defined.

## Database incidents

**Signals:** `NdahiDatabaseUnavailable`, `/api/health` returning 503, `api.readiness_failed`
logs, a backup-failure alert, or `NdahiMonitorStale`.

1. **Diagnose** from the readiness code in the logs (missing schema, authentication, connection
   limit, timeout); see [API deployment readiness](api-deployment-readiness.md#diagnostics).
   Check the database's status in Render.
2. **Contain.** The customer-facing status is stored in the database, so it cannot be changed
   while the database is down; use the other channels in
   [customer communication](#customer-communication). If data looks corrupted, stop writes by
   suspending the API service before anything else.
3. **Recover.** Restore connectivity or apply missing migrations through the documented
   backup/write-pause procedure. If data must be restored, follow the
   [restore drill](postgres-restore-drill.md) (target RPO 26 h, RTO 2 h). The drill has not yet
   been rehearsed (DATA-005); involve the product owner before restoring.
4. **Backups.** A failed nightly backup is SEV2 until the next one succeeds
   ([backup runbook](postgres-backup-runbook.md)).

## Network incidents

**Signals:** `NdahiRouterUnreachable` / `Errors`, `NdahiNetworkCommandBacklog` /
`DeadLetters`, `NdahiOmadaUnreachable`, a `voucher_provisioning` or `network_enforcement`
burn alert, `bridge.operation_failed` logs, or customers unable to connect.

1. **Contain.** Vouchers already on the router keep working, and each one's expiry guard runs
   on the router even when the API cannot reach it. New purchases do not reach the hotspot until
   the bridge is back. Publish a `degraded` or `offline` status.
2. **Diagnose** in this order: on-site power and UPS, uplink, VPN or tunnel to the bridge, the
   bridge service, then the router. Bridge logs carry the same `correlationId` as the API.
3. **Recover.** Router commands retry on their own with backoff of up to an hour. Replay
   dead-lettered commands under Connections → Network commands once the cause is fixed
   ([router dead letters](router-command-dead-letter.md),
   [command queue](router-command-queue.md)), then let reconciliation report remaining drift
   ([router reconciliation](router-reconciliation.md)).

## Customer communication

The portal shows a service status on the login, onboarding and dashboard pages: `online`,
`degraded`, `offline` or `maintenance`, with an optional note of up to 500 characters on the
dashboard. Owners and operators can change it; every change is audited. There is no admin
screen for it yet, so from the signed-in admin page open the browser console and run:

```js
const api = window.NDAHI_CONFIG.apiUrl;
const { csrfToken } = await (await fetch(`${api}/api/admin/dashboard`, { credentials: "include" })).json();
await (await fetch(`${api}/api/admin/zone`, {
  method: "POST", credentials: "include",
  headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
  body: JSON.stringify({ status: "degraded", notes: "Mobile money payments are delayed. You will not be charged twice." }),
})).json();
```

| Severity | Status | Note |
| --- | --- | --- |
| SEV1, service unusable | `offline` | What is affected, what customers should do, when the next update is due |
| SEV1 or SEV2, partly working | `degraded` | Which part is affected; reassure about charges when payments are involved |
| Planned work | `maintenance` | Start and expected end |
| Resolved | `online` | Clear the note |

Do not promise a restoration time you cannot meet. When the database is down the status
cannot change; post updates on the business's other channels instead. Customer-facing outage
information is planned in SUP-004.

## Emergency controls

| Control | Effect | How | Who |
| --- | --- | --- | --- |
| Service status | Customers see the incident on the portal | Console call above | Owner or operator |
| Suspend customer, revoke voucher, disconnect device | Ends one customer's access | Admin | Owner or operator |
| Deactivate an administrator | Ends that administrator's sessions and blocks sign-in; cannot be undone | Console call below | Owner |
| Replay provider events or router commands | Retries after the cause is fixed | Admin → Payments / Connections | Owner or operator |
| End all administrator or customer sessions | Everyone must sign in again | Replace `ADMIN_SESSION_SECRET` or `CUSTOMER_SESSION_SECRET` in Render with no `_PREVIOUS` value, then deploy | Platform responder |
| Stop all API operations | Operational endpoints return 503; health and status keep working | Commit `BOOTSTRAP_MODE: "true"` for the API in `render.yaml` and deploy. A dashboard-only change fails the pre-deploy environment check | Platform responder, with the product owner |
| Take a service offline at once | Everything on that service stops, including health checks | Render dashboard → service → Suspend | Platform responder, with the product owner |
| Roll back a release | Returns to the previous build | Render dashboard → Events → Rollback; full procedure is DEP-004 | Platform responder |

### Deactivating an administrator

There is no admin screen for this yet. From the signed-in admin page, an owner runs this in
the browser console. It refuses the owner's own account, and the change is audited:

```js
const api = window.NDAHI_CONFIG.apiUrl;
const dashboard = await (await fetch(`${api}/api/admin/dashboard`, { credentials: "include" })).json();
const target = dashboard.administrators.find((a) => a.username === "<username>");
await (await fetch(`${api}/api/admin/users/deactivate`, {
  method: "POST", credentials: "include",
  headers: { "content-type": "application/json", "x-csrf-token": dashboard.csrfToken },
  body: JSON.stringify({ userId: target.id }),
})).json();
```

## After the incident

Every SEV1 and SEV2, and every error-budget fast-burn page
([error-budget policy](service-level-objectives.md#error-budget-policy)), gets a blameless
review within five working days. Save it as `docs/incidents/YYYY-MM-DD-short-name.md`:

```markdown
# <Title> (<SEV>)

- Detected: <time, and how: alert, customer report, …>
- Resolved: <time>; customer impact for <duration>
- Lead: <name>; responders: <names>

## Impact
Customers affected, payments or vouchers affected, money at risk, data affected.

## Timeline
Times (UTC) of detection, escalations, decisions, mitigation and resolution. Link log
searches by `correlationId` where useful.

## Cause
What failed and why it was possible.

## What went well / what was hard

## Actions
| Action | Owner | Due |
```

## External contacts

Fill these in before launch, and keep account credentials in the team's password manager,
never in this file.

| Provider | Used for | Support contact | Account owner |
| --- | --- | --- | --- |
| MeSomb | Mobile money payments | _To be filled_ | _To be filled_ |
| Flutterwave | Standby payment provider | _To be filled_ | _To be filled_ |
| Resend | Voucher, receipt, alert and PIN-reset email | _To be filled_ | _To be filled_ |
| Render | API, portal, admin, PostgreSQL, cron jobs | _To be filled_ | _To be filled_ |
| IONOS | DNS for `ndahiconnect.net` | _To be filled_ | _To be filled_ |
| Cloudflare R2 | Encrypted backups | _To be filled_ | _To be filled_ |
| Uplink provider | Site internet | _To be filled_ | _To be filled_ |
| On-site technician | Router, access points, power | _To be filled_ | _To be filled_ |

## Known gaps

These limit containment today and are tracked as follow-ups:

1. No way to pause checkout without stopping the whole API.
2. No admin screens for the service status or for deactivating administrators (console
   procedures above; see WISP-004, SUP-004 and ADMIN-002).
3. The database restore has not been rehearsed (DATA-005).
4. Named responders and vendor contacts are not yet filled in.
