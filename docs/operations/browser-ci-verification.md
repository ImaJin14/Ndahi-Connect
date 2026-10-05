# Browser CI verification

The browser job uses Node 22, the pinned `playwright@1.63.0` development
dependency, Chromium, and local system dependencies. It runs:

```sh
npm ci
npx playwright install --with-deps chromium
STATUS_AUTH_WIDTH=1440 ADMIN_AUTH_WIDTH=1440 npm run test:browser
STATUS_AUTH_WIDTH=390 npm run check:status:authorization
ADMIN_AUTH_WIDTH=390 npm run check:admin:authorization
```

The billing journey uses an in-memory store and mock payment adapter. The
status journey verifies checkout-key and session authorization, then exercises
the real customer recovery and PIN setup UI. The administrator journey seeds
synthetic owner, operator, auditor, and reseller accounts, signs in through the
real admin login and dashboard, checks desktop/mobile overflow, verifies an
allowed voucher operation, and verifies denied sensitive operations through
actual API responses. Playwright routing blocks every request outside the
local fixture origins. Billing also covers 390px and 320px screens; all four
administrator roles run at both 1440px and 390px. On failure each suite captures
the current browser page, and CI uploads the synthetic-fixture screenshots.

The focused checks do not claim the full TEST-001/002 scope. Broader coverage
still includes provider-backed payment verification, real network/router
behavior, production database persistence and migration interactions, passkey
and MFA ceremony coverage, and cross-browser/device matrix testing. No
real-provider verification is performed by this job.
