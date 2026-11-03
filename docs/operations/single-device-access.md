# Device access follows the purchased bundle

The shared server capability derives from the current usable voucher's issued
`deviceLimit`, expiry and remaining quota. Custom and previously purchased bundles
follow the same rule. Online counts and catalogue defaults do not grant main-device
privileges. Suspended accounts and unavailable bundles have no main-device setup.

A one-device bundle uses signed-in owner connection and fresh router identity.
First access connects directly. Returning owners use saved device approval or
ordinary PIN/passkey ownership proof when connecting an unapproved device. They do
not select or recover a main controller or compare a code/QR. Private router
passwords and authenticated ownership remain required. A full slot stays occupied;
#166 adds the explicit, freshly verified replacement flow.

Multi-device bundles retain first-main setup, controller-bound matching approval,
saved reconnects, manual addition and owner recovery. Both API requests and queued
approval execution check the current purchased entitlement. Old setup/review links
cannot establish main authority for a one-device bundle. Existing registration is
retained so valid control can be reused after an eligible upgrade.

#165 and #166 are reviewed separately and must release together. API/domain and
synthetic-router browser coverage is distinct from physical phone/router acceptance.
No merge, production deployment or physical verification is claimed by this note.
