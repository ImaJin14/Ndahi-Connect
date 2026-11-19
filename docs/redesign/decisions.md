# Redesign decisions

Settled with the owner during design. Don't reopen these in a PR; if one looks wrong, raise an issue.

## Structure

Owner update, 13 November 2026: admin v2 is now the default. The customer portal
keeps its existing v1 default and rollout percentage. Explicit old/new interface
choices and the kill switch remain available. This supersedes the earlier admin
opt-in-only policy, without authorizing a customer rollout or authentication retirement.

Owner update, later on 13 November 2026: the customer portal now defaults to v2 as
well ("switch to customer V2"). The old automatically saved v1 cookie no longer
keeps customers on v1; deliberate `?ui=old` choices and the kill switch remain.
This does not enable Home, open the store or run the authentication retirement.

- **Store merges into the customer portal.** Signed-in customers shop from a Shop tab. The portal has five tabs: Home · Internet · Shop · Activity · Account.
- **The public store stays for guests.** `store-app` keeps serving store.ndahiconnect.net. Guests check out with a Mobile Money number plus an optional email and get a private tracking link to copy or bookmark. No SMS. A guest who later signs in with the same number sees the order in Activity.
- **Admin stays a separate app** with its own domain and session, restyled to match.
- **v1 stays live until v2 has proven itself.** Rollout is by cookie / query / percentage switch (see Phase 0 in the plan).

## Sign-in and verification

- **PIN or passkey only.** No SMS codes, no authenticator apps (TOTP), no recovery codes. `verify.html` and authenticator management are removed in Phase 6.
- **Customers:** phone + PIN, or passkey. Forgotten PIN → email link (15 minutes, single use).
- **Admins:** email + PIN, then passkey (required). A lost passkey is removed by the owner, then re-registered.

## Billing

- **No buying while a bundle is active.** There is no top-up and no queued "next bundle". The UI states this rule (see `customer-app/billing-terms.html`) instead of offering the purchase.

## Giving a voucher to a customer

- Admin → Vouchers has two modes: **For one customer** and **Batch to print or sell**. Customer detail links to the first.
- Find the customer by name or phone number. For an existing account it works like v1's `POST /api/admin/vouchers/generate` with a `customerId`.
- **A number with no account:** the admin can reserve the voucher for that number. To claim it, the person enters their number **and** the code (on the slip, or read to them) at "Someone gave you a bundle?" on sign-in, creates a PIN, then starts it now or later. There is no SMS: the code is the proof of ownership. Paying with Mobile Money from that number also claims it automatically. Unclaimed reservations expire after 90 days. Before they're claimed, the admin can change the number (the old number can't claim it any more) or revoke it. Claim attempts are rate-limited (5 wrong tries, then a 15-minute wait).
- "Buy for someone else" uses the same mechanism.
- Mark it **Sold** (revenue) or **Gift** (no revenue). Only owners and operators can do this.
- It starts immediately. If the customer already has an active bundle, the admin must tick a confirmation; the old bundle ends and its devices are disconnected (existing replace behaviour, audited).

## Customer list filters

- Admin → Customers has filter chips: **All · Active · Stale · Suspended**, each with a count, plus a "Stale after" setting (7, 14, 30, 60 or 90 days; default 30).
- **Active:** has a bundle now, or one ended within the threshold. **Stale:** no bundle for the threshold or longer, or signed up and never bought. **Suspended** is shown separately.
- A "Last active" column shows when the last bundle ended (or "Online now"). Stale rows offer **Give voucher**; the stale view offers a CSV export.
- Derive "last bundle ended" from voucher history. If the admin API doesn't return it per customer, add a read-only field rather than a new endpoint.

## Voucher detail

- Each code in Recent vouchers opens a detail page: a ticket-style card (plan, QR, code, print/copy), usage (data, time, devices), a history timeline (created → sold/gift → redeemed → ends), and details (customer, type, batch, router sync, receipt email).
- Actions match v1: mark sold/gift, resend receipt email, print, and **Revoke** with an inline confirmation.

## Added screens (13 Nov)

