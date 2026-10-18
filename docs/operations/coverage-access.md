# Purchase coverage access

Customers can open the portal, sign in, and view their data balance, bundle expiry, history and receipts from any internet connection. Only starting a bundle purchase, renewal or plan switch requires NDAHI Wi-Fi when the coverage guard is enabled.

## How it works

Guest API requests must leave the site through the cloud gateway's fixed public IPv4. A full tunnel sends all guest internet traffic through that gateway; selective routing can send ordinary internet directly through the local ISP while keeping the portal/API destinations on the tunnel. The API uses Render's original client address (`CF-Connecting-IP`, with `TRUST_PROXY=render`) and compares it with `COVERAGE_ALLOWED_IPS`.

The guard applies to both purchase creation routes:

- `POST /api/purchase`, including guest upgrades;
- `POST /api/account/plan/purchase`, including renewals and plan switches.

An outside request gets HTTP 403 with `code: "OUTSIDE_COVERAGE"` and the message "Connect to NDAHI Wi-Fi to purchase a bundle." The check runs after normal origin/CSRF handling and before any purchase reservation or payment-provider call. The browser shows the message and disables new purchase controls while leaving packages visible. Customers can check again after joining NDAHI Wi-Fi.

`GET /api/purchase/access`, the public catalogue's `purchaseAccess` field, and the authenticated dashboard's `purchaseAccess` field report whether the current request can start a purchase. These responses are not cached. Account data retains its existing session and ownership checks.

Payment recovery, status checks, receipts, account setup and signed provider webhooks stay reachable after a customer switches networks. Recovering a saved checkout never creates a new purchase; if no reservation exists, creating it still requires NDAHI Wi-Fi. The installed app and usage-alert links also work away from NDAHI Wi-Fi. Sign-in outside the network skips the local router handoff and continues to the account page.

The portal serves its pages and assets publicly; coverage settings on the customer static service are ignored. Administration and operational probes keep their existing authentication and access checks.

Do not use a Starlink address for the allowlist. It is carrier-grade NAT shared with other Starlink customers, and it changes.

## Enable

1. Confirm guest API requests use the cloud gateway's public IPv4. With a full tunnel, `https://api.ipify.org` on guest Wi-Fi should show that address. With selective routing, a general IP-check site instead shows the ISP's public address; validate the portal/API's specific tunnel routes and purchase behavior separately. Selective routing must cover every current destination address for the portal/API, retain HotSpot authentication, and prevent those destinations from falling back to direct ISP egress when the tunnel fails. Review the specific routes and guards when destination DNS changes.
2. On the **API** service in Render, set:

   ```dotenv
   TRUST_PROXY=render
   COVERAGE_ACCESS_ENABLED=true
   COVERAGE_ALLOWED_IPS=<cloud gateway public IPv4>
   ```

3. Deploy the API and customer portal together. Keep the guard enabled on the API; disabling it permits purchases from any network. No coverage settings are required on the customer service. Old customer coverage variables can be removed.
4. The API and its pre-deploy environment check refuse invalid coverage settings, including a flag other than `true` or `false`, a missing or non-IPv4 address, or missing `TRUST_PROXY=render`.
5. Verify:
   - On NDAHI Wi-Fi, sign-in and bundle purchases work.
   - On mobile data, sign-in works and balances, expiry, history and receipts are visible.
   - On mobile data, package browsing works, but purchase, renewal and switch controls explain the Wi-Fi requirement; both creation endpoints return `OUTSIDE_COVERAGE` without initiating a charge.
   - A payment started on Wi-Fi remains recoverable and can complete after switching to mobile data.
   - On mobile data, `curl -H "CF-Connecting-IP: <gateway IP>" https://<api domain>/api/purchase/access` still reports `allowed: false`, confirming Render's edge does not trust a forged client header.

## Rollback and address changes

Set `COVERAGE_ACCESS_ENABLED=false` on the API and redeploy to allow purchases from any network. Portal/account access remains available regardless of this flag. If the gateway's public address changes, update `COVERAGE_ALLOWED_IPS` on the API; several addresses can be listed, comma-separated. An outdated address prevents purchases on Wi-Fi but does not prevent customers from accessing their accounts.
