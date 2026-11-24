Update the existing NDAHI Connect design and its corresponding GitHub issues in ImaJin14/Ndahi-Connect. Use the current design project and issue set as the starting point. Keep the established branding, layout, components, navigation, and flows wherever the changes below do not require edits.

First, inspect the existing frames, linked prototype flows, and related GitHub issues. Match each change to its existing issue before editing. Update those issues in place, preserving their history, labels, assignees, and unrelated requirements. Create a new issue only when no existing issue covers the work. Keep completed issues closed and add a linked follow-up if the new requirements change previously completed work. This task covers design revisions and issue updates. The implementation requirements below belong in the GitHub issues.

## 1. Update the existing bundle catalogue

Keep all current fixed-data bundles and their prices. Update the unlimited catalogue to these base prices in XAF:

| Personal Unlimited | 1 device | 2 devices | 3 devices | 4 devices | 5 devices | 6 devices |
|--------------------|---------:|----------:|----------:|----------:|----------:|----------:|
| 5 hours            |      250 | Not offered | Not offered | Not offered | Not offered | Not offered |
| 24 hours           |      500 |       900 |     1,300 |     1,700 |     2,100 |     2,500 |
| 7 days             |    2,500 |     4,000 |     5,500 |     7,000 |     8,500 |    10,000 |
| 30 days            |    6,000 |    10,000 |    15,000 |    20,000 |    25,000 |    30,000 |

- Personal Unlimited is device-bound, with sharing restricted under the existing rules. All prices above are for unlimited data.
- Home WISP Unlimited is **40,000 XAF for 30 days**, bound to **one supported WISP router**, with household sharing enabled. Keep it distinct from the Personal Unlimited plans. Include “up to 60 household devices” in public copy only after validation on supported routers. The platform sees one upstream router behind NAT, so the issue must distinguish supported-router capacity from any limit enforced by the router itself.
- There are **20 purchasable unlimited offers**: 19 Personal Unlimited and 1 Home WISP. Show all six device counts on desktop and use the existing mobile pattern or a duration selector with readable device options. Mark all five unavailable five-hour options as “Not offered” and disable purchase for them.
- In the catalogue issue, add acceptance criteria for all 20 exact prices, rejection of unavailable combinations by the backend, unchanged fixed-data plans, an idempotent seed or database update, and preservation of existing vouchers, receipts, and purchase terms.

## 2. Update the existing Mobile Money confirmation

For a verified 2% fee on the selected network, show:

- Bundle Price: [base_amount] XAF
- Mobile Payment Fee (2%): [fee_amount] XAF
- Total to Pay: [total_amount] XAF

Calculate the expected fee as `Math.round(base_amount * 0.02)`. Include these test examples in the issue: 250 → 255 XAF, 500 → 510 XAF, 2,500 → 2,550 XAF, and 6,000 → 6,120 XAF. Refresh the server quote when the bundle or network changes.

Immediately above Pay Now, show this English notice and its French translation. Bold the amount in the design.

“Ensure you have at least **[total_amount] XAF** in your MTN MoMo / Orange Money wallet (includes 2% mobile payment fee). Keep your screen unlocked to enter your PIN.”

Include the existing fee-in-prompt fallback for a network whose fee has not been verified. Show the base price and explain that the Mobile Money fee will appear in the operator prompt. Omit the unverified percentage and total.

In the payment issue, specify:

- Pass the exact server-side base price as `amount` and explicitly send `fees: false`.
- Confirm the account’s actual customer debit, processing fee, and merchant credit separately for MTN and Orange before enabling the numeric 2% disclosure.
- Store the quote and confirmed provider amounts separately. Document what `trxamount` represents using verified provider records before using it for reconciliation.
- Apply the same reconciliation rules to synchronous verification and authenticated webhooks. Require `transaction.status === 'SUCCESS'`, matching payment identity, currency `XAF`, and confirmed merchant credit equal to the stored base price before provisioning. Route discrepancies to reconciliation. Repeated callbacks and polling must never activate a bundle twice.
- Preserve the existing MikroTik/RADIUS and Home WISP provisioning paths. Include checkout acceptance criteria for both captive portal variants.

