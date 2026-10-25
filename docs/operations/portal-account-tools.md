# Customer portal navigation, vouchers and account profile

The authenticated portal now has Home, Bundles, Vouchers, Payments and Account views. Mobile devices use bottom navigation; wider screens use a sidebar. Hash URLs support direct links, Back and refresh. Existing `#managePlan`, `#billing` and `#accountSecurity` links select the corresponding view. Home keeps connection/device controls and shortcuts to bundles and vouchers. Device polling pauses outside its view and resumes on return.

## Vouchers

The signed-in dashboard returns the customer's own voucher codes, including historical vouchers. The Vouchers view offers copy and individual PDF downloads. Status remains authoritative: downloading an expired, exhausted, renewed, switched or refunded voucher does not restore access.

`GET /api/account/vouchers/:id/download` requires the owning customer's session and returns a PDF with `Cache-Control: no-store`. The URL contains the voucher ID, never its code. The document records the code, package, status at download, current account number and activation/expiry information. Downloads are available outside Wi-Fi coverage and after bundle expiry. No account or voucher data is stored in the service-worker cache.

## Payment numbers

Authenticated renewals and plan changes accept an optional `payerPhone` on `/api/account/plan/purchase`. It defaults to the account number and is validated/normalized like existing Cameroon numbers. The payment always belongs to the authenticated customer ID, even if another account's number pays.

The actual payer number and Mobile Money network stay on that payment. History, receipt preview, PDF and receipt email use the recorded payer; historical records without it say so. A later profile change does not rewrite payment history. Alternate numbers do not become account settings or payment preferences. Every new checkout defaults to the current account number; resuming a submitted payment retains its original payer. Reusing a checkout key with a different payer or network is rejected, preventing an existing request from silently changing its payment target.

## Combined profile edits and account-number changes

Account now exposes one Edit profile form. Name, number and optional email can change together; email changes stage the entire candidate until mailbox confirmation. Number/email changes require fresh PIN or action-bound passkey proof, preserve the same customer/history/devices, and rotate portal sessions after commit. See [combined profile editing](profile-editing.md) for API semantics, concurrency, idempotency and rollback.

Per the user's25October2026 clarification, number handling uses automatic MTN/Orange suggestions from the existing prefix map, with manual choice at checkout and no automatic payment. No SMS service or SIM-ownership claim is introduced. Normalized unique number changes retain `phoneVerified:false`. The API exposes E.164 while preserving canonical nine-digit storage for existing domain integrations.

## Optional signup email and confirmed email updates

Signup email is optional with the configured MeSomb Mobile Money checkout. Without a linked email, customers can purchase, create a PIN, sign in, view balances, manage devices and download vouchers/receipts. Email updates, purchase messages, security notices and email PIN recovery require a linked address. Web/PWA feature updates do not require email. A customer without email recovery who loses their credentials needs support.

New signup addresses are saved with `emailVerificationRequired: true` and cannot receive account mail or reset links until confirmed. Existing accounts that predate this flag retain their existing email delivery/recovery behavior; they can replace or reconfirm their address from Account. Payment records retain the original contact email and actual payer independently of later profile edits.

Account offers a separate linking flow:

1. `POST /api/account/profile/email` accepts `email`, fresh `pin` (or a passkey response obtained from `/api/account/profile/email/options`) . Production CSRF/origin checks apply. Passkey proof is bound to this session, the current account and proposed email; it cannot authorize phone changes.
2. The API emails a six-digit code to the proposed address. Only a keyed hash is stored in the customer JSON; the code never appears in an API response, URL or dashboard. Confirmation lasts ten minutes, permits five guesses and is bound to the initiating portal session. Requesting another code is limited to once per minute and five per hour, in addition to credential/IP failure limits.
3. `POST /api/account/profile/email/confirm` accepts `code`. Until it succeeds, the previous linked email remains unchanged. Confirmation records `emailVerifiedAt`, rotates the current session, signs out other portal sessions and revokes outstanding login/reset/enrollment challenges. The customer receives a security notice through the existing mail queue. An uncertain send remains confirmable if the email arrives; the UI can recover a lost request/confirmation response without replaying it.

Configure the existing Resend integration for confirmation delivery. Mock codes are never returned to clients; browser tests capture them through an injected test adapter. Receipt history can be downloaded without email; the Payments view offers linking guidance and enables its Email receipt action once an address is linked. Linking does not automatically email the entire historical receipt archive.

[MeSomb's collection API](https://docs.mesomb.com/development/payment) permits an absent customer email. [Flutterwave's francophone Mobile Money API](https://developer.flutterwave.com/reference/charge-via-francophone-mobile-money) requires one: if an operator switches to Flutterwave, checkout explicitly requests a payment contact email rather than inventing an address. For an existing account without email this is a transaction contact and does not silently link a notification address.

## Installed-app updates

Pages contain the release marker associated with their versioned assets. `/version.json` returns the current release with `Cache-Control: no-store`. The dashboard and checkout check on launch, foreground return, reconnect and periodically while visible. An idle portal refreshes automatically when a new release is found. Offline/failed checks retry later.

Payments, open checkout/receipt dialogs, credential verification and edited forms defer automatic refresh. An update notice explains that a release is ready. Its refresh action stays disabled during active protected tasks; discarding unsaved form edits requires confirmation. A refresh retains the current view URL. Login and router handoff are not forcibly refreshed. Account data and submitted payments remain server-backed, so no reinstall is needed to receive portal feature updates on the next successful online load.

## Deployment and checks

1. Deploy the API to **all replicas first**, then deploy the customer portal. The older API ignores an unfamiliar payer field, so do not expose alternate-payer checkout until the new API rollout is complete.
2. No SQL migration or new SMS service is required. Preserve the purchase-only coverage policy: account/voucher/history access works off-network, while new purchases require NDAHI Wi-Fi.
3. Test a designated account's historical/current downloads, alternate-payer checkout and transaction recovery, number collision, PIN/passkey and passkey verification, other-session revocation and the new default after a profile change. Test signup without email, confirmation delivery/expiry, replacing an email and PIN recovery only after linking.
4. With an installed app open, deploy a test release and verify idle refresh, foreground/reconnect checks, unsaved-form protection and payment deferral. Test Android Chrome, iPad Safari/home-screen mode, narrow screens and landscape/keyboard behavior on the physical devices.

`npm test` covers API ownership, payer/default separation, immutable transaction history, CSRF, PIN/passkey, session/challenge invalidation, rate limits and version metadata. `npm run check:portal:browser` adds responsive navigation, clipboard/PDF, alternate-payer recovery, real WebAuthn assertions using a virtual authenticator, and update deferral/reconnect fixtures. It runs in the regular browser CI suite alongside existing billing, authorization, pending-state, HotSpot and coverage journeys. Physical-device checks remain necessary for browser/OS behavior that fixtures cannot establish.
