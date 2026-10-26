# Main-device approval for Wi-Fi access

The first owner-authenticated device connects through the API and is then asked
**Is this your main device?** Choosing Yes opens owner verification with PIN or
passkey; choosing No keeps internet access and skips main-device linking. Main
selection is explicit and survives renewals and Wi-Fi departures. Customer
account verification uses PIN or passkey; admin password/passkey is unchanged.

## Additional-device flow

1. Join NDAHI Wi-Fi. A signed-in requester uses **Request access** with the
   current account session and eligible active bundle; no phone, voucher or owner
   recovery proof is requested again. A captive guest enters the linked account
   number and active voucher once; **Request access** carries that context forward
   without creating an account session or asking for the owner's PIN.
2. The requesting device displays a six-digit **matching request code**, a QR and
   a five-minute countdown. The main browser opens the exact request from its
   notification bell, Connection requests, or the QR. It sees the same code,
   router-announced device label, MAC suffix and expiry.
3. The main browser compares the codes and explicitly chooses **Codes match —
   allow device** or **Decline**. Scanning the QR, displaying the code, opening a
   notification, or GETting the review page never approves. A QR opened in a
   different browser cannot transfer the main controller cookie.
4. Confirmation rechecks current ownership, active paid bundle, quota, router
   mapping/freshness, revocation barriers and device slots. **Connecting** reserves
   a slot durably; **Connected** and native captive completion are offered only
   after the router confirms the exact target. The requester does not enter a
   second code. Lost replies/reloads resume the same operation, including when
   storage is blocked.

The matching reference is not an authorization secret and cannot redeem a request.
The QR contains only `/pair-review.html?request=<opaque UUID>`, with no account,
voucher, PIN, main credential or requester bearer key. Reading the exact request
requires its customer session; approval additionally requires the current main
controller, CSRF/origin protection, explicit match flag and exact reference. A
cached id-only approval fails safely. References expire five minutes after request
creation, capped by bundle expiry; scans, polls and repeat approvals never extend
that deadline. A main-controller replacement cancels earlier waiting requests.

When no main browser has been set, requests wait with a setup message and the
owner's bell shows **Set your main device**. Selecting the first main browser
allows those waiting requests to be reviewed; no automatic approval occurs.
Reading or archiving a notification grants no access.

### Earlier requests and mixed deployment

New requests use protocol 3 and a distinct `awaiting_confirmation` state. Existing
protocol-2 `pending`/`awaiting_code` requests keep the earlier **Approve & show
code** and requester code-entry path until they complete or expire. Their secret
is never the new matching reference. A new frontend must not offer code entry for
protocol 3, and the redemption API rejects it even after admission.

Release the API before the portal. No database migration is required; the existing
request JSON rows store the protocol and reference verifier. Older APIs cannot
approve the distinct new pending state, even with an id-only click. During API
rollback an unapproved protocol-3 request must be retried on compatible code;
never convert it into an automatically approved legacy request. Already admitted
jobs retain the existing worker authorization, expiry and idempotency checks.
Current/previous peppers can recover the same reference; losing both makes it
unavailable and requires a new request rather than showing an invalid code.

The account number is the phone number already linked to the voucher. A second
person using that voucher requests access under that account; they do not create
a new account PIN. The first account owner still creates or enters a PIN to
protect account settings. **Sign in to account settings** is an explicit separate
choice and opens the account page without attempting a Wi-Fi connection.

If a captive page loses its MAC/IP hints, additional-device sign-in stays on the
restricted access screen and offers **Open Wi-Fi sign-in**. It must never fall
back to requiring the owner's PIN just because the hints are absent. The router
still verifies the target before access can be queued.

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

