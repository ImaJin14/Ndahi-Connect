# Prompt — store promotions with a free bundle (Black Friday)

Paste into Claude Code from the repo root after the designs PR is merged. It builds the feature described in the "Store promotions" section of `docs/redesign/decisions.md`.

---

Build store promotions: a time-limited sale price on a product, with an optional free bundle. The first one is Black Friday, 27–30 Nov: the TP-Link AX1500 for 100,000 FCFA plus 1 month of Unlimited free.

**Context. Read first:**
- `AGENTS.md`
- the "Store promotions (19 Nov)" and "Payment fees are shown before paying" sections of `docs/redesign/decisions.md`
- these designs in `docs/redesign/screens/`: `StorePromo`, `PhonePromoBuy`, `AdminPromotions`, `AdminSide`

**Then the code:**
- `lib/device-store.mjs`: products, `publicProduct`, `catalogue`, the fee quotes, `reserveOrder`.
- `lib/api/store.mjs`: catalogue and checkout, guest and account.
- `lib/api/admin-store.mjs`: order handling, including marking collected.
- `lib/store-commerce.mjs`: payment, refund and restock.
- `lib/reservations.mjs` and the voucher issuing in `lib/api/admin-vouchers.mjs`: gift vouchers for accounts, reservations for a number (#254).
- `lib/store-receipt.mjs`.
- The current store and shop front ends, v1 and v2.

**Scope:**

1. **Model and storage.** A `promotions` collection, with migrations as the repo does them today. Each promotion has:
   - `id`, `name` (localized), `productId`, `salePrice`, `showRegularPrice`;
   - `startsAt`, `endsAt`, `unitCap`, `perCustomerLimit`;
   - `bonus`: `{ planId, startWithinDays, giveAt: "collected" | "paid" }` or null;
   - `terms` (localized), `status` (draft / scheduled / live / ended), `endedEarlyAt`.

   Store `promotionId`, `unitPrice` and `bonus` state on each order line, so price and bonus survive later edits to the promotion.

2. **Pricing on the server only.**
   - **One function** `activePromotion(s, product, now)` decides whether the sale applies: inside the window, under the cap, not ended.
   - **Catalogue responses** add `{ promotion: { name, salePrice, regularPrice?, endsAt, unitsLeft, perCustomerLimit, bonus: { planName, worth } | null, terms } }`.
   - **Crossed-out price:** `regularPrice` is included only when `showRegularPrice` is set **and** the product sold at that price in the last 30 days.
   - **Checkout:** `reserveOrder` uses the sale price and enforces the cap and the per-number limit, counting by the paying phone number for guests and accounts alike. Fee and total quotes use the sale price.
   - **Concurrency:** the cap must hold under concurrent checkouts. Reserve units inside the same transaction as the stock reservation, and test it.

3. **Free bundle.**
   - **When it's given:** at the event in `bonus.giveAt`, default when the order is marked collected.
   - **Account holder:** issue a gift voucher, saved and not started.
   - **Guest:** create a #254 reservation for the paying number. Print its code on the collection receipt or slip.
   - **Recording:** record it as a gift linked to the order, never as revenue.
   - **Starting:** the customer starts it within `startWithinDays`, and starting must work while another bundle is active. If that conflicts with the billing rule as implemented, stop and tell me.
   - **Refunds:**
     - before it's given, it's never given;
     - given but not started, cancel it;
     - already started, keep it and note it on the refund.

4. **Admin (v2):** the Promotions screen per `AdminPromotions`.
   - **Set up:** create, edit and schedule a promotion, with a preview.
   - **While it runs:** units sold out of the cap, revenue, free months given and started, new customers, and the order list with each free month's status.
   - **Controls:** End early. Add the Promotions menu item. Owner and operator only.
   - **Audit:** every create, schedule, edit, end and bonus event is written to the audit log.

5. **Store front ends:**
   - **v2 and the public store:** the badge, the sale price, the crossed-out regular price only when the API sends it, the free-bundle card, the countdown from `endsAt` using server time, "{n} left at this price", terms, and the checkout lines "+ 1 month Unlimited: Free" and how the free month is delivered (account vs guest), per `PhonePromoBuy` and `StorePromo`.
   - **v1:** show the sale price and the free-bundle line. Keep it minimal.
   - **Wi-Fi page:** an optional promo banner while a promotion is live.

6. **i18n:** every new string in English and French.

**Rules:**
- The front end never computes prices, caps or eligibility. It shows what the API returns.
- No hard-coded promotion data. Black Friday is created through the admin, or through a seed script that I run by hand.
- Don't change who pays the Mobile Money fee, existing order or refund behaviour outside promotions, auth, or `UI_V2_PERCENT`.
- No new dependencies. Follow `AGENTS.md`.

**Proof:**
- Unit tests:
  - the window boundaries;
  - the cap under concurrent checkouts;
  - the per-number limit for a guest and an account with the same number;
  - the regular-price rule;
  - the free bundle given at collection, and at payment;
  - the guest reservation and claim;
  - the refund before and after it's given, and after it's started;
  - starting while another bundle is active;
  - ending early;
  - the gift isn't counted in revenue.
- `npm run check`, `npm test` and the store, guest, pending and admin journeys pass on v1 and with `?ui=new`.
- Screenshots at 390 px and 1280 px of the store banner, the product, checkout (account and guest), the order confirmation, and the admin set-up and while-it-runs views, in English and French.

**Stop:** split it into reviewable draft PRs (server and model; admin; store front ends) referencing the issue, and stop after each one for review. Don't merge.
