# Redesign decisions

Settled with the owner during design. Don't reopen these in a PR; if one looks wrong, raise an issue.

## Structure

Owner update, 13 November 2026: admin v2 is now the default. The customer portal
keeps its existing v1 default and rollout percentage. Explicit old/new interface
choices and the kill switch remain available. This supersedes the earlier admin
opt-in-only policy, without authorizing a customer rollout or authentication retirement.

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