Owners can also revoke saved approvals while a device is offline using **Saved
device approvals → Forget device**, including after bundle expiry. Fresh owner
proof protects this action. It cancels unused codes and unclaimed reconnects;
router session/cookie cleanup is durable and blocks reapproval until confirmed.
See [device removal](device-management.md#forgetting-a-saved-device-including-offline-devices).

Deployment alone does not enable the policy. An owner enables the pilot from
**Admin → More → Network setup → Assisted device connections**, after checking
pre-login portal/API access. Enabling records a versioned policy and saved-router
revision and queues active vouchers for synchronization. Connections observed on
the router at the first enablement are retained as approved. No main browser is
selected automatically during migration.

Check `GET /api/wifi/pairing/config` when diagnosing the live flow. Both `enabled`
and `approvalRequired` must be true for new approvals. If `approvalRequired` is
false, the legacy voucher/PIN flow remains active even after deployment. If it is
true while `enabled` is false, new requests are unavailable while the approval
policy remains enforced. The admin status distinguishes these states.

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

### Reconnect after a router or access-point restart

The account's main-device designation and approved MAC grants are persisted
separately from the router's active sessions, DHCP IP address and reported name.
A returning approved MAC must reconnect without a new main-device code, even
when its IP and router session identifiers change. A different MAC, including a
changed private Wi-Fi address, still needs approval or explicit verified owner
recovery. A matching hostname never establishes ownership.

Completed request keys are historical results. Starting another connection with
one returns `PAIRING_RESTART_REQUIRED`; portal clients make one bounded retry with
a fresh key, rechecking the saved grant and current router target. Pending retries
retain their key so lost responses cannot create duplicate login operations.
Manual browserless-device approvals use this same bounded restart and keep the
rotated key if another response is lost.
MAC/IP candidates stay in the pairing URL through reload, expiry and retry when
browser storage is denied. Account numbers, vouchers and approval codes stay out
of that URL. The Wi-Fi sign-in link remains available on recovered requests.

When DHCP stops announcing a name, a matching saved main/grant label is displayed
as **Last reported name**. This display fallback does not change device identity,
approval, router freshness or slot checks. Browser approval control additionally
uses an HttpOnly cookie; losing that cookie does not erase the saved Wi-Fi grant.
Use the existing fresh PIN/passkey main-browser verification to restore control.

A stale reading backed by a dead-lettered router-read command returns
`ROUTER_READ_FAILED`, rather than telling the customer to keep refreshing.
An authorized operator must inspect/recover that command and obtain a fresh
reading before another connection can be admitted.

The physical iOS screenshot showing **Wi-Fi sign-in page did not identify this
device** is a separate unresolved installation check: inspect the active profile's
effective HTML directory and its served `login.html`, `rlogin.html` and
`flogin.html`. Back up those three files before replacing them with the generated
pages described below. Keep the other router files. App deployment alone cannot
install them. The October 16 `ndahi-profile`, `hotspot`, empty-override record is
historical; verify the effective profile before writing files. Reopening the
portal repeatedly cannot repair an installed redirect that drops MAC/IP.

### Installation and physical verification

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
   bell and matching code/QR; mismatch, decline, cancellation and expiry; full slots;
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
most three pending/awaiting-confirmation/awaiting-code/connecting requests and ten
starts per fifteen minutes. Completed records are kept for seven days. Legacy
secrets and matching references have separate hash/nonce domains. QR PNG rendering
happens after storage commits only when explicitly requested, not on each poll.
Request recovery uses session storage or a URL fragment; phone/voucher and codes
are not placed in that fragment. No requesting-device account cookie is issued.

Automated tests use isolated accounts and synthetic router responses. They verify
API/CSRF authorization, session reuse, exact QR/notification destinations, expiry,
replay, main transfer, first-connection races, slot races, transactional rollback,
PostgreSQL reopen/independent workers, private credential writes and 320/1280px
browser journeys. The actual rendered QR is decoded in browser verification. They do not establish
production enablement or physical compatibility. See also
[notifications](notifications.md) and [device management](device-management.md).

RouterOS references: [HotSpot users and authentication](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/),
[targeted login](https://manual.mikrotik.com/docs/cli-reference/ip/hotspot/active/login/),
and [REST API](https://manual.mikrotik.com/docs/developer-guides/rest-api/).
