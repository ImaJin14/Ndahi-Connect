# Status authorization browser checks

This check contributes to TEST-001/002 for payment status authorization using only an
in-memory store, the mock payment adapter, and the local customer static assets.
It verifies that an anonymous request, a wrong checkout key, and another
checkout key receive `404` without a payment, activation code, or private
`requestKey`; that the correct guest key succeeds; and that the payment owner
can read status through a customer session, including a legacy payment whose
key was removed. A foreign owner and an expired owner session are rejected.

The browser portion uses the real interrupted-checkout recovery UI at a 390px
viewport. It confirms the private key is sent, resumes a paid guest checkout,
completes PIN setup, reaches the dashboard, clears the saved checkout, and
does not overflow horizontally. Remote requests are blocked.

## Repeatable command

For a standalone run, install the pinned browser runner outside the repository:

```sh
npm install --prefix /tmp/ndahi-status-browser --no-save --ignore-scripts \
  --package-lock=false playwright@1.63.0
/tmp/ndahi-status-browser/node_modules/.bin/playwright install chromium
```

From the repository root:

```sh
STATUS_AUTH_API_PORT=8298 STATUS_AUTH_PORT=8297 \
  PLAYWRIGHT_MODULE=/tmp/ndahi-status-browser/node_modules/playwright/index.mjs \
  LOG_LEVEL=warn \
  node scripts/check-status-authorization-journeys.mjs
```

When the runner supplies a managed Chrome binary, add
`PLAN_CHROME_PATH=/absolute/path/to/chrome`. The API and static server ports
are independent and can be changed with `STATUS_AUTH_API_PORT` and
`STATUS_AUTH_PORT`.

Reviewed and verified by Codex on 2026-10-05 with Playwright 1.63.0 and local Chrome.
This focused suite does not complete the broader administrator/browser testing
checklist; those journeys remain in the shared agent task board's follow-up queue.
