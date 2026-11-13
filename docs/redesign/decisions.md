# Redesign decisions

Settled with the owner during design. Don't reopen these in a PR; if one looks wrong, raise an issue.

## Structure

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
