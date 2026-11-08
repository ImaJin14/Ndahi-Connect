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

Pending reviewed PR, hosted CI, merge and production verification. Do not treat the deployment configuration as evidence of a live store. Record exact revisions and service/deployment statuses here after verification.

## User setup after deployment

1. Sync the existing NDAHI Blueprint and confirm the new store service and API store origin are present.
2. Set the new store's API URL to the existing production API; wait for successful builds.
3. Copy the exact custom-domain DNS target from Render and add the `store` CNAME at the domain's DNS provider. Verify the domain and HTTPS in Render.
4. In Admin → More → Store, add categories, products, images, real prices and stock. Configure contact, pickup and EN/FR warranty/returns terms before opening checkout.
5. Verify real payment/refund/collection and each advertised compatible device before public launch.

See [store operations](../operations/device-store.md) for reconciliation, permissions and limits. One product per checkout and one pickup location are supported; delivery and device-plus-bundle offers remain future phases.
