# Render deployment

The root `render.yaml` provisions four resources from this GitHub repository:

- `ndahi-customer`: customer portal web service
- `ndahi-admin`: administrator web service
- `ndahi-api`: API web service
- `ndahi-postgres`: private PostgreSQL database

The Blueprint intentionally does not declare custom domains yet. Start with the Render-provided URLs, verify the full system, and attach live DNS afterward.

Use `docs/render-required-values.txt` as the copy-and-fill worksheet for the Blueprint creation form. It contains no real secrets and must remain that way.

## 1. Push and connect the Blueprint

1. Push the repository to GitHub.
2. In Render, select **New → Blueprint**.
3. Connect the GitHub repository and select `render.yaml`.
4. Review the Frankfurt-region resources and instance plans.
5. Enter every value Render marks as **required during creation**.

Render generates the three application secrets and obtains `DATABASE_URL` from the managed database. Do not copy the local `.env` into Render.

The Blueprint sets `DATABASE_SSL=false` because `fromDatabase.connectionString` uses Render's same-region private network URL. External PostgreSQL connections must use TLS; do not reuse this setting with an external database URL.

The first deployment uses `BOOTSTRAP_MODE=true`. In this mode the API exposes only health/status responses and returns HTTP 503 for all operational endpoints. After every production URL and provider secret is configured, set `BOOTSTRAP_MODE=false` on `ndahi-api` and redeploy. Never serve customers while bootstrap mode is enabled.

## 2. Initial URL variables

After Render assigns the three service URLs, configure these values. Substitute the exact hostnames Render gives you if a service name receives a suffix.

### Customer service

```dotenv
API_URL=https://ndahi-api.onrender.com
```

### Admin service

```dotenv
API_URL=https://ndahi-api.onrender.com
```

### API service

```dotenv
CUSTOMER_APP_URL=https://ndahi-customer.onrender.com
ADMIN_APP_URL=https://ndahi-admin.onrender.com
API_URL=https://ndahi-api.onrender.com
ALLOWED_ADMIN_ORIGINS=https://ndahi-admin.onrender.com
WEBAUTHN_RP_ID=ndahi-admin.onrender.com
```

`WEBAUTHN_RP_ID` is a hostname only—never include `https://` or a path.

## 3. Required secrets and integrations

Provide these in the Blueprint creation form or the API service Environment page:

```dotenv
ADMIN_BOOTSTRAP_PASSWORD=<unique password of at least 14 characters>
ADMIN_MFA_CODE=<temporary six-digit recovery code>
FLW_SECRET_KEY=<Flutterwave secret key>
FLW_SECRET_HASH=<Flutterwave webhook secret hash>
SMS_PROVIDER=<configured SMS adapter name>
SMS_API_URL=<HTTPS SMS endpoint>
SMS_API_KEY=<SMS credential>
MIKROTIK_API_URL=<HTTPS address reachable from Render>
MIKROTIK_USER=<restricted bridge user>
MIKROTIK_PASSWORD=<bridge password>
OMADA_API_URL=<HTTPS address reachable from Render>
OMADA_API_TOKEN=<controller token>
```

Production validation deliberately stops the API if a provider remains mocked, a URL is insecure, or a required secret is absent.

MikroTik and Omada endpoints on a private campus LAN are not directly reachable from Render. Route them through the restricted on-site management bridge, a VPN, or a mutually authenticated tunnel. Never expose the router administration UI directly.

## 4. Verify the temporary deployment

Confirm:

- `https://<api-host>/api/health` returns HTTP 200 and confirms the database is readable.
- The customer portal loads its plans and can complete a controlled payment test.
- The admin origin can sign in and other origins are rejected.
- PostgreSQL retains data across an API redeploy.
- Flutterwave webhook signatures are accepted only with the configured hash.
- Router and Omada health checks reach the on-site bridge.

Enroll only temporary passkeys on the Render hostname. WebAuthn credentials are bound to their hostname and cannot move to the final admin domain.

## 5. Connect live DNS

The Blueprint now declares all three production domains. After syncing it,
Render displays the exact DNS target for each service. Create the records shown
by Render at the DNS provider for `ndahiconnect.net`; do not guess Render's
targets or copy the temporary service URLs as IP addresses.

Add each domain to its matching Render service:

| Service | Domain |
|---|---|
| `ndahi-customer` | `portal.ndahiconnect.net` |
| `ndahi-admin` | `admin.ndahiconnect.net` |
| `ndahi-api` | `api.ndahiconnect.net` |

Create the DNS records Render displays and wait for certificate verification. Then update the environment values:

```dotenv
CUSTOMER_APP_URL=https://portal.ndahiconnect.net
ADMIN_APP_URL=https://admin.ndahiconnect.net
API_URL=https://api.ndahiconnect.net
ALLOWED_ADMIN_ORIGINS=https://admin.ndahiconnect.net
WEBAUTHN_RP_ID=admin.ndahiconnect.net
```

Update `API_URL=https://api.ndahiconnect.net` on both frontend services as well. Redeploy all three services, verify CORS and login, then enroll new production passkeys on `admin.ndahiconnect.net`.

Finally, configure Flutterwave to send signed webhooks to:

```text
https://api.ndahiconnect.net/api/webhooks/flutterwave
```

After DNS verification, the Render-provided admin subdomain can be disabled to ensure passkeys and administrator traffic use only the production hostname.
