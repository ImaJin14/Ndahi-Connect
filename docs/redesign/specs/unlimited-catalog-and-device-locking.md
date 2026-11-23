Implement the NDAHI Connect Unlimited bundle catalog, admin bundle
management, MAC-based device locking, and Home WISP sharing policy.

Start by inspecting the repository. Trace the admin dashboard, storefront,
checkout, payment verification, subscriptions, captive portal login, and
MikroTik provisioning. Reuse the existing architecture and authentication
flows. Implement the changes and run the relevant checks.

Network:
- MikroTik RB5009UPr+S+IN running RouterOS HotSpot
- TP-Link Omada EAP650-Outdoor in standalone mode
- Customer portal: portal.ndahiconnect.net

1. DATABASE-DRIVEN BUNDLE CATALOG

Make the database the source of truth for every bundle. Remove hard-coded
bundle names, prices, durations, device counts, and catalog fallbacks
from the storefront, checkout, backend, and router provisioning.

Let authorized admins create, edit, publish, unpublish, reorder, and
delete bundles from the admin dashboard without a code change or deploy.
Each bundle needs a name, price in whole FCFA (XAF), validity in hours
or days, display order, publication status, and an access type:

- Personal Unlimited: configurable number of registered device slots.
- Home WISP Unlimited: one registered WISP router with sharing enabled.

Enforce admin permissions and validate prices, durations, and device
limits on the server. Use the access type from the purchased terms to
select network policy. Bundle names, prices, and IDs are catalog data.

Migrate this initial catalog once. All amounts are in FCFA.

Personal Unlimited:
| Validity | 1 device | 2 devices | 4 devices | 6 devices |
| 5 hours  |      250 |         — |         — |         — |
| 24 hours |      500 |       900 |     1,700 |     2,500 |
| 7 days   |    2,000 |     3,500 |     7,000 |    10,000 |
| 30 days  |    6,000 |    10,000 |    20,000 |    30,000 |

Home WISP Unlimited:
- 30 days, 40,000 FCFA, one registered WISP router.

New bundles have unlimited data. Validity starts at first successful
activation and runs continuously. Retire Gig Standard from new sales
while honoring existing purchases and their original terms. Preserve
receipts, payment history, active subscriptions, and existing device
registrations where available. Startup, deployment, and recurring seed
scripts must never recreate a bundle an admin has removed.

2. CHECKOUT, PAYMENTS, AND DELETION

Read the published catalog from the backend. At checkout, check that
the bundle is still available and calculate the price on the server.
Store an immutable snapshot of the purchased terms on the order,
including the name, amount, currency, validity, access type, and
device limit. Use that snapshot for payment verification, receipts,
activation, and network provisioning. Keep payment and activation
retries idempotent.

Admin edits apply to new checkouts. Unpublishing or deleting a bundle
must immediately prevent new checkout, including through stale screens
and direct API calls. Honor pending orders at their recorded terms
until checkout expiry. Preserve active access and historical records.

Archive bundles referenced by orders or subscriptions. Allow permanent
deletion of unused bundles. Never cascade catalog deletion into orders
or subscriptions. Use explicit subscription revocation to terminate
an individual customer's access.

3. PERSONAL DEVICE LOCKING

Enforce the purchased number of registered devices and active sessions
on the MikroTik. Every occupied slot is bound to the Wi-Fi MAC address
observed by RouterOS during the authenticated HotSpot flow. Treat a
stable per-SSID private MAC as a valid address. Never provision a binding
from a client-supplied MAC alone.

When slots are full, deny new devices even if a registered device is
offline. A registered device can reconnect while its subscription is
active. Occupying an unused slot must require authenticated enrollment.

Add an authenticated device replacement flow. Revoke the old device's
authorization, terminate its live session, and clear any saved HotSpot
login that could restore access. Confirm revocation before authorizing
the replacement. Serialize updates to each slot and make provisioning
retryable so a partial failure cannot leave both devices authorized.
A device replacement must never restart the bundle's validity period.

4. DOWNSTREAM SHARING CONTROLS

Use MAC binding to control direct HotSpot access. Apply anti-sharing
controls to personal sessions to curb ordinary routed/NAT forwarding.

On the test HotSpot, validate a RouterOS mangle rule that sets IPv4 TTL
to 1 on forwarded internet replies egressing toward personal HotSpot
clients. Scope the rule to the guest network and relevant sessions.
Check rule order, FastTrack, and any other forwarding path that could
skip enforcement. Preserve captive portal and local service access.
Apply equivalent IPv6 controls if supported, or disable IPv6 forwarding
on that guest network until the path can be enforced.

TTL limits ordinary forwarding. Proxies and TTL-rewriting devices can
still share traffic. Describe personal bundles as restricting sharing
and record this limitation in the implementation notes.

5. HOME WISP ROUTER REGISTRATION

Bind the subscription to one router's upstream Wi-Fi MAC as observed by
the MikroTik. Grant the sharing exception only when an authenticated
session matches both an active Home WISP subscription and its registered
upstream MAC. Apply the exception before the personal TTL rule. A MAC
address or vendor prefix by itself never authorizes the exception.

If the router is replaced, revoke its previous session, binding, and
sharing exception before authorizing the replacement. At expiry or
revocation, disconnect the router and remove its sharing exception.
Withhold the exception whenever provisioning cannot verify entitlement.
Reconcile router state after failures, reconnects, and router restarts
so stale sessions and exceptions cannot survive beyond their entitlement.

Customer-owned routers manage their own downstream clients. Show
"up to 60 household devices on supported routers" as a capacity
description. Enforce a 60-client cap only on supported NDAHI-managed
routers that can apply it.

6. ACCEPTANCE TESTS

Catalog and payments:
- An admin can add, edit, publish, unpublish, reorder, and delete bundles.
  Storefront changes take effect without a deployment.
- Non-admins cannot mutate the catalog. Checkout rejects client attempts
  to override the amount, validity, device count, or access type.
- Editing or deleting a bundle preserves recorded pending orders,
  receipts, and active subscriptions, including a Home WISP subscriber's
  sharing entitlement until expiry or explicit revocation.
- Old URLs cannot start checkout for a deleted or unpublished bundle.
  Restarting or deploying never recreates deleted bundles.
- Payment retries and duplicate callbacks do not create duplicate
  subscriptions or restart validity.

Network:
- Phone A on a single-device bundle can browse. Phone B is denied
  direct access even when Phone A is offline.
- With cellular data disabled on both phones, Phone B can join Phone A's
  hotspot but cannot browse through ordinary NAT forwarding over NDAHI.
- A conventional WISP router on personal access cannot provide ordinary
  forwarded internet access to downstream clients.
- An active registered Home WISP router passes internet traffic to
  downstream clients. Another router cannot use that subscription.
- Device replacement disconnects the old device before the new one gets
  access, including under concurrent requests and provisioning retries.
- Expiry and revocation terminate access and clear WISP exceptions.
  Verify after reconnect, address changes, failed provisioning, and
  router reboot.
- Captive portal sign-in, checkout, payments, reconnection, and existing
  valid subscriptions still work.

7. DELIVERY

Deliver the database migration, admin UI/API, customer catalog and
checkout updates, device management and provisioning changes, and
version-compatible RouterOS configuration for testing. Include rollout
and rollback steps. Verify on a test HotSpot before applying any rules
to production. Report what passed, what failed, and which hardware
tests still require an RB5009, two phones, or a WISP router.