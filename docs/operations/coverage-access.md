# Purchase coverage access

Customers can open the portal, sign in, and view their data balance, bundle expiry, history and receipts from any internet connection. Only starting a bundle purchase, renewal or plan switch requires NDAHI Wi-Fi when the coverage guard is enabled.

An active bundle, passing internet traffic and a HotSpot login session are **not** prerequisites for buying. New customers and customers with expired/exhausted data must be able to reach both the portal and API before authentication. The customer root and installed app open packages first; login remains an explicit choice. Existing signed-in dashboard links still open the dashboard. An expired dashboard shortcut returns to packages.

## How it works

Guest API requests must leave the site through the cloud gateway's fixed public IPv4. A full tunnel sends all guest internet traffic through that gateway; selective routing can send ordinary internet directly through the local ISP while keeping the portal/API destinations on the tunnel. The API uses Render's original client address (`CF-Connecting-IP`, with `TRUST_PROXY=render`) and compares it with `COVERAGE_ALLOWED_IPS`.

The guard applies to both purchase creation routes:

- `POST /api/purchase`, including guest upgrades;
- `POST /api/account/plan/purchase`, including renewals and plan switches.

An outside request gets HTTP 403 with `code: "OUTSIDE_COVERAGE"` and the message "Connect to NDAHI Wi-Fi to purchase a bundle." The check runs after normal origin/CSRF handling and before any purchase reservation or payment-provider call. The browser shows the message and disables new purchase controls while leaving packages visible. It rechecks on returning to the page, a network event, or every 15 seconds while blocked and visible. The manual check refreshes access in place, preserving checkout fields. A failed recheck disables new purchases until a successful check; the API still enforces each creation request. `navigator.onLine` and the general network-status badge do not authorize or reject a purchase.

## If buying works only after data starts passing

The guard checks trusted public egress, not voucher balance. This symptom points to pre-authentication reachability/routing or phone cellular fallback; it does not prove the exact router fault. With mobile data **off**, join NDAHI Wi-Fi, accept **Use without internet**, and open `https://<api domain>/api/purchase/access` without a valid HotSpot session. It must report `allowed: true`. If it cannot load, inspect guest DNS and HTTPS walled-garden access. If it reports false, inspect the API destination's tunnel route, source-policy/mangle rules, source NAT and gateway NAT/return routing. Compare again after authenticating the same test phone.

Both current portal/API destinations need main-table tunnel routes and HTTPS exceptions independent of `hotspot=auth`. HotSpot uses the default routing table and its walled garden supports access before authorization; see the [MikroTik HotSpot manual](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/). An app cannot infer trusted Wi-Fi presence from a device ID, MAC address supplied by a browser, `navigator.onLine`, or an untrusted header. Keep the fixed cloud egress allowlist.

The owner can inspect this from **Admin → More → Network setup → Check purchase access**. It uses the saved live router connection, even with live provisioning disabled. The report shows current portal/API A records, matching router DNS cache, HTTPS exceptions, main-table routes, WireGuard interfaces, routing policies, firewall rules and device-mode flags. Missing or truncated readings remain explicit. It uses only router GET requests, changes no settings, and omits credentials, private keys, scripts, comments and unrelated DNS history. **Copy diagnostic report** lets the owner share the result without opening a router terminal. Read failures can be retried. App updates wait until the report is closed. The endpoint is owner-only, CSRF-protected and uncached.

This is a configuration inspection, not proof that an unpaid phone's traffic uses the allowed gateway. The report retains the phone test and cloud NAT/return-route checks below; no automatic repair is applied from the dashboard.

Prepare a review package using this installation's actual origins, existing tunnel gateway/interface and HotSpot server:

```sh
node scripts/prepare-purchase-network.mjs \
  --portal https://portal.ndahiconnect.net \
  --api https://api.ndahiconnect.net \
  --gateway 10.77.0.1 --tunnel wg-ndahi --server ndahi-hotspot \
  --output /tmp/ndahi-purchase-network
```

The tool resolves all current A records, rejects non-public destinations and writes `checks.rsc` (read-only), `apply.rsc`, `rollback.rsc` and a test checklist. It never contacts or changes a router. Review the generated DNS snapshot against guest DNS. In a wired Safe Mode session, run the checks, resolve existing policy/firewall conflicts, dry-run the apply file on the installed RouterOS, then import and test it. The apply file creates only named-server TCP 443 IP exceptions, main-table /32 tunnel routes and fallback blackholes. It stops before writes on conflicting exact main-table routes or changed tagged entries; it preserves existing NAT, firewall, management and default routes. It does not repair arbitrary policy-routing/firewall conflicts automatically. Rollback removes only that plan's tagged entries.

IP exceptions may also permit HTTPS sites sharing these destination addresses. Review that scope on shared hosting. They avoid depending on inactive hostname exceptions, but require regeneration when DNS changes; do not expand them to broad CDN ranges. The generator uses the [RouterOS route CLI](https://manual.mikrotik.com/docs/cli-reference/ip/route/) and [IP walled-garden CLI](https://manual.mikrotik.com/docs/cli-reference/ip/hotspot/walled-garden/ip/). RouterOS import/behavior must still be verified on the physical installation.

Verify with a fresh guest, an expired voucher and an exhausted voucher: packages and payment initiation work on Wi-Fi without general internet; outside-Wi-Fi purchases remain blocked; a pending payment remains trackable off-network; and tunnel loss does not leak portal/API requests to the direct ISP route. Use test/provider sandbox accounts. Regenerate/upload the three captive-portal landing files with `scripts/prepare-hotspot-pages.mjs` so existing router popups also show bundles first; app deployment does not replace router files.

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
