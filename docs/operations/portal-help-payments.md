# PORTAL-001/002: welcome, public help and payment deadlines

The Home heading greets the signed-in customer by first name. Missing and generic names use “Welcome back”. Account offers a display-name editor; past transaction and receipt snapshots are preserved. Names are rendered as text/escaped HTML.

`/help` is public and works without authentication. Native disclosure sections explain login, older devices, coverage restrictions, payment expiry and deduction concerns, alternate payers, vouchers, device limits, renewal/switching, refunds, recovery, profile changes and app updates. Deep links open the relevant answer. Login, verification, PIN recovery, checkout and the portal link to Help. The page displays existing public service status and maintenance notes when available. Support can be configured on the customer web service with `SUPPORT_EMAIL` and `SUPPORT_PHONE`; only validated public contact values enter `/config.js`. With neither set, customers are directed to their NDAHI service point. No support address is invented, and no PIN or voucher is placed in a support link.

## Deadlines and money outcomes

New checkout records snapshot both approval (`paymentExpiresAt`) and final confirmation (`paymentClosesAt`) deadlines. Defaults remain five minutes plus two minutes of grace. Older records derive deadlines from their recorded creation/approval time and configured timing. The API returns server time so visible countdowns do not depend on the customer's clock. Client timers are informational; the server alone closes checkouts.

The billing worker closes all overdue checkouts before its bounded provider-processing batch, so a slow provider or a backlog cannot delay local expiry. A reservation never submitted to a provider expires at its approval deadline and is never submitted afterwards. Authenticated dashboard reads also close that customer's overdue checkouts, including when a worker is down. Status/recovery/new-purchase paths retain their expiry checks. Existing confirmed, refunding and review-held transactions are preserved.

Pending checkout and payment-history screens show a countdown; the visible portal refreshes pending history and retains edited refund forms. Closed records remain in history, expose their closure/recovery message and provide a copyable reference and contextual help. The provider's eventual verified result can still settle once within the existing late-confirmation rules. If another purchase conflicts, activation requires support review. Expiry is not proof that no money moved; customers who were deducted should check the original payment/contact support before approving a replacement.

A paid order requiring activation review is labelled separately. Refunds requested/submitted more than 24 hours ago show support attention without changing their financial status. Existing payment/refund monitoring continues; the subsequent recovery PR adds an audited admin provider recheck beyond the automatic late window.

## Verification and rollout

Deploy the API before the portal for deadline metadata and name editing. No SQL migration is needed. Preserve purchase-only Wi-Fi restrictions. Enable and observe the billing worker in production; dashboard expiry is a fallback, not a replacement for provider reconciliation.

API/unit coverage verifies owner/CSRF protection, name/receipt separation, immutable deadlines, dashboard expiry isolation, bulk expiry before slow provider work and refund attention without fabricated payout. Browser coverage verifies responsive welcome/name changes, safe name rendering, public FAQ deep links/support contacts and automatic payment-history expiry, alongside the prior portal journeys. Real provider delivery, physical devices, router timing and deployment rollback remain live verification tasks.
