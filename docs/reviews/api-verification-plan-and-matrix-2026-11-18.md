# Platform API Verification Plan & Phase 1 Audit Matrix

**Date:** 2026-11-18  
**Target Baseline:** `origin/main` (`543be72`, PR #294) inspected in clean worktree `.worktrees/api-verification-audit` (branch `chore/api-verification-audit`)  
**Audit Tool:** `scripts/check-api-surface.mjs`

---

## 1. Phase 1 Static & Contract Audit Results

- **Pages audited:** `customer-app-v2` (18 HTML pages), `customer-app` (15 HTML pages), `admin-app-v2` (4 HTML pages), `admin-app` (4 HTML pages), `store-app` (1 HTML page).
- **API surface:** `147` distinct frontend endpoint references across `customer-app*`, `admin-app*`, `store-app`, and `shared-app`; `161` route literals (plus dynamic suffix/regex routes) across `lib/api/*.mjs`.
- **Route & Asset Integrity:**
  - `0` unmatched frontend `/api/*` calls (`unmatchedApi: []`).
  - `0` broken HTML `<script>`, `<link>`, or local page links (`brokenHtmlRefs: []`; `/vendor/webauthn.js` and `/vendor/web-vitals.js` are dynamically injected by `lib/static-assets.mjs`).
  - Every `customerCsrfPaths` endpoint called by `customer-app-v2` / `store-app` sends `x-csrf-token`.

### Actionable Findings Discovered in Phase 1

1. **CSRF gap (`lib/api/state.mjs` & `lib/api/device-management.mjs`):**
   - `POST /api/account/device-management/current/reset` and `POST /api/account/device-management/nickname` both authenticate via the `dashboardSessions` cookie and mutate account/session state, yet neither is listed in `customerCsrfPaths` (`lib/api/state.mjs`) nor enforces `x-csrf-token` inline in `lib/api/device-management.mjs`.
   - Note: `customer-app-v2/current-wifi.js` and `customer-app-v2/app.js` already send `x-csrf-token` via `call()`, so adding both routes to `customerCsrfPaths` is safe and non-breaking.
2. **Admin role-gate mismatch (`lib/api/admin.mjs` vs `lib/admin-sensitive-actions.mjs` & `admin-app-v2/profile.js`):**
   - `lib/admin-sensitive-actions.mjs` explicitly defines `pin_change` in `selfService` for all `adminRoles` (`owner`, `operator`, `reseller`, `auditor`), and `admin-app-v2/profile.js` renders `#adminPassword` for every signed-in staff role.
   - However, `selfServicePaths` in `lib/api/admin.mjs` omits `/api/admin/profile/password` and `/api/admin/profile/pin`, causing `operator`, `reseller`, and `auditor` roles to receive `403` when submitting the password/PIN change form.

### Backend Endpoints with Zero Exact Test/Script References (Prioritize in Phase 2)

From Phase 1 cross-referencing `lib/api/*.mjs` against `test/*.mjs` and `scripts/*.mjs`:
- **Customer / Public / Store:** `/api/home/config`, `/api/store/receipt`, `/api/account/store/order`, `/api/account/store/receipt`, `/api/webhooks/flutterwave`
- **Admin:** `/api/admin/devices/disconnect`, `/api/admin/home/pilot-template`, `/api/admin/home/retry`, `/api/admin/integrations/omada`, `/api/admin/network/setup/*` (sub-actions beyond `status`/`purchase-access`), `/api/admin/profile/mfa`, `/api/admin/profile/passkeys/{options,verify,remove}`, `/api/admin/profile/password`, `/api/admin/profile/pin`, `/api/admin/resellers/*`, `/api/admin/vouchers/{print,print-pdf,print-preview,resend-email}`

---

## 2. Complete Page → Action → API Matrix (`origin/main`)

### A. Customer Portal (`customer-app-v2/`, default UI)

| Page / View | User Actions | API Endpoints | Auth / CSRF / Gate |
| :--- | :--- | :--- | :--- |
| `onboarding.html` (`/`) | Load status, plans, Home config, purchase gate; buy bundle; recover/resume checkout; check payment; mock confirm; setup checkout | `GET /api/status`, `GET /api/plans`, `GET /api/home/config`, `GET /api/purchase/access`, `POST /api/purchase`, `POST /api/purchase/recover`, `GET /api/payments/:id/status`, `POST /api/payments/:id/confirm` (mock), `GET/POST /api/account/setup/checkout` | Public / `x-checkout-key` / Coverage gate on purchase |
| `login.html` (`/login`) | Check auth policy; sign in with PIN; passkey options & verify; local/access begin & complete | `GET /api/authentication-policy`, `POST /api/account/login/pin`, `POST /api/account/passkey/options`, `POST /api/account/passkey/verify`, `POST /api/account/access/begin`, `POST /api/account/access/complete` | Public + `authEdgeScopes` (`customer-auth`) |
| `forgot-pin.html` (`/forgot-pin`) | Request email PIN reset; confirm PIN reset; backup-code PIN reset | `POST /api/account/pin-reset/request`, `POST /api/account/pin-reset/confirm`, `POST /api/account/pin-reset/backup` | Public + `authEdgeScopes` (`pin-reset`) |
| `verify.html` | Inspect checkout setup handoff; complete PIN setup | `GET /api/account/setup/checkout`, `POST /api/account/setup/pin` | Setup token / `authEdgeScopes` |
| `claim.html` | Check gift code + phone; complete claim/setup; redeem immediately | `POST /api/account/claim/check`, `POST /api/account/claim/complete`, `GET /api/account/dashboard`, `POST /api/account/profile/email`, `POST /api/vouchers/redeem` | Public claim token -> Customer session |
| `gift.html` | Check recipient number case; purchase gift bundle; poll gift payment | `GET /api/account/dashboard`, `GET /api/plans`, `POST /api/account/gift/recipient`, `POST /api/account/plan/purchase`, `GET /api/account/payments/:id/status` | Customer session + CSRF |
| `index.html` (`/dashboard#home`, `#internet`, `#shop`, `#activity`, `#account`, subpages) | Load dashboard, bundle status, connectivity; buy/renew/switch bundle; redeem voucher; view/rotate/download QR; view receipt JSON/PDF, email receipt, request refund; manage devices (rename, connect, disconnect, main device, forget, current Wi-Fi reset/identify); browse shop, checkout, verify order, order receipt; edit profile (name, email, phone), PIN, passkeys, backup codes, revoke sessions, logout everywhere, push subscribe/unsubscribe, notifications, logout | `GET /api/account/dashboard`, `GET /api/account/bundle-status`, `GET /api/account/connectivity`, `POST /api/account/plan/purchase`, `POST /api/vouchers/redeem`, `GET /api/account/vouchers/:id/qr`, `GET /api/account/vouchers/:id/download`, `POST /api/account/qr-connect/rotate`, `GET /api/account/payments/:id/status`, `GET /api/account/payments/:id/receipt`, `POST /api/account/payments/receipt-email`, `POST /api/account/payments/refund`, `GET /api/account/device-management`, `GET /api/account/device-management/current`, `POST /api/account/device-management/current/identify`, `POST /api/account/device-management/current/reset`, `POST /api/account/device-management/nickname`, `POST /api/account/device-management/main(/options)`, `POST /api/account/device-management/disconnect(/options)`, `POST /api/account/device-management/forget(/options)`, `POST /api/account/devices/(connect\|disconnect)`, `GET /api/account/wifi-devices`, `POST /api/account/wifi-devices/disconnect`, `GET /api/account/wifi-devices/operations/:id`, `GET /api/store/catalogue`, `GET /api/account/store/context`, `POST /api/account/store/{checkout,order,verify,receipt}`, `POST /api/account/profile/{name,options,/,email,email/options,email/confirm,phone,phone/options}`, `GET /api/account/security`, `GET /api/account/security/actions/:id`, `POST /api/account/security/pin(/options)`, `POST /api/account/security/account-backup/{options,generate}`, `POST /api/account/passkeys/{proof/options,options,verify,rename,remove}`, `POST /api/account/security/sessions/revoke`, `POST /api/account/security/logout-everywhere`, `GET/POST /api/account/notifications`, `GET /api/account/push`, `POST /api/account/push/{subscribe,unsubscribe}`, `POST /api/account/logout` | Customer session (`dashboardSessions`) + `x-csrf-token` *(fix gap on `current/reset` and `nickname`)* |
| `hotspot.html` (`/hotspot`) | Check Wi-Fi/pairing config & connectivity; direct connect or request pairing; QR connect | `GET /api/status`, `GET /api/account/connectivity`, `GET /api/account/dashboard`, `GET /api/wifi/pairing/config`, `POST /api/wifi/pairing/{request,status}`, `POST /api/account/device-management/connect(/options)` | Public pairing / Customer session + CSRF |
| `pair.html` (`/pair`) | Request pairing, poll status, cancel, redeem 6-digit code | `GET /api/wifi/pairing/config`, `POST /api/wifi/pairing/{request,status,cancel,redeem}`, `GET /api/account/dashboard` | Public (`credentials: omit`) + `wifi-pairing` edge scope |
| `pair-review.html` | Review & approve/decline pairing request | `GET /api/account/device-management/pairing`, `POST /api/account/device-management/pairing/{approve,decline}` | Main device controller + CSRF |
| `voucher-connect.html` | Begin/verify QR voucher connect; poll pairing | `POST /api/account/qr-connect/{begin,options,verify}`, `POST /api/wifi/pairing/{request,status}` | QR token / PIN or Passkey proof |
| `voucher-ready.html` | Load purchased voucher, QR, and PDF download | `GET /api/account/dashboard`, `GET /api/account/vouchers/:id/qr`, `GET /api/account/vouchers/:id/download` | Customer session |
| `voucher-print.html` | Preview & download thermal voucher PDF | `GET /api/account/dashboard`, `POST /api/account/vouchers/{print-preview,print-pdf}` | Customer session + CSRF |
| `home-router.html` | Register Home account; inspect Home status; enroll/confirm/mode/revoke/retry; purchase Home bundle | `GET /api/home/config`, `POST /api/account/home/register`, `GET /api/account/home`, `POST /api/account/home/{enroll,options,confirm,mode,revoke,retry}`, `POST /api/account/plan/purchase`, `GET /api/account/payments/:id/status` | Customer session + CSRF + WISP coverage gate on register/enroll/confirm |
| `wifi-connected.html`, `billing-terms.html`, `help.html`, `ui-kit.html` | Static / status info pages (plus telemetry vitals when enabled) | `GET /api/status` (where mounted), `POST /api/telemetry/vitals` | Public |

---

### B. Admin Console (`admin-app-v2/`, default UI)

| Page / View | User Actions | API Endpoints | Role / CSRF Gate |
| :--- | :--- | :--- | :--- |
| `login.html` (`/login`) | 2-step login (email/username + password/PIN -> passkey or passkey-setup); legacy passkey login | `POST /api/admin/login`, `POST /api/admin/login/passkey`, `POST /api/admin/login/passkey-setup`, `POST /api/admin/passkey/{options,verify}` | Public + `authEdgeScopes` (`admin-auth`) |
| `index.html` (`#home`, `#devices`, `#connections`, `#network-setup`, `#bundles`, `#vouchers`, `#voucher/:id`, `#payments`, `#cash`, `#customers`, `#customer/:id`, `#resellers`, `#store`, `#products`, `#audit`, `#profile`) | Operations summary, zone & notifications; live devices refresh/disconnect/usage-sync/Omada status; router command replay/resolve & incident details; network setup wizard & purchase-access diagnostic; bundle create/update/delete; voucher generate/classify/reserve/revoke/detail/print/resend-email; payment status/verify/refund/refund-check/webhook-replay/settlements/CSV export; customer records/filters/bulk-gift/suspend/recovery; reseller ledger/commission/remittances/adjustments; store settings/categories/products/stock/orders/receipt/refund/verify; profile email/PIN/passkeys & staff management; logout | `GET /api/admin/dashboard`, `GET /api/admin/records`, `GET /api/admin/export`, `GET/POST /api/admin/notifications`, `POST /api/admin/zone`, `GET /api/admin/wifi-devices`, `POST /api/admin/wifi-devices/{refresh,disconnect}`, `POST /api/admin/devices/disconnect`, `POST /api/admin/integrations/sync-usage`, `GET /api/admin/integrations/omada`, `POST /api/admin/network/commands/{replay,resolve}`, `GET /api/admin/network/incidents/:id`, `GET /api/admin/network/setup/status`, `POST /api/admin/network/setup/{connection,discover,purchase-access,assisted-connections,preview,apply,confirm,rollback,refresh,recovery,resolve,activate,cancel}`, `POST /api/admin/bundles{,/update,/delete}`, `GET /api/admin/vouchers/:id/details`, `POST /api/admin/vouchers/{generate,classify,reservation,revoke,print,print-preview,print-pdf,resend-email}`, `POST /api/admin/payments/{verify,refund,refund/check,webhooks/replay}`, `GET /api/admin/settlements`, `POST /api/admin/customers/{bulk,suspend,recovery}`, `GET /api/admin/resellers/ledger`, `POST /api/admin/resellers/{commission,remittances,adjustments}`, `GET /api/admin/store`, `POST /api/admin/store/{receipt,products/save,products/delete,categories/save,categories/delete,settings/save,stock/adjust,orders/update}` (order actions `ready`, `collect`, `cancel`, `contact`, `notes`, `rotate-link`, `refund`, `refund-reference` and `verify` are sent to `orders/update` as `action`), `POST /api/admin/profile/{proof/options,email,password,pin,passkeys/options,passkeys/verify,passkeys/remove}`, `POST /api/admin/users{,/deactivate,/passkeys/remove}`, `POST /api/admin/logout` | Admin session (`adminSessions`) + CSRF (`x-csrf-token`) + Role rules (`owner`, `operator`, `reseller`, `auditor`) *(fix `selfServicePaths` for `/profile/password` & `/profile/pin`)* |
| `home-routers.html` | Inspect Home readiness, pilot template, pilot update, retry/revoke | `GET /api/admin/home`, `GET /api/admin/home/readiness`, `GET /api/admin/home/pilot-template`, `POST /api/admin/home/{pilot,retry,revoke}`, `POST /api/admin/logout` | Admin session (`owner` / `operator` read) + CSRF |
| `voucher-print.html` | Render thermal voucher batch & download PDF | `GET /api/admin/dashboard`, `POST /api/admin/vouchers/{print-preview,print-pdf}` | `owner`, `operator`, `reseller` + CSRF |

---

### C. Device Store (`store-app/`) & Non-UI / Webhook Endpoints

- **Device Store (`store-app/index.html`):**
  - Browse catalogue (`GET /api/store/catalogue`), detect signed-in account (`GET /api/account/store/context`), guest or account checkout (`POST /api/store/checkout` / `POST /api/account/store/checkout`), track order (`POST /api/store/order` / `POST /api/account/store/order`), verify payment (`POST /api/store/verify` / `POST /api/account/store/verify`), download PDF receipt (`POST /api/store/receipt` / `POST /api/account/store/receipt`), claim guest order into signed-in account (`POST /api/account/store/claim`).
- **Probes, Telemetry & Provider Webhooks:**
  - `GET /api/health`, `GET /api/metrics`, `POST /api/telemetry/vitals`, `POST /api/csp-report`, `POST /api/webhooks/mesomb`, `POST /api/webhooks/flutterwave`.

---

## 3. Execution Roadmap (Phases 2–4)

### Phase 2 — Fix Static Findings & Run Complete API + PostgreSQL 17 Contract Suite
1. **Patch the 2 Phase 1 findings** (after verifying tests):
   - Add `/api/account/device-management/current/reset` and `/api/account/device-management/nickname` to `customerCsrfPaths` in `lib/api/state.mjs`.
   - Add `/api/admin/profile/password` and `/api/admin/profile/pin` to `selfServicePaths` in `lib/api/admin.mjs`.
   - Enable `node scripts/check-api-surface.mjs --strict` in `npm run check` / CI.
2. **Run baseline suites against PostgreSQL 17:**
   - `npm run check && npm run check:ui-v2`
   - `TEST_DATABASE_URL=... npm test` (with both `STORE_TARGETED_READS=true` and `false`)
   - `npm run check:providers` and `npm run load-test`
3. **Add `test/api-contract-matrix.test.mjs`:**
   - Exercise every endpoint in Section 2 against real HTTP requests + PostgreSQL 17, covering: happy path + schema assertions, `401` unauthenticated, `403` missing CSRF / untrusted Origin / cross-customer ownership / disallowed admin role (`operator`, `reseller`, `auditor`), `400` invalid payloads, `404` missing IDs, `409` state conflicts, `429` edge throttling, and `503` unconfigured provider/bootstrap mode.
   - Specifically cover the zero-exact-reference endpoints listed in Section 1 (`/api/home/config`, `/api/store/receipt`, `/api/account/store/{order,receipt}`, `/api/webhooks/flutterwave`, `/api/admin/resellers/*`, `/api/admin/network/setup/*`, `/api/admin/integrations/omada`, `/api/admin/devices/disconnect`, `/api/admin/profile/*`, `/api/admin/vouchers/{print,print-preview,print-pdf,resend-email}`).

### Phase 3 — End-to-End Playwright Verification per Page & Action
1. Run `npm run test:browser:v2`, `npm run test:browser`, `npm run check:store:browser`, `node --test test/redesign-browser/*.test.mjs`, and `node scripts/check-phase6-sign-in-journeys.mjs`.
2. Add a shared Playwright network/console assertion guard (`pageerror`, `console.error`, `requestfailed`, unexpected `>= 400` responses, CSP violations) across page-by-page action flows at `390px` and `1280px`/`1440px` for:
   - Customer `v2` (and `v1` parity check): every HTML page + every `#dashboard` tab & sub-view + simulated `401`/`403`/`429`/`503` recovery states.
   - Admin `v2` (and `v1` parity check): all 4 staff roles (`owner`, `operator`, `reseller`, `auditor`) across every menu item & action form.
   - Store (`store-app`): guest + signed-in flows, closed/empty catalogue, order tracking, receipt PDF, claim.

### Phase 4 — Staging & Production Verification
1. Extend `scripts/check-deployment.mjs` to include `STORE_APP_URL` (`store-app` `/`, `/config.js`, `/api/store/catalogue`, `/api/account/store/context`, store CORS) and `/api/home/config`.
2. Run read-only smoke checks against staging and production (`npm run check:deployment`).
3. Execute authorized physical acceptance tests for live boundaries that cannot be proven by mocks: MTN/Orange Mobile Money live payment + low-balance refusal + refund, MikroTik RB5009 / Omada live connect/disconnect/usage sync, Resend transactional email delivery, and physical Note 8 / iPad Air 2 browser passes.
