# Device store operations

## Scope and current state

The store is implemented as a fourth frontend in `store-app`, using the existing API and admin app. It supports EN/FR browsing, product details, guest or account checkout, MTN/Orange Money payments, pickup, private order tracking and account order history. Hardware orders never issue internet vouchers or change internet subscriptions.

The store starts **closed with an empty catalogue**. No product prices, stock, compatibility claims or pickup details are seeded in production. The browser journey script uses disposable fixtures only.

## Local development

Use Node.js 22 and the existing project dependencies. Run:

```bash
npm run start:api
npm run start:admin
npm run start:store
```

The store defaults to `http://localhost:8083`, admin to `http://localhost:8081`, and API to `http://localhost:8082`. Use the same hostname for all three services; `localhost` and `127.0.0.1` are different origins. Set `STORE_APP_URL` on the API when using another origin. Set `API_URL` on the frontend when using another API address. Local mock payments are available only under the existing development payment configuration; production rejects mock store checkout.

## Admin workflow

Sign in as owner or operator, open **More → Store**, then **Open store management**.

1. Create categories, including EN/FR names, sort position and visibility. Hidden categories hide their products from the public catalogue.
2. Create products with unique SKUs, EN/FR names and descriptions, specifications, compatibility, contents, warranty and setup guidance. Set the selling price in whole FCFA. Only owners can view/edit internal costs.
3. Upload up to four PNG/JPEG/WebP images. The admin browser resizes uploads to at most 960px; saved images must be under 175 KB each. Images and EN/FR alternative text can be reordered, replaced or removed. SVG/remote image URLs are not accepted.
4. Record stock receipts or removals in Inventory with a reason. The operation key makes retries safe. Stock cannot be removed below currently reserved quantities.
5. Publish products when ready. Products start with zero stock; stock changes use the ledger rather than product editing.
6. Configure store name, EN/FR introduction and announcement, contact details, pickup location/instructions/hours, and EN/FR warranty and returns terms. Open checkout only after these required details are complete.
7. Prepare paid orders, mark ready, and confirm pickup using the buyer's collection code. Record serial numbers, support notes, contact corrections and return status on the order.

Catalogue, stock and content changes appear on the next storefront refresh without redeploying source code. Version checks reject conflicting edits; reload and reapply after a conflict. Unused products/categories can be deleted. Products with order or stock history must be archived. Financial and inventory history is retained.

## Customer accounts and guest privacy

Browsing and guest purchases require no sign-in. Contact name/phone are required; email is optional. Payer and contact numbers can differ. Guest checkout never looks up or modifies an account based on a matching number.

Signed-in checkout uses the existing API-host customer cookie under `/api/account`, with explicit store-origin CORS and CSRF checks. The sign-in link opens the existing portal in another tab; customers return to **My orders → Refresh sign-in** after authentication. Cookies remain host-scoped; no broader domain cookie or new credential-sharing mechanism is introduced.

Guest tracking uses a private token in the URL fragment, sent only in POST bodies to the API. Store only its hash server-side. A reference number or phone number alone cannot retrieve an order. Customers should copy and keep their private link. Recent links are saved in that browser's local storage; do not use a shared browser for private order access.

A signed-in customer can attach a guest order only with its valid private tracking token. A matching phone number alone never attaches an order. Operators can replace a tracking link after independently verifying the buyer; replacement revokes the old guest link. An already attached account retains access. Unauthenticated phone/email-based automated recovery is not provided.

## Payments and reservations

Checkout reserves stock for ten minutes and records the product terms, price, warranty and pickup instructions. Existing orders retain these snapshots after catalogue changes. Checkout requires the displayed price to match the server's current price.

Creation is submitted at most once per checkout key. An uncertain provider response is verified by the original payment reference rather than charging again. The browser retains a pending checkout in session storage so a lost response can be recovered with **Resume checkout**. This recovery replays the same request; it does not create a second order.

The first verification is available after submission; subsequent checks are limited to one per thirty seconds per order. A shared per-IP store request limit also applies. Only server-to-provider verification matching reference, amount and currency confirms a payment. The mock adapter is restricted to development.

