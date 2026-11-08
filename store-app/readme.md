# NDAHI Connect Device Store — Proposal

Date: 8 November 2026

Status: the initial store implementation is available in this repository. Storefront, APIs, PostgreSQL persistence and admin store management are implemented and locally validated. Production hosting/DNS, real payment acceptance and physical device compatibility remain pending.

## Implementation and operations

Run `npm run start:store` for the storefront at `http://localhost:8083`, alongside the API and admin services. Owners and operators manage the store in **Admin → More → Store**. The production catalogue starts empty and checkout starts closed until stock, pickup and policies are configured.

Implemented scope includes guest/account checkout, private tracking and account order history, bounded raster image uploads, full editable catalogue/content CRUD, inventory ledger and reservations, provider-verified payments, owner-only full refunds, collection verification, optional-email updates and checkout recovery after a lost response. One product per checkout and one pickup location are supported initially.

See [the operations runbook](../docs/operations/device-store.md) for configuration, permissions, payment/refund reconciliation, deployment and remaining launch steps. The proposal below records the agreed scope; its later phases remain future work.

## Purpose

Launch **store.ndahiconnect.net** as NDAHI Connect's dedicated shop for networking equipment. Customers can buy independently of an internet subscription, either as guests or through their existing NDAHI account.

Start with a small catalogue of physically tested Wi-Fi extenders, travel routers and suitable accessories such as Ethernet cables and power adapters. Explain each product's practical purpose, requirements and limitations. State clearly whether internet access or setup is included or purchased separately.

## Customer experience

The storefront should work on phones and desktops, support English and French, and display prices in FCFA (XAF).

Product pages show photos, model, price, availability, specifications, compatibility, package contents, warranty and setup guidance.

Purchase journey:

1. Browse products without signing in.
2. Select a device and quantity.
3. Continue as guest or sign in.
4. Enter contact information and select pickup; delivery follows in a later phase.
5. Review the total and pay through MTN Mobile Money or Orange Money.
6. Receive an order reference and confirmation.
7. Track preparation and collect the order using collection verification.

The initial checkout supports one product with a selectable quantity. Multi-product carts can follow later.

## Guest checkout and account purchases

| Guest | Signed-in customer |
|---|---|
| No registration required | Reuse saved customer details |
| Name and contact phone required; email optional | View purchases in account order history |
| Secure order-tracking link | Track orders through the account |
| Optional account creation after payment | Same prices and stock as guest checkout |

The payer's Mobile Money number can differ from the buyer's contact number. Request a delivery address only when delivery is available and selected.

A guest order must remain possible when its contact number matches an existing account. It must not overwrite that account's name or email, reveal saved profile information, or grant account access. Keep contact details as an order-specific snapshot. Linking a guest order to an account requires verified ownership; matching phone numbers alone is insufficient.

An order number alone must not expose personal information. Guest tracking requires a secure, unguessable access token, with recovery and revocation controls defined during implementation.

## Full store management from the admin app

The existing **admin-app** must include a **Store** management area. Authorized administrators must be able to create, read, update and delete store-managed content directly through the admin interface, without editing source files or database records manually.

| Resource | Required admin controls |
|---|---|
| Products | Create, list/search, inspect, edit, publish/unpublish, archive and delete eligible products |
| Product information | Edit names, models/SKUs, EN/FR descriptions, specifications, compatibility, package contents, warranty and setup instructions |
| Images | Upload, preview, reorder, replace and remove product images; edit alternative text |
| Categories | Create, view, rename, reorder, hide and delete eligible categories; assign products |
| Pricing | Set selling prices in XAF; record internal costs with appropriate permissions; retain historical order prices |
| Inventory | View available/reserved stock, receive stock and record reasoned adjustments; retain a stock-movement history |
| Store presentation | Edit store name, introduction, banners, featured products, contact details and published EN/FR content |
| Pickup and policies | Manage pickup locations, hours, instructions, warranty/return terms and store availability |
| Orders | Search and inspect orders, manage permitted contact/fulfilment corrections, prepare orders, mark ready and verify collection |
| After-sales | Record serial numbers, support notes, return requests and warranty outcomes; initiate authorized refund workflows |

Full CRUD applies to editable catalogue, content and configuration resources. Deletion must preserve business records: unused drafts can be deleted; products referenced by orders should be archived. Paid orders, payment evidence, stock movements and audit records must not be silently deleted or rewritten. Corrections, cancellations and refunds use explicit recorded actions. Editing a product must not change the description, price or warranty snapshot on an existing order.

