# Signup through main-device approval and reconnection

The signup handoff retains the router-supplied MAC/IP candidates through payment
completion, checkout recovery, PIN setup, and Wi-Fi activation. It does not rely
on localStorage or sessionStorage. PIN-setup reloads continue to use the bounded
HttpOnly checkout-setup cookie. Only validated MAC/IP candidates are added to
local navigation; account phone numbers, voucher codes, PINs, request credentials
and approval codes are not copied into the navigation URL by this handoff.

These candidates do not authorize access. The API still verifies the actual
guest-router mapping before a connection, and fresh owner proof selects the
main browser. Explicit account-only sign-in continues to open account settings.

## Regression and automated evidence

Run:

```sh
npm run check:signup:browser
```

This journey is also part of `npm run check:hotspot:browser` and the normal
`npm run test:browser` CI job. It uses a real local API, mock payment confirmation,
isolated accounts, and a synthetic router; all external browser requests are
blocked. Storage is denied and `AbortSignal.timeout` is unavailable at 320px.

Before this fix, signup reached PIN setup without the device's MAC/IP. The new
regression failed at the payment-to-PIN transition even with the reconnect fixes
from PR #54 applied. With this fix it covers:

1. Choose a two-device bundle, complete payment, reload PIN setup, create a PIN,
   and wait for router-confirmed first-device access.
2. Choose Yes at the main-device prompt and verify ownership. Confirm that this
   browser becomes the controller.
3. Request access from an independent second browser, transfer the main browser's
   single-use approval code, and wait for router confirmation. Confirm that the
   secondary browser receives no account session.
4. Simulate router-session loss and changed IP/host/session identifiers. Reopen
   the earlier connection keys on both approved devices, require fresh router
   confirmation, and reconnect without a new approval code. Keep the saved main
   designation and controller intact.
5. Request access from an unknown third MAC. Confirm that it requires approval
   and that even an issued approval code cannot exceed the two-device limit.

The separate persisted-store restart, revocation, expiry, shared-slot races,
failed router-reading and private-credential tests remain required. See the
[assisted connection runbook](assisted-wifi-pairing.md).

## Deployment and physical verification

Deploy the reviewed API and portal changes together, then compare the served
assets with the tested release. The source change does not install router files.
Inspect the currently active HotSpot profile's effective HTML directory, back up
its `login.html`, `rlogin.html` and `flogin.html`, and install the generated pages
through an authorized router session. Preserve the site's selective routing.

On the physical Note 8/iPad Air 2, repeat signup, main selection, secondary
approval and actual browsing. Restart the router/AP and repeat both reconnects.
Observe the real router session rows, shared data usage and device limit. A
synthetic restart passing does not establish hardware success. A device using a
different private MAC requires approval; matching names never establish identity.
