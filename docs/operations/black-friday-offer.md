# Black Friday AX1500 offer (27–30 November 2026)

Issue #302. Rules set by the owner on 20 November 2026. The free month changed on 23 November (#423).

## The offer

- **Price:** any AX1500 router for **100,000 FCFA**, from Friday 27 to Monday 30 November, Cameroon time.
- **Free month:** each comes with **one month (30 days) of Unlimited**. It is **given when the router is collected**, not at payment. Before that, the order says "Free month: given when you collect".
- **Starting it:** once given, it waits unstarted. The customer starts it whenever they like, **within 60 days of collecting**. The 30 days count from the moment they press Start. Unstarted after 60 days, it expires.
- **Limit:** **one per phone number.** The paying number, the contact number and a signed-in account all count as the same buyer. Stock on hand is the overall cap.
- **Buyer with an account** (signed in, or the paying number has one): the free month lands in that account. They see **Start your free month** on the portal Home and on the order, with the deadline ("Start it by …").
- **Running bundle:** if a bundle is running when they press Start, it is **paused**. It resumes, with exactly the time it had left and its own terms, when the free month ends.
- **Buyer without an account:** the free month is **reserved for the number that paid**. The code is on the order page and on the collection slip. They claim it in the portal with that number and the code; claiming adds it to the new account, unstarted, with the same 60-day deadline. Entering the code with that number on the Wi-Fi sign-in page starts it.
- **Refunds:** before collection, nothing was given. After collection but before the start, the free month is **cancelled** (a slip's code no longer works). After the start, it **ends** and any paused bundle resumes.
- **Revenue:** the free month is a gift linked to the order, not revenue.
- **Orders placed before this change** (none were placed before the sale) keep the 20 November rule: 45 days from payment.

## Before the sale (owner)

1. **Store settings** (Admin → Products → Store settings):
   - support contact: `WhatsApp +237671493902`;
   - pickup: `Bandja Street`;
   - opening hours;
   - warranty and returns terms in English and French.

   The store cannot open without them. Then tick "Open".
2. **Products:** count the AX1500 routers on hand and record them as stock adjustments. Check each product's name, photos, specifications and regular price, and that it is published.
3. **The promotion** (Admin → Promotions). The Black Friday promotion already exists; open it and change:
   - **Lasts (days): 30** (it says 45).
   - **Must be started within: 60 days.**
   - **Terms**, English and French. The current terms describe 45 days from payment. The design's wording is: "1 per customer. While stocks last. Free month: [the plan], start within 60 days of collecting the router. Not exchangeable for cash."

   Then save. Everything else stays: every AX1500 product, 100,000 FCFA, 27 Nov 00:00 to 1 Dec 00:00 Douala time, one per number, the `unlimited` plan.
4. **Check before Friday:** staging hostnames don't resolve yet, so test on production with a separate promotion that can't touch the sale:
   - create a promotion on a cheap product (for example a cable) with a free bundle, starting now and ending in an hour;
   - buy it with your own number, then mark it ready and collected;
   - check the portal Home shows "Start your free month", press Start, and check your running bundle pauses;
   - refund it, check the free bundle ends and your bundle resumes, then **End early**.

## During and after

- **Admin → Promotions** shows, for each promotion:
  - units sold and revenue;
  - free months given but not started, running, waiting for a claim, and ended;
  - each order with its masked number and its free month's status: "Given at collection" (paid, not yet collected), "In account · start by …", "Waiting for claim", "Running · until …", "Expired · not started", "Cancelled · refunded".
- **Collecting:** marking an order collected (with its collection code) is what gives the free month. Collect in Admin → Store as usual.
- **End early** stops the price at once; orders already placed keep their price and free month.
- **A free month shown as "needs review"** means the order has no copy of the plan and the Unlimited plan was missing at collection. Give the buyer a month of Unlimited by hand from Admin → Vouchers, and note it on the order. Orders placed from this change keep their own copy of the plan, so this should not happen for them.
- **The audit log** records each step: `store.promotion_bonus_given`, `store.promotion_bonus_claimed`, `store.promotion_bonus_started`, `store.promotion_bundle_paused`, `store.promotion_bundle_resumed`, `store.promotion_bonus_expired` and `store.promotion_bonus_ended` (refunds).

## How pausing works

- **Pause:** only when the customer presses Start. The running bundle stops with its remaining time saved; its data, devices and speed are unchanged. The router is asked for a last usage reading and then disables that bundle (`disconnect_voucher`), so connected devices drop. They reconnect with the free month from the portal.
- **Resume:** when the free month ends, by expiry, refund or revocation, the paused bundle starts again for exactly the time it had left, and the router enables it (`sync_voucher`).
- **Home access** is a separate service and is never paused.