| Screen | What it covers | Phase |
| --- | --- | --- |
| PhonePaymentFailed | Declined, low balance, timed out (don't pay again), wrong network. Always shows a reference. | 3 |
| PhoneRenew | Push and in-app states at 80% used, ends tomorrow, and ended → one-tap "Buy [PLAN] again". | 2 |
| PhoneBuyForOther | Pay for someone else's number: no account (share code), has account (goes straight in), active bundle (saved until it ends). | 3 |
| PhoneOutage | Home during an outage and after it's fixed, with time added back. | 2 |
| PhoneHomeFR | French layout check; `TabBar` now takes `lang="fr"`. | 1–2 |
| ResellerHome | Reseller's own phone view: sell a code, codes in hand, what they owe. | 5 |
| AdminInsights | Revenue per day, busiest hours, access-point load, and v1-vs-v2 funnel. | 5 (funnel data from Phase 0) |
| AdminOutage | Post a notice (EN + FR) → updates → mark fixed → give time back to affected bundles. | 5 |
| AdminCustomers (updated) | Row selection and bulk gift voucher or message. | 5 |
| AdminBundleEdit (updated) | Speed limit per customer (download / upload). | 5 |

## Server work these designs need

Front-end phases stay front-end. These are separate, small server tasks, each its own PR, owned by Claude Code:

1. **Last-active per customer** for the Customers filter (derive from voucher history).
2. **Payment failure reasons**: map provider responses to `declined`, `low_balance`, `timeout`, `wrong_network`. Timeouts must keep polling and never allow a second charge for the same attempt.
3. **Vouchers reserved for a phone number**: covers buying for someone else and giving a voucher to an unregistered number.
   - Claiming needs the number and the code, rate-limited per number. A Mobile Money payment from that number claims it automatically.
   - Unclaimed reservations expire after 90 days. The admin can change the number or revoke it, and both are audited.
   - Starting the bundle is a separate step from claiming it.
4. **Outages**: an outage record (area, start, end, messages in EN and FR) shown on the hotspot page and portal, plus "add time to bundles active during [start, end]" as one audited action.
5. **Speed limit per bundle**: store download and upload Mbps on the plan and apply it as a MikroTik queue when the voucher syncs.
6. **Bulk actions**: give a gift voucher and send a notification to many customers in one audited request.
7. **Insights**: daily revenue, hourly device counts, per-AP peak load, and funnel counts tagged by `ui` variant. The variant tag comes from Phase 0.
8. **Reseller view**: the reseller role exists. It needs a read-only "my stock / my sales / what I owe" endpoint and a "mark sold" action.

## Process

- Run `usability-test.md` before ramping past 10%.

## Payment fees are shown before paying (19 Nov)

- Every payment screen shows the price, the Mobile Money fee for the chosen network, and the **total to approve**. The Pay button and the waiting screen use the total, and the waiting screen tells the customer to check that the prompt shows the same total.
- Before paying, a note says the balance must cover the total, otherwise the payment fails and no money is taken.
- The low-balance failure states the total and how it breaks down: price plus fee.
- Applies to: buy a bundle, buy for someone else, renew, signed-in checkout, guest checkout, and the payment-failed screen.
- `[FEE]` and `[TOTAL]` come from the server for the chosen network, never computed or hard-coded in the front end.
- Open: whether the fee is shown to the customer (current setup, `fees: false` in `lib/payments.mjs`), or absorbed by NDAHI so the customer pays exactly the price.

## Store promotions (19 Nov)

Screens: `StorePromo` (desktop store), `PhonePromoBuy` (product → checkout → order, as an account holder or a guest), `AdminPromotions` (set up, and the view while it runs). `AdminSide` gains Promotions under Sales. First use: **Black Friday, 27–30 Nov: TP-Link AX1500 for 100,000 FCFA plus 1 month of Unlimited ([PLAN 4]) free.**

- **A promotion holds:**
  - one product and its sale price;
  - a start and end date and time;
  - a cap on units at that price;
  - a limit per phone number;
  - terms in English and French;
  - optionally, a free bundle.
- **The server decides the price.** The sale price applies only between start and end and while units remain under the cap. It applies on the public store, in the portal Shop tab, and on the Wi-Fi page banner. The fee and total quote (#297) uses the sale price.
- **Crossed-out price:** the regular price is shown crossed out only if the owner ticks "show regular price" and the product really sold at that price in the last 30 days. The server checks this; the UI never invents a "was" price.
- **When the free bundle is given:** **at collection** by default, with an option to give it when payment is confirmed.
  - **Signed-in buyer:** it's added to their account, saved, not started.
  - **Guest:** it's reserved for the Mobile Money number that paid, using the #254 reservations, and the code is printed on a slip at collection.
  - It starts when the customer presses Start, within the start window (default 60 days). That works even while another bundle is active, so the no-buying-while-active rule is unaffected.
  - It's recorded as a gift, not revenue, and linked to the order.
- **Refunds:** a refund before the free bundle is given means it's never given. After it's given, an unstarted free bundle is cancelled. A started one stays and is noted on the refund.
- **Ending:** the sale ends at the end time, when the cap is reached, or with "End early". Orders already reserved keep their price.
- **Audited:** creating, scheduling, ending early, and every free bundle given or cancelled.

## Scan to connect

Scanning a voucher QR never connects a device on its own. The flow:

1. Check the code → find the account.
2. **Active bundle?** If not → "No active bundle" → Buy a bundle (or enter a voucher). After purchase the device connects without a second scan.
3. **On NDAHI Wi-Fi?** If not → join instructions, then check again.
4. **Someone else signed in on this device?** → offer to sign them out (their bundle and devices stay safe) or stay.
5. **PIN or passkey** → connected; the device appears in the account's Devices list.

The API needs to say whether the scanned account has an active bundle before PIN entry. Add a read-only field to the existing voucher-check response in `lib/api/vouchers.mjs` if it's not there — no new endpoint.

## Open questions for the owner

Needed before the phase that uses them. Until then, keep the placeholder and pull from the API where one exists.

| Question | Needed by | Placeholder |
| --- | --- | --- |
| Real plan names and prices | Phase 2 (entered in admin) | `[PLAN 1–4]`, `[PRICE]`, `[XAF]` |
| Support phone and WhatsApp number | Phase 3 (Help) | `[SUPPORT NUMBER]` |
| Pickup location and opening hours | Phase 4 | `[PICKUP LOCATION]` |
| Product photos and warranty wording | Phase 4 | image slots, `[WARRANTY]` |
| Restyle the public store in Phase 4, or later? | Phase 4 | — |
| Reseller commission rate shown on the ledger | Phase 5 | `[RATE]` |

## Owner decisions for the Phase 5 drafts (19 Nov)

- **Outages (#259):** when an outage is marked fixed, every bundle active during it gets the outage's full length back, rounded up to the next hour.
- **Speed limit per bundle (#263):** one limit shared by all of a customer's devices on that bundle; two devices on a 10 Mbps bundle share 10 Mbps. Verified on the RB5009 before it counts as done.
- **Reseller codes redeemed before "Cash received" (#261):** they count as sold, and the reseller owes their price. The screen therefore shows the code and QR first, then "Cash received", as designed.
- **Reseller price and commission (#261):** the price and commission rate recorded when the code was issued apply, even if the bundle's price or the reseller's rate changes later.
