# Device store release — 8 November 2026

## Behaviour

Adds a dedicated EN/FR equipment storefront, guest/account checkout, private tracking, account history, separate hardware order/payment processing, transactional inventory and reservations, verified settlement, late-payment review, collection verification, optional email updates and owner-only full refunds. Existing admin users manage catalogue/content CRUD, raster image uploads, categories, pricing, stock, orders and pickup/policy configuration through **More → Store**.

The catalogue starts empty and checkout closed. Equipment purchases never issue vouchers, change an internet bundle or overwrite an existing customer identity. Products and policy terms are snapshotted on orders. Financial/stock history is retained; referenced products are archived instead of deleted.

## Release preparation

The production API startup applies and verifies only the additive store uniqueness indexes before serving traffic, under the existing store lock. It refuses unexpectedly defined existing indexes. It does not import legacy state, modify customer rows, drop indexes or export credentials. Existing account reconciliation remains in the startup chain.

The Render Blueprint adds `ndahi-store` and `STORE_APP_URL` on the API. New service settings: `API_URL=https://api.ndahiconnect.net`, `CUSTOMER_APP_URL=https://portal.ndahiconnect.net`, start command `npm run start:store`, health `/healthz`. New hosting/Blueprint sync and DNS verification require the user's dashboard access. Checkout stays closed during deployment.

## Validation

- Prior complete local suite: 1,219 tests passed with disposable PostgreSQL 18.6, no failures/skips.
- Mobile/desktop Chromium: 30 checks passed at 320px/1280px, including product image upload, EN/FR guest checkout, tracking, catalogue/admin editing, inventory and lost-response recovery. Screenshots inspected.
- Release-specific schema checks cover additive/idempotent application, retained existing data and rejection of invalid index definitions. Hosted CI now includes the store browser journeys.
- No real payment, email, DNS, production database or router mutation was performed during local validation.

## Deployment evidence

[PR #187](https://github.com/ImaJin14/Ndahi-Connect/pull/187) merged as `62cb67e52d52ef52131bcd53f97b3bef1411b642` after all seven exact-head checks passed ([CI run](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/42436032522)). Hosted verification: 1,221 tests passed with zero failures/skips; provider contracts, both 300-customer load checks, browser journeys, monitoring and security checks passed.

API deployment `7630006738` / `dep-dbntf5jrjlhs739qtpkg` succeeded at 02:02:06 UTC. The public authentication-policy revision matches the merge; PostgreSQL is ready. Store catalogue returns HTTP 200 with the exact store CORS origin, `open: false`, zero products/categories and MeSomb configured. Startup strictly applies/verifies the additive store indexes before the API can listen.

The new store service is `srv-dbntf5jrjlhs739qtpig`, assigned `ndahi-store.onrender.com`. Its initial deployment failed because the new service lacked `API_URL`; the user confirmed adding the production API URL and requesting a redeploy. Storefront, admin/customer revisions, custom-domain DNS/HTTPS and final smoke checks remain pending verification. The user is performing the manual Blueprint/DNS walkthrough; no credentials were copied.

## User setup after deployment

1. Sync the existing NDAHI Blueprint and confirm the new store service and API store origin are present.
2. Set the new store's API URL to the existing production API; wait for successful builds.
3. Copy the exact custom-domain DNS target from Render and add the `store` CNAME at the domain's DNS provider. Verify the domain and HTTPS in Render.
4. In Admin → More → Store, add categories, products, images, real prices and stock. Configure contact, pickup and EN/FR warranty/returns terms before opening checkout.
5. Verify real payment/refund/collection and each advertised compatible device before public launch.

See [store operations](../operations/device-store.md) for reconciliation, permissions and limits. One product per checkout and one pickup location are supported; delivery and device-plus-bundle offers remain future phases.


Main CI [42436599613](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/42436599613) also passed. Admin deployment `7630077740` / `dep-dbntikgae00c7394r990` and customer deployment `7630077734` / `dep-dbntikgae00c7394r92g` succeeded at 02:07:55/56 UTC. Delivered revisions match (`admin: 78b3a63678eb144a025b`, `customer: dd10b52d2ee76d9b8efb`); five delivered HTML/JS/CSS SHA-256 comparisons match source, including the admin store module. All read-only deployment smoke groups pass.

The next store deployment `7630077630` / `dep-dbntik8ae00c7394r8ug` failed; its first error is requested from the user's dashboard. DNS setup is paused because IONOS proposes disabling existing mail-related records specifically under `store.ndahiconnect.net`. Root MX/SPF records remain present; the user is checking whether any store-subdomain mailboxes/forwarders are in use before proceeding. Do not treat that warning as permission to disable mail.

## Branding and navigation follow-up

The user confirmed the store is live after correcting API_URL. Public config and health checks verified the production API URL and expected store revision. DNS now resolves store.ndahiconnect.net to ndahi-store.onrender.com; old IONOS IPv6 and restrictive CAA records were absent in public checks. HTTPS issuance is still pending. The user confirmed saving the DNS change despite the mail-service warning; use of store-subdomain mailboxes remains unknown.

This follow-up adds the NS store header/favicon/touch icons/manifest and NA admin favicon links. Store is a primary admin tab beside Home; Customers, Bundles and Connections also move out of More. Existing role restrictions are retained. Local verification: 15 admin browser journeys, 6 final navigation/role checks, and 14 pending-state scenarios passed. Physical devices and real payments remain unverified. Deployment of this follow-up is pending.

Before PR #188 merge, custom-domain HTTPS became ready: the public store health endpoint returned HTTP 200 with body `ok`, and the API catalogue accepted Origin https://store.ndahiconnect.net. Chromium verified the content-hashed NS and NA favicon URLs serve PNG successfully, the NS header, and all store manifest icon URLs. Repository build passed.
