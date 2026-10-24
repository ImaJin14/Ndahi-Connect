# Background delivery (#139)

This extends the existing notification history, saved Account preferences,
per-subscription delivery leases and 15-second server worker. No dashboard tab is
needed to dispatch Web Push. No new delivery service, provider or credentials are
assumed. Configure all existing `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` and
`WEB_PUSH_SUBJECT` together; without them the inbox remains available.

## Events, privacy and authority

Confirmed paid ownership creates a voucher-ready history/push event only after
its durable voucher exists. Exact processed router connection and disconnection
results produce historical transition notices; queued intents and superseded
sessions do not establish a connection. These notices describe the recorded time;
Dashboard still reads fresh network evidence. Existing payment/refund, security,
low-data (positive <=2 MB), selected usage thresholds, opt-in one-hour expiry and
expired/exhausted subscription notices share the same history/preferences.

Consent/category/source/read/archive/current subscription and account/admin
role checks run again after a committed delivery claim. Push dispatch is bounded
to recent events. Subscription fingerprints use ordered scalar fields, so
PostgreSQL JSONB key ordering cannot fork leases. Existing sent/backoff records
with either prior key order are imported rather than replayed. 404/410 endpoints
are removed by full subscription fingerprint, retaining replacements with new
keys. Existing limits/backoff and stable provider topics bound lost-ack retries.

Push payloads contain generic summaries, opaque event identity and only an
allowlisted Dashboard fragment. Both workers reject malformed/external/query or
credential-bearing deep links without throwing. The destination authenticates;
clicking a notification never supplies credentials or approves Wi-Fi access.
Push permission is requested from an explicit button only, skipped when already
granted, and never repeatedly requested after denial. Unsubscribe removes server
consent before the browser subscription. Push/email failure cannot roll back a
payment, activation or router command.

## Email fallback

Account has a separate **Email data and expiry alerts when browser push is
unavailable** checkbox, off by default. It requires an explicitly verified current
mailbox (legacy unverified association alone does not enable this new channel),
usage category/threshold preferences and a current unread/unarchived notice.
It covers current low-data/usage and expiry notices when push is unconfigured,
not enabled, has no subscriptions, or all relevant endpoints have terminal
failure. Pending/retrying/accepted push does not trigger a second email channel.
Provider acceptance is not an OS delivery receipt; this fallback cannot detect a
phone silently suppressing a successfully accepted push. Payment/voucher,
activation and security mail stay in #141's dedicated consent-aware outboxes.

The fallback reuses #141's committed email leases, verified-recipient recheck,
23-hour/five-attempt bounds and stable provider key. Low-data readings older than
two minutes and superseded allocations are cancelled. Recipient/consent changes
between claim and send cancel delivery; a provider outage leaves repeatable
portal history and never blocks account use. At-least-once transport can still
duplicate a notification after an unknown provider acknowledgement. Browser tag/
provider topic and email idempotency reduce duplicates, without promising exactly
once arrival or alerts at an exact remaining balance.

## Verification and remaining acceptance

New worker/API tests cover committed/rolled-back voucher identity, connection
proof, PostgreSQL key order and legacy identities, independent-worker leases,
consent/recipient changes, unavailable/accepted/retrying push, expired readings,
scoped preference saves and malicious worker links. A real PostgreSQL test covers
rollback, independent-store concurrency and reopen/deduplication. Browser journeys
at 320/1280 px cover persistent fallback consent, explicit granted permission,
unsubscribe and server dispatch after closing the dashboard. Existing denied/
unsupported permission, full worker/retry/security and in-app history tests remain
in CI. Browser transport is synthetic, not real phone delivery.

Before release, verify configured VAPID/provider acceptance and physical Android,
iOS/iPadOS Home Screen (where supported), Windows/desktop closed-app delivery,
OS restrictions, offline → online delivery before TTL, opt-out, expired endpoints
and verified email inbox/spam placement. Record provider acceptance separately
from device display/read/click. No such physical/provider results, merge or
deployment are claimed here. See [WebKit Web Push guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
and [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).
