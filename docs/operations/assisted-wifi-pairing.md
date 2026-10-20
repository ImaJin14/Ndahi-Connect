# Assisted Wi-Fi pairing

Assisted pairing lets a new device request Wi-Fi access and a verified main
browser approve it. It does not create an account session on the new device.
Normal voucher and PIN sign-in remains available.

## Customer flow

1. On a connected device, select the main device in the account's device controls.
   Verify with the account PIN or passkey. An enrolled authenticator code is optional
   for main-device selection and is not required to approve another device.
   The selected browser remembers control in an HttpOnly cookie. Replacing the
   main browser or changing/recovering the PIN revokes earlier control.
2. On the new device, join NDAHI Wi-Fi, open Wi-Fi sign-in, and choose **Connect
   using your main device**. Enter the account phone number and active voucher.
3. Keep its six-digit code open. In the main browser's **Connection requests**,
   compare the router-announced name and MAC suffix, enter that code, then approve
   or decline. The code expires after five minutes or at bundle expiry, whichever
   comes first. Five incorrect codes fail the request.
4. Both screens show **Connecting** until the router confirms the exact active
   session. Approval checks current bundle/data, fresh device readings and free
   slots. Connecting requests reserve slots; the router rechecks live limits.

The new device's pairing code is separate from an authenticator app's sign-in code.
Customers do not need to enroll an authenticator to use assisted pairing.

Names are display data. The API verifies the hinted MAC/IP against a fresh guest
row on `ndahi-hotspot`, and pins its host ID and translated login IP. The worker
rechecks the host mapping, managed voucher, presence profile, quota and deadline
before calling RouterOS. A DHCP address reused by another host cannot retarget
an old request. Device MAC randomization or Wi-Fi reconnection may require a new
code. A missing DHCP name is shown as an unnamed device with its MAC suffix.

Only hashes of request keys and pairing codes are stored for authentication. Reload recovery
uses a temporary key in session storage and the URL fragment, which is not sent
in HTTP requests. The page sets `no-referrer`; phone/voucher are not stored in that
handoff. Retrying a lost response with the same key returns the same request.
No guest account cookie is issued. Terminal requests never return their code.

## Rollout and on-site pilot

This feature is disabled by default. Deploying code does not enable it.

1. Merge the main-device prerequisite (PR #48), then deploy this change to the
   API, customer portal and admin app. If using the legacy management bridge,
   deploy its new `readGuestDevice` and `connectWifiDevice` actions first. A saved
   live router uses the direct REST adapter. Mock routers cannot authorize pairing.
   Existing `challenges` storage holds the new `wifi_pairing` kind; no SQL schema
   change is required.
2. Regenerate the router's captive portal pages using the existing command:

   ```bash
   node scripts/prepare-hotspot-pages.mjs https://portal.ndahiconnect.net /tmp/ndahi-hotspot
   ```

   Review and upload `login.html`, `flogin.html` and `rlogin.html` through the
   existing router deployment procedure. Generated URLs carry `$(mac)` and
   `$(ip)` into the onboarding page. These are hints, not proof of ownership.
   The server validates them against router records before creating a request.
3. Verify an unpaid/exhausted device on NDAHI Wi-Fi can reach both the portal and
   API before login. Use **Admin → More → Network setup → Check purchase access**
   and test the actual device with mobile data off. Keep the existing selective
   Starlink/WireGuard routing; this feature requires no default-route change.
4. Require an active saved live router, `COVERAGE_ACCESS_ENABLED=true`, correct
   trusted coverage addresses and a running network worker
   (`NETWORK_QUEUE_ENABLED` must not be `false`). In Network setup, check the
   pre-login verification statement and enable **Assisted device connections**.
   Enabling performs read-only checks of the hotspot, guests, active sessions and
   profiles and records the saved router revision. A changed revision disables
   pairing until checked and enabled again.
5. With a test bundle, verify Note 8 and iPad Air 2: announced names, code matching,
   approval, decline, expiry, an occupied last slot, duplicate taps, Wi-Fi departure,
   main-browser replacement, and normal voucher/PIN sign-in. Check the live router
   row and actual internet access, not only the UI. Confirm guest approval does
   not open account settings.
6. Simulate a lost router/API response and recovery. A confirmed existing session
   must not generate another login. A request that expires before dispatch cannot
   be replayed. An operation already in flight may finish bounded confirmation;
   check connected devices after an uncertain/failed result before requesting
   another code. Finite processing leases recover abandoned workers.

Use **Disable assisted connections** to stop new requests and approvals. Pending
requests are cancelled; queued approvals fail authorization. An already-issued
bounded router operation may finish. Existing Wi-Fi sessions continue and can be
disconnected through the normal device controls.

Pairing request/approval traffic has a separate IP budget (`AUTH_EDGE_PAIRING_MAX`,
default 600 per `AUTH_EDGE_WINDOW_SECONDS`, default 900 seconds). Status polling
requires its bearer key and is limited to once per 1.5 seconds while pending;
the UI polls every five seconds. Polling does not consume the shared sign-in
budget. Requests are limited per customer to three pending/connecting and ten
within fifteen minutes. Terminal request records are retained for seven days.

## Validation boundary

Local API/router tests and Chromium journeys use isolated state and synthetic
router responses. They exercise authorization, CSRF, code/lease expiry,
concurrent slot reservations, replay prevention, stale mappings, quota/presence
guards, lost responses, blocked browser storage and narrow screens. They do not
establish production deployment or physical device/router compatibility.

RouterOS references: [targeted active login](https://manual.mikrotik.com/docs/cli-reference/ip/hotspot/active/login/)
and [HotSpot HTML variables](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/hotspot-customisation/).
