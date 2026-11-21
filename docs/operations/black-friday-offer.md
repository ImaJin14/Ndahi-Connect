# Black Friday AX1500 offer (27–30 November 2026)

Issue #302. Rules set by the owner on 20 November 2026.

## The offer

- **Price:** any AX1500 router for **100,000 FCFA**, from Friday 27 to Monday 30 November, Cameroon time.
- **Free bundle:** each comes with **45 days of Unlimited Home**: unlimited data with fair use, up to 6 devices. The 45 days start when the Mobile Money payment is confirmed.
- **Limit:** **one per phone number.** The paying number, the contact number and a signed-in account all count as the same buyer. Stock on hand is the overall cap.
- **Running bundle:** if the buyer's account already has a bundle running, it is **paused**. It resumes, with the time it had left, when the 45 days end.
- **Buyer without an account:** the 45 days are **reserved for the number that paid**. The code is shown on the order page and is printed on the collection slip. The buyer claims it with that number and the code (portal → "I have a code"), and claiming starts it. The days run from payment either way.
- **Refunds:** a refund **ends the free 45 days** and resumes any bundle paused for them.
- **Revenue:** the free bundle is a gift linked to the order, not revenue.

## Before the sale (owner)

1. **Store settings** (Admin → Products → Store settings):
   - support contact: `WhatsApp +237671493902`;
   - pickup: `Bandja Street`;
   - opening hours;
   - warranty and returns terms in English and French.

   The store cannot open without them. Then tick "Open".
2. **Products:** count the AX1500 routers on hand and record them as stock adjustments. Check each product's name, photos, specifications and regular price, and that it is published.
3. **The promotion:** create it in Admin → Promotions (or with the promotions API until that screen is deployed).
   - Products: every AX1500 product. They are chosen by product, never matched by name.
   - Sale price: 100,000.
   - Start: 2026-11-26T23:00:00Z, which is 27 Nov 00:00 in Douala.
   - End: 2026-11-30T23:00:00Z, which is 1 Dec 00:00 in Douala.
   - One per number.
   - Free bundle: `unlimited`, 1,080 hours.
   - Terms in English and French.
4. **Staging:** test a guest purchase and an account purchase on staging, including a refund, before 25 November.

## During and after

- **Admin → Promotions** shows, for each promotion:
  - units sold and revenue;
  - free bundles running, reserved or ended;
  - each order with its masked number and its bundle's status.
- **End early** stops the price at once; orders already placed keep their price and free bundle.
- **A free bundle shown as "needs review"** means the Unlimited plan was missing when the payment was confirmed. Give the buyer 45 days of Unlimited by hand from Admin → Vouchers, and note it on the order.
- **The audit log** records each step: `store.promotion_bonus_given`, `store.promotion_bundle_paused`, `store.promotion_bundle_resumed`, `store.promotion_bonus_claimed` and `store.promotion_bonus_ended`.

## How pausing works

- **Pause:** the running bundle stops with its remaining time saved. The router is asked for a last usage reading and then disables that bundle (`disconnect_voucher`), so connected devices drop. They reconnect with the free bundle from the portal.
- **Resume:** when the free bundle ends, by expiry, refund or revocation, the paused bundle starts again for the time it had left, and the router enables it (`sync_voucher`).
- **Home access** is a separate service and is never paused.
