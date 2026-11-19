# Prompt — show the Mobile Money fee and total before payment (#297)

Paste into Claude Code from the repo root, after PR #298 (the designs) is merged.

---

Implement issue #297: customers must see the price, the Mobile Money fee and the total before they pay, and a low-balance failure must explain the total.

**Context. Read first:**
- `AGENTS.md`
- issue #297
- the "Payment fees are shown before paying" section of `docs/redesign/decisions.md`
- these designs in `docs/redesign/screens/`: `PhoneBuyBundle`, `PhoneBuyForOther`, `PhoneRenew`, `PhoneCheckout`, `PhoneGuestCheckout`, `PhonePaymentFailed`

**Then the code:**
- `lib/payments.mjs`: MeSomb `makeCollect` is called with `fees: false`, so the payer pays price + fee. Failure codes `low_balance` and `check_balance` are already detected.
- `lib/domain/purchases.mjs`: the payment record, with `amount: plan.price`.
- `lib/store-commerce.mjs`: the store payment amount.
- `lib/api/payments.mjs` and `lib/api/store.mjs`: the endpoints the checkouts call.
- **v1:** `customer-app/onboarding.html` and `.js` (the vague `#providerFee` note).
- **v2:** `customer-app-v2/onboarding.*`, `gift.js`, `renewal.js` and the payment-failed view.
- `shared-app/i18n.js`: `giftPay`, `giftWaitBody`, `homeRenewBuySub`, `payFailedLowBalanceBody`, EN and FR.
- **Receipts:** `lib/receipt.mjs`, `lib/receipt-pdf.mjs`, `lib/store-receipt.mjs`.

**Before writing code, find out where the fee can come from and tell me:**
1. **The MeSomb client:** check the SDK in `node_modules`. Is there a fee or quote call, and does a collect response or webhook include the fee actually charged?
2. **Otherwise:** a server-side config per network, for example an env var holding a percentage, a minimum, or a fixed amount, which I set from my MeSomb contract.

Propose the option in a short note and wait for my answer before going on. Do not guess a rate.

**Scope, after I confirm the fee source:**
1. **Server quote.** One function returns `{ price, fee, total, network }` for a plan or store cart and a network (`mtn` / `orange`). Expose it through the existing purchase and checkout responses rather than a new endpoint where possible.
2. **Store it on the payment.** Save the quoted `fee` and `total` on the payment record when the charge starts, so the waiting screen, the receipt and the failure screen all show the same numbers. Keep `amount` as the price that `makeCollect` sends: don't change what we send to MeSomb or who pays the fee.
3. **v2 screens, matching the designs:**
   - a breakdown of price, "{network} fee" and **Total to approve**;
   - the Pay button reads "Pay {total} FCFA";
   - an amber note: "Make sure your {MoMo|Orange Money} balance has at least {total} FCFA. If it's lower, the payment fails and no money is taken.";
   - the waiting screen shows the total and "check the amount is {total} FCFA";
   - renew shows "{total} FCFA incl. fee";
   - the gift (buy for someone else) and both store checkouts get the same breakdown;
   - when the network changes, the fee and total update.
4. **v1:** replace the `#providerFee` note with the actual fee and total, and fix the low-balance text. Keep v1 changes minimal.
5. **Low balance:** `payFailedLowBalanceBody` and the v1 equivalent say "below {total} FCFA: the bundle ({price} FCFA) plus the Mobile Money fee ({fee} FCFA)". The payment-failed details list the fee and the total. Do this for `low_balance` and also `check_balance`. For `check_balance` keep the softer wording: "check your balance covers {total}".
6. **Receipts:** add a fee line and the total paid.
7. **i18n:** add and change every string in English and French. Use placeholders; no amounts inside strings.

**Rules:**
- Never compute or hard-code the fee in the front end. It always comes from the server.
- If no fee is available for a payment, show "plus the Mobile Money fee shown in your prompt" and the price, never a guessed number.
- Don't change `fees: false`, billing rules (no buying while a bundle is active), auth, or `UI_V2_PERCENT`.
- No new dependencies. Follow `AGENTS.md`.
- One PR. Add every new file to `npm run check`.

**Proof:**
- Unit tests:
  - the quote per network, including the case where the fee is unavailable;
  - the fee and total stored on the payment;
  - the low-balance and check-balance messages using the stored total;
  - receipts showing the fee.
- `npm run check`, `npm test` and the billing, gift, store and pending browser journeys pass on v1 and with `?ui=new`.
- Screenshots at 390 px of buy-a-bundle pay step, waiting, low-balance failure and guest checkout, in English and French.
- In the PR, describe a manual staging check: a balance between the price and the total is refused, the screen shows the total, and nothing is taken.

**Stop:** open a draft PR that closes #297, and stop. Don't merge.
