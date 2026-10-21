# Portal and administration notifications

A bell beside Logout opens the inbox in each signed-in app. It offers Unread,
Action required, All and Archived views, category filtering, Mark all read,
individual read/archive/restore actions and Settings. Action items stay visible
when read and cannot be archived until resolved. Security and action-required
items stay visible even if a category is muted. Request approval still requires
the main controlling browser; the bell links to device controls and never returns
approval codes itself.

Customer items come from device requests/setup, payment/refund state, data-usage
thresholds, expired/exhausted bundles, security notices and service status. Owners
and operators see grouped router failures/recovery and payments/refunds requiring
review; owners also see recorded support recovery and administrator security
activity. Other roles receive public service status and can manage only their
own notification preferences/read state. Review links use the authenticated
`/dashboard` routes.

Items are derived from durable domain records and deduplicated by source ID.
Changed source state updates the item and makes its new version unread. The inbox
prioritizes outstanding actions and returns 25 items per page (API limit 1–100); domain
retention limits the available history (pairing requests, for example, last seven
days). Full operation/audit records remain in their existing views. Per-person
read, archive and preference records live in the normalized `events` table as
`notification_state`; changing browser or signing in again retains them. Staff
read state is per administrator, not shared globally.

## Delivery settings

The in-app inbox works without browser notification permission. Both apps can
opt in to generic activity push on each device when all existing `WEB_PUSH_*`
settings are configured. Enabling requests permission from a user gesture,
registers the site's service worker and validates/stores the subscription.
Disabling on this device removes that subscription; the account preference can
also pause activity push to all subscribed devices. Unsupported browsers retain
the in-app inbox.

Activity pushes contain generic text and a same-origin app link, never pairing
codes, vouchers, customer phone numbers or device names. Delivery rechecks current
recipient access/consent, uses short leases and per-subscription version records,
retries with backoff, and removes expired subscriptions. Delivery is deduplicated;
a provider accepting a push before its reply is lost can still cause a repeated
notification. Opening a push never approves a device or changes account state.
The existing usage-alert worker runs activity delivery on its normal schedule.

Customers can separately control data-usage push and security email. Email still
requires a confirmed linked address. These preferences govern delivery; security
notices remain available in the portal. Existing opt-in usage push retains its
quota summary. Activity pushes begin with new events after opt-in, without
replaying the whole historical inbox.

The bell refreshes every ten seconds while the page is visible, pauses automatic
rendering during settings edits and restarts after browser Back/restore. Dialog
focus is trapped, Escape/backdrop/Close restores focus to the bell, and filters
and settings have explicit accessible names. An unavailable inbox does not
redirect or replace the main application.

## Validation and rollout

Deploy API and both frontends together. No new email/push provider or SQL schema
migration is required. Automated API tests cover customer isolation, staff roles,
CSRF, persisted read/preferences, state changes/expiry, grouped alerts and push
leases/deduplication. Browser journeys exercise both bells at 320px, settings
persistence and focus restoration alongside the first-device and access flows.
Real browser push delivery, email-provider delivery and physical-device behavior
remain deployment checks; local tests use synthetic accounts and fake providers.

## Shared delivery lifecycle (#62)

Activity and data-usage push now share `lib/notification-delivery.mjs`. Each
recipient/source/version/subscription-key combination owns a durable attempt
record in `notificationStates`. A thirty-second lease fences concurrent workers;
provider I/O runs outside the transaction with a ten-second socket timeout.
Expired leases recover after restart. Attempts use exponential backoff from one
minute, stopping after five activity attempts or three usage attempts. One
successful subscription no longer hides a different device's failed delivery.

Claim and pre-send checks reread the source version, current customer/staff
status/role, categories, delivery consent and exact subscription keys. Expired,
replaced or superseded usage warnings are cancelled. A provider's 404/410 removes
only the exact expired subscription, preserving a replacement at the same
endpoint. Legacy sent activity records retain deduplication after upgrade. In-app
read/archive state still changes no business action; category muting can hide
routine history while action/security items remain visible, and suppresses push.

A send accepted before its response is lost may be retried. Stable provider
`topic` and browser notification `tag` coalesce repeat delivery where supported;
this is bounded at-least-once delivery, not an exactly-once guarantee. Consent can
change after the final check while a request is already in flight; that accepted
push cannot be recalled. Short TTLs limit delayed messages. Pushes contain generic
activity text or quota summaries, no account credentials; their same-origin links
only navigate to authenticated app pages. Tapping an existing portal window now
navigates to the requested section before focusing it.

Permission is requested only from **Enable on this device**. Denial, unsupported
push, unavailable provider configuration and offline errors leave the inbox
usable. Synthetic browser checks cover permission gestures, denied/unsupported
states and subscription removal; they do not prove real provider delivery. The
service-worker handlers are also exercised independently for display, same-origin
navigation and deep links. Real browser/phone push acceptance remains pending.

Deploy all API workers together or drain the older usage worker first: an older
release does not understand per-subscription leases. No SQL schema change is
required. Rollback to an old worker can lose partial-delivery deduplication; do
not treat aggregate alert status as proof that every device received it.

## Centre filters and history (#55)

Both apps provide All, Unread, Action required and Archived views, readable
category names and inclusive **From / Through (UTC)** date filters. Customer
categories cover devices/access, security/sign-ins, data/bundles, payments/refunds
and service. Staff categories follow current permissions: owners see all staff
categories; operators see network, payments and service; auditor/reseller views
are limited to service. Delivery preferences and stored read/archive versions
carry forward.

