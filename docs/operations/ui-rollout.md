# UI v2 rollout

The customer portal and the admin app can serve a redesigned front end (v2) side by
side with the current one (v1). Only the pages change: both versions call the same
API, sessions and database. The store and the MikroTik hotspot pages have a single
version and are not affected.

| Version | Customer folder    | Admin folder    |
| ------- | ------------------ | --------------- |
| v1      | `customer-app/`    | `admin-app/`    |
| v2      | `customer-app-v2/` | `admin-app-v2/` |

The v2 folders start as exact copies of v1. Every v2 page marks its root element
with `data-ui-variant="v2"`, so testers can confirm which version they are on
(browser developer tools → Elements → `<html>`). v1 pages have no marker.

## How a visitor's version is chosen

`static-server.mjs` decides on every request, in this order (`lib/ui-variant.mjs`):

1. `UI_V2_OFF=true`: always v1. The kill switch overrides everything below,
   including saved cookies, and leaves those cookies unchanged.
2. `?ui=new` or `?ui=old` in the URL: v2 or v1. The server saves the choice and
   redirects to the same URL without `ui`.
3. A saved choice: `ndahi_portal_ui` on the portal, `ndahi_admin_ui` on admin.
4. A legacy `ndahi_ui=v2` cookie (an earlier opt-in or v2 sample): v2.
5. The app's default. **Both apps default to v2**, as authorized by the owner on
   13 November 2026 (admin first, then the customer portal the same day).
   `ADMIN_UI_DEFAULT=v1` on `ndahi-admin` or `CUSTOMER_UI_DEFAULT=v1` on
   `ndahi-customer` keeps that app on the earlier v1 default; unset or `v2`
   selects v2.

Only explicit `?ui=` choices are saved under the v2 default. Computed defaults are
not saved, so a later default change takes effect on the next navigation for
anyone without a deliberate choice. Use `UI_V2_OFF=true` to force v1 for everyone,
including people who explicitly chose v2.

With `CUSTOMER_UI_DEFAULT=v1` the portal behaves as it did before: a saved
`ndahi_ui` cookie wins, and a visitor without one is sampled by `UI_V2_PERCENT`
(0–100, default 0) and the result is saved as `ndahi_ui`. Under the v2 default
`UI_V2_PERCENT` has no effect. Admin is never sampled.

The cookies are host-only, `Path=/`, `SameSite=Lax`, `HttpOnly`, and last 30 days.
They are not renewed on later visits. They are `Secure` under the same rule as API
session cookies: `SESSION_COOKIE_SECURE` when set, otherwise in production. These
are interface preferences; authentication/session cookies are unchanged.

The separate choice cookies migrate browsers that hold the old automatically saved
`ndahi_ui=v1` (every portal visitor while the percentage was 0, and every admin
visitor) to v2 on their next navigation. Legacy `ndahi_ui=v2` opt-ins still work.
An explicit `?ui=old` writes `ndahi_portal_ui=v1` or `ndahi_admin_ui=v1`, so a
deliberate old-view choice is kept; `?ui=new` switches it back.

Every path (pages, `sw.js`, the manifest, `/version.json`) is served from the chosen
folder, and each folder has its own release ID. Pages, `sw.js` and `/version.json`
are sent with `Cache-Control: private` and `Vary: Cookie`, so no shared cache mixes
the two versions. Versioned `/static/…` files are named after their content: they
stay publicly cacheable, never set the cookie, and a page still open on the other
version can keep loading its own files (except while the kill switch is on).

Switching version needs no extra client code. The next navigation loads the other
version's pages from the network, the browser installs the other version's `sw.js`
(the files differ, and v2 cache names contain `v2`), and tabs that are already open
see a new release ID from `/version.json` and offer **Refresh app** through the
existing update notice (`shared-app/updates.js`).

Both versions share the same browser storage on each site (local storage, session
storage, cookies). Redesign changes must keep stored data compatible with v1, or
use new storage keys.

Invalid values stop the service: `UI_V2_PERCENT` must be a whole number from 0 to
100 and `UI_V2_OFF` must be exactly `true` or `false` (unset means 0 and `false`).
`ADMIN_UI_DEFAULT` (admin only) and `CUSTOMER_UI_DEFAULT` (portal only) must be
`v1` or `v2` when nonempty; each app ignores the other's setting. The pre-deploy
`npm run check:environment` reports invalid rollout values before a deploy.
It only warns when a valid value differs from the Blueprint default, so a ramp or
rollback made in Render never blocks a deploy.

## Choose a version (testers, staff and support)

- Open any page with `?ui=old` for v1 or `?ui=new` for v2, for example
  `https://portal.ndahiconnect.net/login?ui=old` or
  `https://admin.ndahiconnect.net/login?ui=old`. v2 pages carry
  `data-ui-variant="v2"` on `<html>`.
- Clearing site data removes the choice and restores the app's default (v2).
- Choices are logged by the static servers as `ui.variant_requested` with `kind`
  and `variant`.

## Browser verification

The existing v1 browser journey lane runs with `ADMIN_UI_DEFAULT=v1` and
`CUSTOMER_UI_DEFAULT=v1`; its labels and navigation assertions continue to test
the retained v1 screens. Run it locally with
`ADMIN_UI_DEFAULT=v1 CUSTOMER_UI_DEFAULT=v1 npm run test:browser` (and the same
prefix for individual v1 journeys). `npm run test:browser:v2` explicitly opts into
v2. The HTTP default-policy tests (`test/ui-variant.test.mjs`) use an empty
environment to verify both v2 defaults, legacy preference migration, deliberate
old-view choices, the kill switch and the v1-default sampling path. The cold-route
and role-isolation browser suites (`test/redesign-browser/`) verify fresh and
legacy-cookie defaults and explicit old/new choices at 390 and 1280 px on the
portal and on admin.

