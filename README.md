# NDAHI Connect — separated customer, admin and API services

NDAHI Connect is a zero-dependency Node.js student-zone pilot for one Starlink uplink, a MikroTik RB5009 Hotspot gateway, and an Omada EAP650-Outdoor serving approximately four buildings. Payment, voucher, quota, device-limit, persistence and RouterOS adapter behavior are preserved.

## Application boundaries

| Service | Production URL | Local URL | Contents |
|---|---|---|---|
| Customer portal | `https://portal.ndahiconnect.net` | `http://localhost:8080` | Voucher activation, customer login/dashboard, quota, history and devices |
| Admin dashboard | `https://admin.ndahiconnect.net` | `http://localhost:8081` | Admin-only operations, reports, integrations, profile/MFA and audit logs |
| API | `https://api.ndahiconnect.net` | `http://localhost:8082` | JSON API only; no application pages |

The customer build contains no admin route, navigation, assets or API calls. `/admin` returns 404 on the customer service. The API accepts `customer_session` only for customer endpoints and `admin_session` only for admin endpoints. Sessions are opaque, stored as hashes server-side, and sent as host-scoped `HttpOnly`, `SameSite=Lax` cookies. Production cookies are also always `Secure`.

## Local development

Node.js 20 or newer is required. Install dependencies with `npm ci`.

```bash
# Edit the single .env file and replace the administrator bootstrap password
# and all secret placeholders before starting the services.
set -a
source .env
set +a
```

Open three VS Code terminals:

```bash
npm run start:customer
```

```bash
npm run start:admin
```

```bash
npm run start:api
```

For local plain HTTP only, `.env` sets `SESSION_COOKIE_SECURE=false`. Production must set it to `true`. Mock mode displays customer OTPs in development. No Mobile Money PIN is ever requested or stored.

## Security model

- Customer login: phone + bound activation code, then a hashed six-digit OTP with five-minute expiry, five attempts and phone/IP throttling.
- Administrator login: named accounts with Argon2id password hashes, phishing-resistant WebAuthn passkeys, optional TOTP fallback, role authorization, five failures per IP per 15 minutes, CSRF protection in production, and a separate strict session cookie.
- Browser requests use credentialed CORS. Admin endpoints allow only `ALLOWED_ADMIN_ORIGINS`; there is no wildcard CORS. Customer-origin requests to admin operations are rejected before authentication.
- All administrator operations perform server-side role/session checks. Customer and admin cookies cannot substitute for each other.
- Admin login/logout, bundle creation, voucher generation/revocation, customer suspension, refunds, payment corrections, device disconnects, MFA changes and zone configuration changes are audited.
- Secrets and provider/RouterOS credentials remain backend environment variables and are never emitted in frontend configuration.

The admin dashboard supports authenticator-app TOTP enrollment through an `otpauth://` setup URI, confirmation with a time-windowed six-digit code, and MFA-protected subsequent logins. `ADMIN_MFA_ENABLED=true` with `ADMIN_MFA_CODE` remains available only as an environment-managed recovery mechanism.

## Configuration

Required production variables:

```dotenv
NODE_ENV=production
CUSTOMER_APP_URL=https://portal.ndahiconnect.net
ADMIN_APP_URL=https://admin.ndahiconnect.net
API_URL=https://api.ndahiconnect.net
CUSTOMER_SESSION_SECRET=<unique high-entropy secret>
ADMIN_SESSION_SECRET=<different high-entropy secret>
ALLOWED_ADMIN_ORIGINS=https://admin.ndahiconnect.net
SESSION_COOKIE_SECURE=true
ADMIN_USERNAME=owner
ADMIN_BOOTSTRAP_PASSWORD=<unique password of at least 14 characters>
WEBAUTHN_RP_ID=admin.ndahiconnect.net
SECRET_PEPPER=<high-entropy hashing pepper>
```

See the local `.env` for session durations, OTP/SMS, payment, RouterOS, Omada and PostgreSQL settings. Live adapters require credentials issued by each provider; mock mode does not claim they are live.