Use existing admin authentication with server-side store permissions, protected mutations and audit logging. Restrict financial actions and internal cost visibility by role. Validate uploads and content. Product/content edits should appear in the storefront after saving or publishing, without a code deployment; show clear save/publish feedback and prevent conflicting edits from silently overwriting one another.

## Payments, stock and order processing

Reuse the existing payment-provider integrations, with hardware-specific payment references and fulfilment rules. Hardware purchases must not issue vouchers or change internet subscriptions unless an explicitly supported bundle offer is introduced later.

Temporarily reserve stock during checkout. Expired or failed payment attempts release reservations. Verified successful payments confirm an order exactly once, including duplicate notifications and checkout retries. Define reconciliation for late payments after reservation expiry; do not oversell or promise collection for unavailable stock.

Track payment and fulfilment independently:

| Payment | Fulfilment |
|---|---|
| Pending, paid, failed, refunded; partial refunds if supported | Awaiting payment, preparing, ready for pickup, collected, cancelled |

Refunds and cancellations must apply the correct stock adjustment and preserve their history. Store totals and stock checks are computed server-side.

## Collection, delivery and support

Launch with pickup first. Define who prepares orders, the pickup location and hours, collection verification, uncollected-order handling, warranty and return terms before launch.

Record device serial numbers against sales where appropriate. Provide model-specific setup and reset instructions.

Delivery can follow once service areas, charges, address requirements, fulfilment responsibilities and tracking are defined. Admin delivery configuration and dispatch controls should be added with that phase.

## Compatibility and network policy

Only label a model **Tested with NDAHI Connect** after physical verification. Test captive-portal login, reconnects, operating modes, stability, quota accounting, device-limit behaviour, factory reset and setup instructions.

An extender requires a usable upstream signal. It cannot create coverage from an absent or unreliable connection. Travel-router captive-portal support varies by model and mode.

A travel router can put several downstream devices behind one visible upstream connection. Define how this fits NDAHI's device-limit policy and any supported Home service before promising compatibility. Selling hardware does not automatically grant extra device allowances or internet access.

## Technical approach

- Dedicated customer storefront in `store-app`, hosted at `store.ndahiconnect.net`.
- Existing NDAHI API extended with product, inventory, order, order-item, reservation and fulfilment records and endpoints.
- Existing `admin-app` extended with the full Store management area described above.
- Existing payment integrations adapted to separate physical-order processing.
- DNS record and HTTPS for the store; explicit permitted store-to-API origins.
- Secure account sign-in handoff between portal and store, retaining current host-scoped cookie boundaries.
- Persistent product/media storage, database migrations, backups and order/audit retention defined before deployment.

The separate address does not require a separate commerce backend. Keep hardware orders distinct from bundle purchases while reusing shared infrastructure.

## Rollout

### Phase 1 — Confirm the offering

Select exact models and suppliers, physically test samples, establish stock and margins, decide router-use policy, and define pickup, warranty and returns.

### Phase 2 — Build and validate

Implement storefront, guest/account checkout, payments, reservations, tracking and full admin store CRUD. Validate account privacy, admin permissions, product publishing, historical order preservation, concurrent stock purchases, retries, duplicate payment notifications, late payments and refunds.

Verify mobile/desktop and EN/FR flows. Automated and simulated payment checks do not establish real payment or hardware acceptance.

### Phase 3 — Pilot launch

Configure DNS/HTTPS and deploy. Launch a small catalogue and fulfil limited real orders. Verify actual payment receipt, stock accuracy, collection and customer setup before expansion.

### Later additions

Delivery, multi-product carts, promotions, device-plus-internet offers, installation bookings and reseller purchasing.

## Decisions required before implementation

- Exact models, quantities, suppliers, purchase costs and selling prices.
- Pickup location, operating hours and fulfilment owner.
- Warranty, returns, refunds and uncollected-order terms.
- Whether setup or an internet bundle is included with any product.
- Supported travel-router modes and device-limit policy.
- Admin role permissions, product publishing workflow and notification channels.

## Acceptance and evidence

- [x] Proposal recorded, including guest checkout, dedicated store domain and full admin store CRUD requirements.
- [x] Storefront, APIs and admin controls implemented.
- [x] Local automated/API/PostgreSQL and mobile/desktop browser checks passed with mock/synthetic payment fixtures. Real provider acceptance remains pending.
- [ ] DNS, HTTPS and production deployment verified.
- [ ] Real Mobile Money purchase, collection and stock reconciliation verified.
- [ ] Each advertised compatible model physically tested on NDAHI's network.
