# Automatic Active Bundle display (#136)

The Home card is informational. It shows the recorded shared allowance, consumed
data and percentage, remaining data, validity/countdown, status and connected-device
count when the router observation is complete and current. Unlimited and unknown
values remain distinct from zero. Recorded account sessions are labelled as such
in mock mode; they do not establish a live router connection.

An authenticated, non-cacheable `GET /api/account/bundle-status` returns a compact
read model and the existing server purchase policy. Reading the balance never
deducts usage. A stale live reading requests the existing coalesced router usage
job; it neither creates parallel usage jobs nor retries a dead-lettered command.
The API does not return device addresses, voucher codes or contact details.

The browser reads once on entry, then every 15 seconds while Home is visible and
online. Failures back off to 15/30/60 seconds. Hidden/offline views pause, resume
events coalesce, unmount cancels work and invalidated/older responses cannot
replace current evidence. The local countdown does not invent consumption or
purchase eligibility. On local expiry the card waits for server confirmation.

Plan and voucher navigation live outside the card. Quick renew / Choose a bundle
appear only when the server confirms eligibility and no active allocation. The
existing backend protection from #132 remains authoritative for all purchases.

## Verification

- `node --test test/active-bundle.test.mjs test/data-fuel-gauge.test.mjs`
- `npm run check:active-bundle:browser` (320px and 1280px)
- `npm run check:notifications:browser` (existing low-data and error journeys)
- `npm run check` and the complete backend/CI suite before merging.

These are isolated fixtures. They do not prove live router counters, a physical
phone's captive browser behavior or production deployment. Record those checks
separately after deployment.