For production, edit the single `.env`, set `NODE_ENV=production`, and replace every local or placeholder value. The API validates this configuration at startup and refuses to run with mock adapters, JSON-file persistence, insecure URLs/cookies, placeholder secrets, disabled administrator MFA, or an unconfigured provider. Flutterwave is the only production payment processor; configure its dashboard webhook as `https://api.ndahiconnect.net/api/webhooks/flutterwave` and set the same secret hash in `FLW_SECRET_HASH`.

For production persistence, create a PostgreSQL database, set `DATABASE_URL`, then run `npm run migrate:postgres`. The API automatically uses PostgreSQL when `DATABASE_URL` is present and retains atomic JSON persistence for local development. Set `DATABASE_SSL=false` only for a trusted local instance or Render's same-region private database URL; external database connections must use TLS.

After deploying the fixed `NC-XXXX-XXXX` voucher format, stop API writers and run `npm run migrate:vouchers` once with the production environment loaded. The migration updates only voucher codes in a single database transaction, preserves all related subscription state, and then re-synchronizes every voucher with the RouterOS bridge. It is idempotent and safe to re-run.

MikroTik live mode calls the restricted HTTPS management bridge configured by `MIKROTIK_API_URL` at `/ndahi/syncVoucher`, `/ndahi/disconnectDevice`, `/ndahi/disconnectVoucher`, `/ndahi/readUsage`, and `/ndahi/markInactive`. The versioned `syncVoucher` payload contains the voucher ID, Hotspot username/password, plan profile, absolute expiry, total-byte limit, simultaneous-user limit, and enabled state; it excludes customer and payment identifiers. Usage imports only accept monotonic byte counters. Omada status uses a server-side controller token; neither controller credential is exposed to either frontend.

## Production deployment

The repository includes a Render Blueprint and GitHub Actions quality gate. Follow [docs/render-deployment.md](docs/render-deployment.md) to deploy the customer portal, admin panel, API, and PostgreSQL before attaching live DNS.

1. Create DNS `A`/`AAAA` or provider-appropriate `CNAME` records for `portal`, `admin` and `api` pointing to their respective ingress services.
2. Issue and automatically renew trusted TLS certificates for all three hostnames. Redirect HTTP to HTTPS and enable HSTS after validating every hostname.
3. Deploy the customer static process with `APP_KIND=customer` and expose only `portal.ndahiconnect.net`.
4. Deploy the admin static process with `APP_KIND=admin` and expose only `admin.ndahiconnect.net`. Add VPN/IP/access-proxy restrictions where practical.
5. Deploy `server.mjs` behind `api.ndahiconnect.net`; do not route portal or admin paths to it.
6. Set exact origins—never `*`—and preserve `Access-Control-Allow-Credentials`. Do not broaden cookie domains; host-only cookies keep customer and admin sessions on their appropriate subdomains.
7. Terminate TLS at a trusted reverse proxy, pass the real client IP only from trusted proxies, apply edge rate limits, and restrict body sizes.
8. Keep RouterOS API-over-TLS behind a VPN/restricted management network. Do not expose MikroTik or Omada management publicly.
9. Replace JSON persistence with PostgreSQL plus transactions/unique constraints before running multiple API replicas. The current atomic JSON store is a single-process pilot.
10. Configure encrypted backups, secret rotation, audit retention, webhook reconciliation, monitoring and alerts before launch.

The physical path remains Starlink → RB5009 → managed PoE/injector → EAP650-Outdoor. Enable client isolation, block management networks, use surge protection/grounding and UPS backup, and field-test around walls and metal roofing.

## Verification

```bash
npm run check
npm run build
npm test
npm run load-test
```

Tests cover catalogue/voucher behavior, OTP/session expiry, concurrency, customer/admin route separation, cross-role cookie rejection, CORS rejection, role-specific logout, admin login throttling, audit logging and cookie attributes. The 300-user harness reports activations, redemptions, failures, median/p95 latency, active sessions, integrity counts and persistence races.
