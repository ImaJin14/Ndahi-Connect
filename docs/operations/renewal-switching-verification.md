# Renewal and switching verification

Scope: UX-006 through UX-010. Implemented with two read-only Claude Code reviews,
focused helper and API tests, and rendered browser checks. Billing remains full
package price, with replacement and new validity beginning on confirmed payment.

## Current package display

Updated 2026-09-23 following the owner's copy review:

- Package cards show the total FCFA price, included data, validity, and device limit.
- Switching shows the current and proposed allowances alongside their differences.
- Renewal and upgrade/downgrade/lateral labels remain where relevant.
- Per-GB and per-day rates and their explanatory paragraph are not displayed.
- The generic "One-time package" and "Available once every 7 days" badges and the
  "across full validity" suffix have been removed.
- The Daily seven-day purchase restriction remains enforced and is explained in
  eligibility and checkout details. Removing the badge does not change eligibility.

Full-price payment, replacement timing, consent, and no-carryover disclosures remain
visible before payment. These copy changes do not alter package prices or billing rules.

## Automated checks

With Node 22 available:

```bash
npm test
npm run check
```

The final PR checkout passed the full suite of 166 tests on 2026-09-23, including
the simplified package copy. Coverage includes current-plan renewal,
expired/exhausted plans, Daily eligibility, discontinued plans, replacement timing,
idempotency, payment ownership, and session retention. After the final copy and
rate-display removals, all 7 UI-control tests, the onboarding syntax check, and the
whitespace check passed:

```bash
node test/ui-controls.test.mjs
node --check customer-app/onboarding.js
git diff --check
```

## Browser checks

`scripts/check-plan-journeys.mjs` starts a mock API and customer server on loopback,
using isolated in-memory data. It does not load `.env` or use production providers.
Its browser dependency can be installed outside the repository:

```bash
npm install --prefix /tmp/ndahi-browser-check --no-audit --no-fund playwright
PLAYWRIGHT_MODULE=/tmp/ndahi-browser-check/node_modules/playwright/index.mjs \
PLAN_CHROME_PATH=/usr/bin/google-chrome \
node scripts/check-plan-journeys.mjs
```

Use `PLAN_CHROME_PATH` for an installed Chrome/Chromium executable. Alternatively,
install Playwright's Chromium with its CLI and omit that variable. The script
closes its browser and servers after verification. Override `PLAN_PREVIEW_PORT`
and `PLAN_PREVIEW_API_PORT` if ports 8187 and 8188 are occupied.

All 13 scenarios passed on the final PR checkout on 2026-09-23, including the
copy and rate-display removals. The scenarios cover:

- Renewal limited to the actual current plan, even with a different query parameter.
- Replacement consent, read-only account details, session retention, and payment-key cleanup.
- Current-versus-proposed comparisons and full-price replacement disclosure.
- Desktop, 390px mobile, and 320px reflow without horizontal overflow.
- Keyboard focus containment/restoration and touch access to the last package.
- Accessible names for package articles and comparison tables.
- Daily cooldown, missing/discontinued plans, and custom-duration lateral changes.
- Locked selection while payment creation is in flight and reopening a pending checkout.
- Pending-payment restoration, authenticated cookie-path polling, and declined-payment retry.
- Payments confirmed while the page is closed, and logged-out return-to-login behavior.

Screenshots are written to `/tmp/ndahi-plan-checks` by default; use
`PLAN_SCREENSHOTS` to choose another output directory. Mobile and desktop
screenshots were visually inspected. These checks use mock payments and do not
prove live Mobile Money settlement or physical router provisioning. The 320px
viewport checks reflow equivalent to a narrow high-zoom viewport; it is not a
hardware screen-reader or browser-zoom audit.

Screenshots of the final package display were regenerated during PR verification
with `PLAN_SCREENSHOTS=/tmp/ndahi-plan-pr-checks`. Rerun the browser command to
capture fresh screenshots.

## Local preview

No browser automation dependency is needed to leave the demo running:

```bash
node scripts/check-plan-journeys.mjs --serve
```

Open `http://127.0.0.1:8187/preview` for renewal or
`http://127.0.0.1:8187/preview?action=switch` for switching. These preview-only links
sign into an isolated demo customer. Payments use a simulation button. Restarting
the process resets the demo. The production server does not expose these links.

## Remaining billing scope

The UI prevents another checkout while a known payment is pending and clears
completed request keys. It does not add a database-level lock across separate
tabs/devices or full payment recovery. Competing pending payments and stale
settlement reconciliation remain BILL-001 work. Existing suspended-account
purchase enforcement also needs a separate backend policy review.