Existing signed MeSomb/Flutterwave webhook endpoints dispatch store payments to store verification. A durable scheduler runs every fifteen seconds to retry pending/uncertain checks, expire reservations, send optional-email order updates and reconcile refunds. Automatic payment checks cover the first seven days; older unresolved payments remain available for explicit admin verification. A create response or customer/browser redirect never proves payment success.

Payment arriving after reservation expiry or cancellation is recorded as paid and sent to **review**. It does not consume stock reserved for someone else. The buyer sees a support message and must not pay again. Review these cases and refund when appropriate; automatic reassignment of stock to a late payment is not provided.

Emails use the existing email adapter with durable retry and provider idempotency keys. Paid/ready/refunded status notifications are bilingual. Email is optional and failure does not reverse payment or stock changes. Buyers without email track through their private link. No SMS/WhatsApp integration is added.

## Refunds and returns

Only owners authorize full refunds. Record a reason and explicitly state whether equipment is unsent or has been physically returned and can be restocked. Restock happens once, after provider-confirmed refund, only when requested and the order originally consumed stock.

Uncertain refund submissions are never blindly submitted again. If a refund reference was lost, reconcile in the provider dashboard, then enter that reference through the owner-only order recovery form. The adapter verifies it before confirming a refund. Failed refunds remain visible for support; no manual “mark refunded/paid” shortcut is provided. Partial refunds are not implemented.

If returned stock was not restored during refund, record a separate reasoned stock receipt after physical inspection. An order contact correction changes only the order, never the customer's account profile or original provider payment details.

## Production preparation

1. Review the implementation and back up the production database.
2. The production API startup automatically applies and verifies only the additive `010_device_store.sql` indexes before listening. The migration is idempotent, takes the existing store lock, and refuses incorrectly defined existing indexes without dropping or rewriting anything. It adds unique indexes for SKUs, checkout keys, payment IDs/references and stock operation keys. Store collections use dedicated kinds in the existing normalized `events` table; store settings use `app_settings`.
3. Deploy the API and admin changes. Configure the API's `STORE_APP_URL=https://store.ndahiconnect.net`. Keep the exact existing customer/admin origins; store CORS access is restricted to store endpoints.
4. Create the `ndahi-store` web service from `render.yaml`, with `API_URL=https://api.ndahiconnect.net` and the portal URL. The service runs `npm run start:store` and exposes `/healthz` and `/version.json`.
5. Add the DNS record required by the host for `store.ndahiconnect.net` and verify HTTPS. This code change does not configure DNS or register a custom domain externally.
6. Add only physically tested, actually stocked models through the admin app. Confirm prices/margins, supplier/warranty obligations, pickup ownership, and travel-router/device-limit policy.
7. Verify a real low-value payment, collection, cancellation/refund, email delivery, stock reconciliation and backup restore before opening broadly.

The initial release has one product per checkout and one configured pickup location. Delivery, multi-product carts, promotions, device-plus-bundle offers, installation booking and reseller store purchasing remain later phases. Images are bounded inline raster data in PostgreSQL payloads; use object storage before expanding to a large image catalogue. No data is automatically deleted by this release; agree financial and guest-contact retention requirements before wider rollout.

Rollback can close checkout from Store settings first. Keep store records and migration indexes; never reset the database or run older offline full-rewrite migration tools over store data. Preserve the new migration tooling, which includes store collections in count reconciliation.

## Validation commands

```bash
npm run check
npm test
npm run check:store:browser
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to run database tests. Browser journeys exercise real local API/static services with synthetic stock and mock payments at 320px and 1280px, including guest tracking, account-independent purchases, admin editing and lost-response checkout recovery. These checks do not establish production deployment, real Mobile Money acceptance or hardware compatibility.

## Local verification evidence — 8 November 2026

- Full suite with disposable PostgreSQL 18.6: **1,219 tests passed, zero failures/skips**.
- Focused store domain/API/persistence suite: **32 tests passed**.
- Chromium browser journeys: **30 checks passed** at 320px and 1280px, including EN/FR guest purchases, tracking/reload, image upload, admin product creation/edit/deletion, categories, stock, content publishing and a deliberately lost checkout response.
- `npm run build` (including repository syntax checks) and `git diff --check` passed. Mobile/desktop storefront and admin screenshots were inspected.
- Payments and email delivery used test adapters; no real customer data, charges, messages, production deployment, DNS changes or router changes were used for verification.