## Roll back

1. To return everyone to v1 at once, set `UI_V2_OFF=true` on `ndahi-customer`
   and/or `ndahi-admin` in Render, then save. After the deploy every visitor
   receives v1, whatever their cookie says. Open tabs switch at their next
   release check. Commit `UI_V2_OFF: "true"` to `render.yaml` straight away;
   until that PR merges, a Blueprint sync would set it back to `false`.
2. To restore the v1 default but keep deliberate v2 choices, set
   `CUSTOMER_UI_DEFAULT=v1` (portal) or `ADMIN_UI_DEFAULT=v1` (admin) instead.
   Visitors with `?ui=new` choices or legacy v2 cookies stay on v2; on the portal,
   `UI_V2_PERCENT` samples everyone else again.
3. Once v2 is fixed, lift the kill switch with `UI_V2_OFF=false` (and remove the
   `*_UI_DEFAULT=v1` override if you set one). Visitors without a deliberate choice
   return to the v2 default on their next navigation.

To move a single person, send them a link with `?ui=old` or `?ui=new`.

## What to compare before each step

Web vitals have a `variant` label (`ndahi_web_vital_lcp`, `…_inp`, `…_cls`), sent by
`shared-app/performance.js` from the page marker. Compare the 75th percentile on
mobile against the targets in [performance](performance.md) and against v1:

```promql
histogram_quantile(0.75, sum by (le, variant) (
  rate(ndahi_web_vital_lcp_bucket{app="customer", device="mobile"}[1d])))
sum by (variant) (increase(ndahi_web_vital_lcp_count{app="customer", device="mobile"}[1d]))
```

Gate each step on these checks:

- v2's LCP, INP and CLS meet the targets and are no worse than v1 by more than about
  10%, with at least 50 samples per version.
- The API success SLO (`ndahi:slo_error_ratio:*{slo="api_success"}`) and payment
  creation outcomes (`ndahi_request_duration_seconds_count{operation="payment_creation"}`
  by `outcome`) are no worse than in the period before the step.
- Payments settle at the usual rate (`payment.created` versus `payment.settled` in
  the API logs).
- No new `security.csp_violation` audit events, and no `static.assets_unavailable`
  errors (these include `variant`) from the static servers.
- No new support reports about the redesigned pages, and the browser journeys pass
  on both versions (`npm run test:browser` and `npm run test:browser:v2`).

**Limitation:** API-side logs and metrics (payments, errors, CSP reports) do not yet
say which version a request came from. The API runs on its own host, so it cannot
see the host-only `ndahi_ui` cookie. A request header would need a CORS change in
`lib/api/middleware.mjs`, which was out of scope for the switch. Until a follow-up
adds that, compare those signals before and after each step, not between versions
side by side.

## While v2 is still a copy

Until the redesign starts to differ from v1, apply every change to `customer-app/` or
`admin-app/` to the matching v2 folder as well. CI runs the browser journeys on both
versions (`Browser journeys on UI v2`), so a missed change usually fails there. To
copy a branch's v1 changes:

```bash
git diff origin/main -- customer-app admin-app \
  | sed -E 's#([ab])/(customer|admin)-app/#\1/\2-app-v2/#g' | git apply --reject
```

Many pages are a single line of HTML, so an edit on that line conflicts with the v2
marker and is saved as a `.rej` file next to the page. Make those edits by hand and
delete the `.rej` files. Add new v2 `.js` files to `check:ui-v2` in `package.json`.

Server code always uses v1 files: the voucher slip that `lib/email.mjs`,
`lib/voucher-pdf.mjs` and `lib/api/voucher-print.mjs` render comes from
`admin-app/voucher-slip.js`, and `scripts/prepare-hotspot-pages.mjs` only redirects
to the portal.

## Remove v1 at the end

1. Hold `UI_V2_PERCENT=100` for at least 30 days, so every saved v1 choice has
   expired, and confirm that the v1 web-vital counts have dropped to near zero.
2. Replace the v1 folders with v2: `git rm -r customer-app admin-app`, then
   `git mv customer-app-v2 customer-app` and `git mv admin-app-v2 admin-app`. The
   server-side imports of `admin-app/voucher-slip.js` then use the redesigned slip,
   so check receipts, voucher PDFs and emails.
3. Remove the switch: the variant code in `static-server.mjs`, `lib/ui-variant.mjs`,
   the `privateCache` and `Vary: Cookie` handling, `UI_V2_PERCENT`/`UI_V2_OFF` in
   both Blueprints and in `lib/environment-drift.mjs`, `check:ui-v2`,
   `test:browser:v2`, `scripts/ui-v2-journeys.mjs`, the CI job and
   `test/ui-variant.test.mjs`. Leftover `ndahi_ui` cookies are harmless and expire
   on their own.
4. Optionally drop the `data-ui-variant` marker and the `variant` web-vital label
   (alerts already aggregate it away), and rename the v2 service worker caches
   (`ndahi-shell-v2`, `ndahi-admin-shell-v2`).
5. Update this page to record that the rollout is complete.
