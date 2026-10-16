# Coverage-only customer access

The customer portal and the customer API can be limited to people on the guest Wi-Fi, so nobody outside coverage can sign in or buy bundles.

## How it works

All guest internet traffic leaves the site through the cloud gateway's fixed public IPv4. With the guard enabled, the portal and the customer API accept requests only from the addresses in `COVERAGE_ALLOWED_IPS`. The original client address comes from Render's `CF-Connecting-IP` header (`TRUST_PROXY=render`). Requests from any other address get:

- a short "Connect to NDAHI Wi-Fi" page, for portal pages opened in a browser;
- `403 {"code": "OUTSIDE_COVERAGE"}`, for everything else.

These stay reachable from anywhere and keep their own authentication:

- the admin site and every `/api/admin/` route;
- the signed MeSomb and Flutterwave webhooks;
- `/api/health`, `/api/metrics`, `/api/csp-report` and `/api/telemetry/vitals`;
- the portal's `/healthz`, which is Render's health check.

While the guard is on, customer pages and assets are marked `private`. Browsers still cache scripts, but no shared cache can serve them.

Do not use a Starlink address. It is carrier-grade NAT shared with other Starlink customers, and it changes.

## Enable

1. From a phone on the guest Wi-Fi, open `https://api.ipify.org` and confirm it shows the cloud gateway's public IPv4.
2. On the **customer** service in Render, set:

   ```dotenv
   TRUST_PROXY=render
   COVERAGE_ACCESS_ENABLED=true
   COVERAGE_ALLOWED_IPS=<cloud gateway public IPv4>
   ```

3. On the **API** service, set the same `COVERAGE_ACCESS_ENABLED` and `COVERAGE_ALLOWED_IPS`. `TRUST_PROXY` is already pinned there.
4. Redeploy both services. The pre-deploy environment check and the service itself refuse to start with an invalid setting. Invalid settings include a flag other than `true` or `false`, a missing or non-IPv4 address, or a portal without `TRUST_PROXY=render`.
5. Check both sides:
   - on guest Wi-Fi, the portal works;
   - on mobile data, the portal shows the "Connect to NDAHI Wi-Fi" page;
   - on mobile data, `curl -H "CF-Connecting-IP: <gateway IP>" https://<api domain>/api/plans` is still refused, so a forged header cannot get through Render's edge.

## Rollback and changes

Set `COVERAGE_ACCESS_ENABLED=false` on both services and redeploy. If the gateway's public address changes, update `COVERAGE_ALLOWED_IPS` on both services first. Several addresses can be listed, comma-separated. Otherwise every customer is locked out.

Customers outside coverage cannot open the dashboard, including from a usage-alert notification, until they are back on the Wi-Fi.
