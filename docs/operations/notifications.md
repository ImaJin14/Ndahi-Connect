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
prioritizes outstanding actions and returns at most 100 recent items; domain
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
