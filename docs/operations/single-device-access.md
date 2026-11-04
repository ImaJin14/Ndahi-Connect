# Device access follows the purchased bundle

The shared server capability derives from the current usable voucher's issued
`deviceLimit`, expiry and remaining quota. Custom and previously purchased bundles
follow the same rule. Online counts and catalogue defaults do not grant main-device
privileges. Suspended accounts and unavailable bundles have no main-device setup.

A one-device bundle uses signed-in owner connection and fresh router identity.
First access connects directly. Returning owners use saved device approval or
ordinary PIN/passkey ownership proof when connecting an unapproved device. They do
not select or recover a main controller or compare a code/QR. Private router
passwords and authenticated ownership remain required. An occupied slot shows its device name and an explicit **Switch connection to this
device** action. Fresh PIN/passkey proof binds the purchased voucher, target router
identity and exact old MAC/session/start time. The transaction reserves one switch
and queues both an exact-session disconnect and a dependent connection. The slot
stays occupied until the router confirms `disconnected` or `absent`; failures and
`superseded` outcomes cannot admit the replacement. Concurrent requests cannot
reserve it twice. Paid quota and expiry are unchanged.

Workers recheck owner session/PIN version, current purchased entitlement, network,
quota, expiry and capacity. Delayed removal cannot target a newer router session.
New `wifi_single_disconnect`/`wifi_single_connect` command kinds are ignored by older
workers. A current complete device observation is required at admission/execution;
a targeted connect/disconnect does not refresh observations of other sessions.

Multi-device bundles retain first-main setup, controller-bound matching approval,
saved reconnects, manual addition and owner recovery. Both API requests and queued
approval execution check the current purchased entitlement. Old setup/review links
cannot establish main authority for a one-device bundle. Existing registration is
retained so valid control can be reused after an eligible upgrade.

#165 and #166 are reviewed separately and must release together. API/domain and
synthetic-router browser coverage is distinct from physical phone/router acceptance.
No merge, production deployment or physical verification is claimed by this note.
