# Retained purchase voucher delivery (#142)

Payment settlement remains server-verified and transactional. It saves the single
existing NC-XXXX-XXXX voucher before returning success. Replayed callbacks/reloads
reuse that voucher; PDF, download, email or installation failure cannot generate
another voucher, reverse a paid result or reserve another charge.

## Customer flow

1. A new guest confirms payment and receives the existing short-lived HttpOnly
   PIN-setup grant. It is not a Dashboard/PDF session. The customer completes PIN
   setup (or an established customer signs in with PIN/passkey).
2. A paid purchase/renewal/swap opens **Your saved voucher** after account sign-in.
   The page resolves the exact payment/voucher from the authenticated Dashboard,
   verifies the paid/confirmed association and shows its original code. No PIN,
   voucher code, approval code or checkout key is carried in the page URL.
3. **Download Voucher** retrieves the existing private no-store PDF API. Repeated
   retrieval works for retained active/expired/exhausted history. Content type and
   the PDF signature are checked before a blob is offered. Browser handoff is
   labelled “offered”, never proof that the file reached storage.
4. A download-supporting non-Apple standalone app without captive identity may
   offer one automatic download per browser session/voucher. The offer marker
   contains only the opaque voucher id; denied storage disables automatic offers.
   Ordinary browsers, Apple/iPad, WebViews and captive identity paths use the
   explicit action. Failed/blocked downloads leave it available for retry.
5. The customer chooses **Continue to Dashboard / Wi-Fi**. This is the only step
   that resumes the existing connectivity/HotSpot navigation. Download initiation
   never closes the captive window or proves internet access. Vouchers and payment
   receipts remain accessible through their Dashboard sections, and installation
   is optional. Separate installed/browser cookie jars require normal sign-in.

Without email a customer can finish normally. #141 already queues the voucher PDF
for the verified associated address according to saved transactional consent;
provider outages retry independently. This issue does not invent another email
pipeline or use a transaction payer as an account owner. Account history remains
the fallback if mail fails, is disabled or is not verified.

A bookmark for an unrelated/unconfirmed purchase does not substitute another
voucher or reveal a code. Session expiry redirects through the safe destination
allowlist back to this account-authenticated page. No private response/document
is cached by the service worker. Existing recovery and payment help remain
available; delivery trouble is never a reason to pay again.

## Verification / release boundaries

Tests cover verified duplicate callbacks, one NC code/customer/payment, limited
setup-cookie isolation, private/repeatable real PDF retrieval, correct purchase
selection, safe return paths, PDF failure/signature rejection and permitted auto
offer contexts. The existing full paid signup journey now asserts retention
before router work, including blocked storage, reload, main-device selection and
secondary approval/reconnect. Renewal/swap/payment browser tests include the new
explicit continuation. New 320/1280 px journeys cover failed PDF/retry, repeat
history retrieval, standalone offer without forced close/redirect, captive/blocked
storage manual fallback, separate-session sign-in and unrelated purchase privacy.

Run `node --test test/voucher-delivery.test.mjs`,
`node scripts/check-voucher-delivery-journeys.mjs`, and the standard signup,
plan/billing and full browser suites. #141's independent transactional rollback,
verified-recipient/PDF and email-provider fixtures remain prerequisites.

This is source/test evidence only, not merge/deployment or physical acceptance.
Record actual iOS/Android native captive behavior, blocked blob/file access,
Downloads storage, separate standalone session restoration and configured verified
email inbox delivery before release acceptance. Browser download events and
synthetic email provider acceptance do not prove a person retained a file/mail.
