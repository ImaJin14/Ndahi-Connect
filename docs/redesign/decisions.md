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
- Find the customer by name or phone number. Only existing accounts can receive one (matches `POST /api/admin/vouchers/generate` with a `customerId`). A number with no account gets told to sign up first, or is handed an unassigned voucher from a batch of one.
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
