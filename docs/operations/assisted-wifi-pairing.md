# Main-device approval for Wi-Fi access

The first owner-authenticated device connects through the API and is then asked
**Is this your main device?** Choosing Yes opens owner verification with PIN or
passkey; choosing No keeps internet access and skips main-device linking. Main
selection is explicit and survives renewals and Wi-Fi departures. Authenticator
sign-in and verification for main selection remain optional.

## Additional-device flow

1. Join NDAHI Wi-Fi and enter the account number and active voucher. A new,
   unapproved device gets a restricted **Request access** page. It receives no
   account session and no internet access from those details alone.
2. The owner sees the request in the main browser's notification bell and
   **Connection requests**. The router-announced name and MAC suffix identify the
   requested device. The owner chooses **Approve & show code** or **Decline**.
3. Only the main controlling browser receives the six-digit approval code. The
   requesting device enters that code to complete approval. It works for one
   request, customer, voucher, router revision and pinned guest MAC/IP/host row.
   Pending requests expire after five minutes. Issuing the code starts a fresh
   five-minute window, capped by bundle expiry; repeat taps reuse the same code
   and do not extend that window. Five wrong redemption codes fail the request.
4. Redemption rechecks current ownership, the bundle, remaining data, fresh device
   readings and available slots. **Connecting** reserves a slot. **Connected** is
   shown only after the router confirms the exact session.

When no main browser has been set, requests remain pending with a setup message
and the owner's bell shows **Set your main device**. The owner must select one
before a code can be issued. Reading or archiving a notification grants no access.
The approval code is separate from an authenticator code.

Approved devices can reconnect while their grant, router revision and current
bundle remain valid. Removing a device revokes its grant and unused codes; a
pending disconnect retains its slot and blocks reconnection until confirmed.
Main replacement or PIN recovery invalidates earlier controller approvals. A lost
main browser can be replaced through explicit fresh PIN/passkey recovery from an
owner account session. The replacement connects before the main-device question
is shown; the earlier controller and its unused codes no longer authorize access.

For a TV, console or device without a usable browser, the main browser offers
**Add a device without a browser**. Enter its Wi-Fi MAC and IPv4 address from its
network settings and confirm those details. The server verifies the live guest
mapping before queuing the same bounded router connection; no guest account
session is created. Names are untrusted display data, never ownership proof.

## Router enforcement

Deployment alone does not enable the policy. An owner enables the pilot from
**Admin → More → Network setup → Assisted device connections**, after checking
pre-login portal/API access. Enabling records a versioned policy and saved-router
revision and queues active vouchers for synchronization. Connections observed on
the router at the first enablement are retained as approved. No main browser is
selected automatically during migration.

The worker keeps the existing shared voucher username, quota and simultaneous
user accounting, but replaces its public voucher password with a private value
derived from the voucher ID and persistent `NETWORK_CONFIG_KEY`. Browsers never
receive this password. A reserved `ndahi-users-N-approval-v1` profile marks the
policy and retains the two-minute departure grace. Changing from the public
profile clears remembered voucher login cookies. Private-profile checks do not
require reading sensitive router password fields. Reconciliation repairs a
public or outdated profile through the durable sync queue.

Normal portal account sign-in still works from any network. Under this policy,
`GET /api/account/hotspot-credentials`, the legacy voucher/session redemption
endpoint and simulated device-connect endpoint cannot bypass device approval.
The first owner connection, an approved reconnection or explicit owner recovery
uses a router-verified target and a bounded server-side login instead.

Disabling **Assisted connections** pauses new requests and approvals and cancels
unredeemed requests. It does not restore public passwords. Already-approved
reconnections remain possible, subject to the active bundle and router mapping.
Private access requires the saved live router; disabling it cannot fall back to
an older public-password bridge. Restoring the earlier public-password policy
would require a separate reviewed migration, not the pause toggle.

## Rollout and physical pilot

1. Deploy the API, portal and admin together. Existing `challenges` and `events`
   tables hold `wifi_device_grant` and `notification_state`; no SQL schema change
   is required. Back up the persistent network key/configuration as usual.
2. Install the generated captive pages through the existing router procedure:

   ```bash
   node scripts/prepare-hotspot-pages.mjs https://portal.ndahiconnect.net /tmp/ndahi-hotspot
   ```

   The pages carry MAC/IP hints into onboarding. Those hints are checked against
   live router records. With browser storage blocked, keep them in the sign-in
   URL or reopen Wi-Fi sign-in when requested; the shared public IP identifies
   the coverage network and cannot identify an individual device.
3. Verify an unpaid/exhausted device can reach both portal and API with mobile
   data off. Keep the existing selective Starlink/WireGuard routing. Require
   `COVERAGE_ACCESS_ENABLED=true`, correct trusted coverage addresses, a saved
   active live router, stable `NETWORK_CONFIG_KEY` and the network worker.
4. Enable the policy using a test bundle. Wait for voucher synchronization and
   verify the approval profile/private credential on the router without copying
   secrets into logs or screenshots. A pre-existing older assisted-pairing flag
   must be re-enabled to install this policy version.
5. Test first-device Yes and No; an additional voucher/number sign-in; the main
   bell and code; wrong code, decline, cancellation and expiry; full device slots;
   approved reconnection; explicit main recovery; and a browserless device.
   Check that entering the public voucher directly cannot log in to the router,
   and old public cookies cannot admit an unapproved device.
6. Run on real Note 8, iPad Air 2 and the router. Check actual browsing and router
   rows, shared data accounting, exhaustion, expiry and Wi-Fi departure. Test lost
   responses: retries must recover one existing request/session. An operation
   already in flight can finish bounded confirmation; refresh devices after an
   uncertain result before issuing another approval.

Requests and redemptions use the existing separate pairing IP budget (default
600 per fifteen minutes). Status polling uses a bearer key, at most once per
1.5 seconds while pending; the UI polls every five seconds. Each customer has at
most three pending/awaiting-code/connecting requests and ten starts per fifteen
minutes. Completed request records are kept for seven days. Codes are hashed;
main-only display can be recovered from a nonce and the current/previous pepper.
Request recovery uses session storage or a URL fragment; phone/voucher and codes
are not placed in that fragment. No requesting-device account cookie is issued.

Automated tests use isolated accounts and synthetic router responses. They verify
API authorization, expiry, replay, main transfer, first-connection races, slot
races, private credential writes and 320px browser journeys. They do not establish
production enablement or physical compatibility. See also
[notifications](notifications.md) and [device management](device-management.md).

RouterOS references: [HotSpot users and authentication](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/),
[targeted login](https://manual.mikrotik.com/docs/cli-reference/ip/hotspot/active/login/),
and [REST API](https://manual.mikrotik.com/docs/developer-guides/rest-api/).