Filtering happens before pagination over retained, scoped source records. Older
matching items are reachable with Next/Previous, including records beyond the
previous 100-item cap. Stable keyset cursors bind recipient, filters and page
size; equal timestamps use the source ID as a tie breaker. A changed source is a
new version and may move in this live history; refreshing the first page reveals
newer activity. Cursors are navigation hints, never authorization.

Mark all read applies to every matching item across pages, without approving,
resolving or archiving its business action. The badge counts unread items across
all filters. Applied filters survive automatic refresh and temporary errors;
loading, empty and unavailable states retain the main app. An always-available
Refresh control retries initial failures. Settings/date edits avoid background
DOM replacement and keyboard focus is restored after updates/close. Legacy API
calls without a view keep archived visibility for compatibility; the app always
requests an explicit view.

Seven API regressions cover history boundaries, ties/inserts, date/category
combinations, invalid cursors, cross-customer/staff access and cross-browser
state. Real-API browser journeys exercise both apps at 320px through multiple
pages, date filtering, temporary outage/retry and focus restoration. Deployment
and physical-device accessibility acceptance remain pending.

## Security and sign-in history (#59)

Account keeps authenticator/passkey/PIN configuration and **Active sessions** with
sign-out controls. Historical security cards and recent sign-ins now appear only
in Notifications → Security / sign-ins. **View security history** opens that
filter; **Review sessions** opens and focuses the authenticated session controls.
Legacy dashboard/security API fields remain for older clients.

Each completed account session records one PIN, passkey, authenticator, recovery
code, voucher-account or initial-setup event in the same transaction as session
issuance. Page loads, heartbeat refresh and guest Wi-Fi approval do not record
account sign-ins. New sign-in response cookies wait for storage commit. Existing
security notices remain visible even when email/push delivery is disabled.

A random HttpOnly/SameSite browser cookie provides a recognition hint. Only its
customer-specific peppered hash enters retained audit metadata; raw tokens never
appear in inboxes, logs or URLs. An absent/unrecognized cookie causes an
unrecognized-browser notice. Matching retained history makes routine sign-ins
quiet in-app entries; recovery-code sign-ins always qualify for optional security
delivery. This hint never authorizes anything, attests hardware or proves
location. Clearing cookies or history can cause another unrecognized notice.

Sign-in history reports available user-agent and IP data with that limitation.
Generic push omits those details and all credentials. Security email uses the
existing confirmed-address/preferences worker. A sign-in's delivery notice and
audit event share one inbox identity, including when older audit rows are trimmed;
reading/archiving cannot revoke a session or change authentication factors.

Nine API regressions cover actual sign-ins, replay, browser recognition,
unauthorized reads, rollback, quiet/muted delivery and retained identity. Browser
journeys cover the centre/session link at 320px and a real WebAuthn credential
registration followed by passkey account sign-in. Deployment, real email/push
providers and physical phone acceptance remain pending.

## Operational incidents (#56)

Router command failures for the same saved router revision, operation and coarse
problem class update one durable incident. First/latest failure times and an
occurrence count reflect actual attempts; polling and duplicate completion
records add nothing. Retry counts do not reset read status or repeat push.
Dead-letter escalation and meaningful open/recovering/resolved transitions update
the notification version. A later failure after confirmed closure gets a new ID.

Sources include bundle synchronization/removal, usage readings and scoped device
removal. Ordinary guest access-request outcomes remain device notifications;
a denied/expired request alone is not evidence of a router outage. Successful
routine polls, heartbeats and page loads create no operational incident.

| Outcome | Notification | Operator action |
| --- | --- | --- |
| Failed attempt with automatic retry | Warning, one grouped item | Observe retry; inspect if needed |
| Dead-lettered work | Action required, stays visible when read | Review scoped commands and existing authorized recovery controls |
| Manual replay queued | Recovering; success remains unconfirmed | Await actual router result |
| All related work confirmed | Resolved/recovered | Retain history |
| An obsolete/superseded operation closed | Work closed | Check current state; this does not prove router recovery |

One successful command cannot hide another unresolved group member. Commands
whose failure class changes remain associated with both unresolved problems until
actual completion. Closed summaries retain their completion snapshot when a queue
ID is reused. All unresolved incidents and the most recent 200 resolved summaries
are retained; full queue/audit records keep their existing lifecycle.

Owner/operator entries link to an authenticated incident detail view with up to
100 related command records, including completed history. Existing replay and
obsolete-resolution endpoints retain their role, CSRF and scope checks. Merely
opening, reading or archiving an incident performs no command. Other staff roles
cannot access private incident details. Affected customers see account-scoped
service impact and a connection-status link, without another customer's details.
Stale usage readings are not presented as confirmed internet failure.

Summaries use fixed problem classes and exclude raw error messages/credentials.
Phase transitions create audit entries in the same queue transaction. The new
`operationalIncidents` collection uses the existing normalized `events` table
with its own kind; no SQL migration is required. Deploy compatible API/network
workers together so every queue completion updates incident state. Older workers
can finish a command without updating its incident, leaving stale summaries until
compatible processing resumes; do not infer recovery from missing queue work.

Nine incident regressions cover grouping/counts, concurrent attempts, lifecycle,
new episodes, partial recovery, privacy/scope, rollback and push suppression.
Normalized PostgreSQL restart/rollback coverage runs in CI. Real-API 320px checks
exercise incident review, command history and confirmed recovery. Deployment and
physical-router/provider acceptance remain pending.