## 3. Update the existing payment, recovery, and receipt states

Use the existing screen layouts and components. Update the English and French copy and reconnect affected prototype interactions. Add normalized handling to the corresponding issues for `success`, `transaction.status`, provider error codes, `message` / `detail`, and `transaction.pk` / `transaction.reference`. Prefer specific provider codes, check explicit PIN errors before broad invalid-number matches, and use a generic message for ambiguous results.

**Insufficient funds**
“Insufficient MoMo/OM balance. You need at least [total_amount] XAF in your wallet to cover the bundle + 2% payment fee.”

Show **Switch to [Cheaper Bundle Name] ([Cheaper Total with 2% fee] XAF)** when the fee quote is verified. Choose the highest-priced eligible published bundle strictly below the attempted base price, respecting device or router eligibility. Resolve equal prices consistently. One tap opens confirmation for that bundle. The customer still taps Pay Now to start payment. Omit the action if there is no eligible cheaper offer. If the fee quote is unavailable, use the fee-in-prompt wording and omit the numeric total.

**Confirmed expiry or timeout**
“Payment request expired. Dial `*126#` (MTN) or `#150#` (Orange) to approve pending prompts, or tap Retry to send a new pop-up.”

Use the short codes in release copy only once verified for Cameroon. Enable Retry only when the previous payment attempt is confirmed terminal.

**Confirmed cancellation or incorrect PIN**
“Transaction cancelled or incorrect PIN entered. Tap Retry when you're ready to approve the prompt.”

**Confirmed invalid subscriber or wrong network**
“This number isn't registered on [MTN MoMo / Orange Money]. Please check the number or switch networks.”

Give the customer a direct way to edit the number or select the other network.

**Pending after 30 seconds**
“Waiting for [MTN / Orange] confirmation. Approve the pop-up on your phone—your Wi-Fi will activate automatically once confirmed.”

Keep checking the existing payment and prevent a second charge while it remains unresolved. A later confirmed success should continue to activation automatically.

**Receipt and activation**
Keep payment confirmation and Wi-Fi activation visibly distinct. Show the confirmed fee and customer debit when available. Display a copyable provider reference on errors and receipts. Use the NDAHI Connect payment ID when no provider reference exists.

Add test criteria for each failure state, ambiguous errors, pending payments that later succeed, duplicate events, and cheaper-plan selection when prices tie or no eligible offer exists.

## 4. Prepare the customer brochure as the final deliverable

Once the design revisions are complete, create or update the matching **NDAHI Connect — Connect, Pay & Get Online** brochure and quick-start manual. Update the existing documentation issue if one exists. Otherwise, create one linked issue for the brochure.

Prepare separate English and French editions using the existing visual identity. Cover:

1. Joining the official Wi-Fi network and opening the captive portal. Include `portal.ndahiconnect.net` and a tested QR code.
2. Choosing from the published fixed-data, Personal Unlimited, and Home WISP offers.
3. Reviewing the wallet total, paying with MTN MoMo or Orange Money, and approving the operator prompt. Explain that customers enter their PIN only in the operator prompt.
4. Getting online, finding the receipt and support reference, checking remaining time or data where applicable, adding an authorized device, and setting up Home WISP on supported routers.
5. Troubleshooting low balance, a missing prompt, a pending payment, a wrong number or network, and payment confirmed while activation is still in progress.

Provide editable sources and export print-ready A4 and lightweight WhatsApp PDFs if export is available. Use demo data in screenshots. Before public release, check the guide against the tested portal, verify the QR code and support details, and include only confirmed fees, short codes, and router claims.

## 5. Return a change summary

For each revised feature, list the updated frame or prototype link, the matching GitHub issue link, and any decision or evidence still needed. Check the affected mobile and desktop frames in English and French, and make sure their prices, labels, and states match the issue acceptance criteria. If GitHub access is unavailable, provide ready-to-paste issue edits and identify the intended issue for each one.