# External customer portal login

The customer portal stays on Render. The router's HotSpot DNS name remains the
local HTTPS login endpoint covered by its existing certificate. Do not change
that DNS name to the Render portal hostname.

After customer sign-in, the portal opens `/hotspot`, waits for the owned active
voucher to synchronize, and POSTs its credentials to the fixed router login URL.
Credentials stay out of URLs and browser storage. The router then redirects the
browser to the customer dashboard. A router rejection returns to a retry page
without repeatedly submitting the same credentials automatically.

## Deployment

1. Deploy the API and customer service from the release containing this feature.
2. On the customer Render service, set `HOTSPOT_LOGIN_URL` to the router's trusted
   HTTPS login URL, for example `https://connect.hotspot.example/login`. Redeploy
   the customer service. This setting also permits that exact origin in the
   customer's `form-action` CSP. It is not needed on the admin service.
3. Confirm Admin → Network setup reports the saved live router active for voucher
   enforcement. Pending vouchers are retried on the connection page; unavailable
   or rejected activation shows an error. Payment-linked vouchers require a
   confirmed payment. Admin-issued and redeemed resale vouchers need no payment.
4. On an unauthenticated guest phone, confirm the portal and its API load through
   the existing walled-garden rules. Confirm a valid TLS certificate for the
   router login hostname. Keep general internet blocked before HotSpot login.
5. Generate the router pages locally, substituting the actual portal origin:

   ```sh
   node scripts/prepare-hotspot-pages.mjs https://portal.example.com /tmp/ndahi-hotspot-pages
   ```

6. In WinBox → Files, download a backup of the existing HotSpot HTML directory.
   Upload the generated `login.html`, `rlogin.html`, and `flogin.html` into the
   directory already selected by the active HotSpot profile, replacing those
   three files. Keep the other files, including `api.json`, `alogin.html`, and
   `status.html`. Existing post-login handling must honor the supplied `dst`.
7. Join guest Wi-Fi on a phone with mobile data disabled and no active HotSpot
   login/cookie. The popup should redirect to the Render portal's `/login`.
   Sign in with the customer phone/voucher and PIN; first-time customers create
   their PIN. The portal submits the voucher automatically to the router.
8. Confirm a real HotSpot active session and internet access. Revoke the test
   voucher from admin and confirm internet stops. Test a rejected router login:
   the retry page must show an error without an automatic redirect loop.

For rollback, restore the three backed-up router files and remove
`HOTSPOT_LOGIN_URL` from the customer service, then redeploy it. This feature
handles captive login; restricting public Render access to the site's network
requires the separate coverage access guard.

Protocol reference: [MikroTik external authentication](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/hotspot-customisation/).
