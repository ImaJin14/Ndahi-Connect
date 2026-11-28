# Get connected (ConnectFlow): flow audit, 27 Nov 2026

Issue #393. The design board `ConnectFlow` maps every way onto NDAHI Wi-Fi: joining the network, five paths, and the recoveries. Each step links to the board of its screen. This audit checks every step against the built portal and names the journey that walks it.

**Result:** every path and recovery on the board is built, and a passing journey walks it. Nothing differs from the board, so no code changes.

## How it was run

- Main at `eaea2fb4` (27 Nov). The one later merge, #559, changes only the store and the admin's Promotions.
- Local servers: the API with mock payments, a mock MikroTik router and mock email, and the portal, in Playwright's Chromium.
- **v2 (redesign):**
  - the redesign browser tests for the flow's screens: 15 tests, all pass;
  - `check:hotspot:browser`, `check:billing` and `check:pending`, run with v2 forced (`NODE_OPTIONS=--import=./scripts/ui-v2-journeys.mjs`).
- **v1:** the same three suites, with `ADMIN_UI_DEFAULT=v1 CUSTOMER_UI_DEFAULT=v1`, as CI runs them. They all pass. v1 is frozen and keeps its own screens.
- Not covered: staging, a real router, real Mobile Money. Nothing here is physically verified.

## Step 0: join NDAHI Wi-Fi

| Board step | Built screen (board) | Walked by |
| --- | --- | --- |
| The phone opens the sign-in page; it works without a bundle and shows the network's state | `/hotspot` (PhoneHotspot) | `get-connected`: "the Wi-Fi landing offers the four ways online with the network's state". `phone-hotspot`: the owner's hotspot name shows on the page |

The page's four links open the paths below: I have an account (`/login`), I have a code (`/login?voucher=1`), Use a bundle from another phone (`/pair`), and I'm new, buy a bundle (`/onboarding.html`). Each carries the device's Wi-Fi details.

## Path 1: I have an account

| Board step | Built screen (board) | Walked by |
| --- | --- | --- |
| Sign in: phone + PIN, or passkey | `/login` (PhoneLogin) | `phone-sign-in`; `check:pending`: "customer login locks competing methods and restores PIN retry" |
| Bundle active: finish Wi-Fi sign-in, which uses 1 of the bundle's devices, then online | `/wifi-connected.html` (PhoneWifiConnected) | `wifi-finish`: "a PIN sign-in on NDAHI Wi-Fi asks before connecting, then shows You're online". `check:hotspot:browser`: "a refused login with every device slot in use lets the customer free one" |
| No bundle: goes to Path 4, already signed in | Buy a bundle | `check:hotspot:browser`: "a used-up bundle offers renewal instead of sending credentials" |

## Path 2: I have a code

| Board step | Built screen (board) | Walked by |
| --- | --- | --- |
| Enter a voucher code; it starts on this device at once | `/login?voucher=1` from the Wi-Fi page, or "Enter a voucher code" in the portal (PhoneVoucher) | `check:hotspot:browser`: "portal sign-in waits for provisioning then posts credentials to the fixed HTTPS router" (phone + code, then the PIN). `customer-voucher-entry` covers a signed-in customer |
| A plain voucher goes online straight from the code screen | The Wi-Fi page connects at once after a voucher sign-in, with no extra "Finish" step | the same `check:hotspot:browser` scenario |
| A code for a number (a gift): claim with number + code, create a PIN, start now or later | `/claim.html` (PhoneClaimGift) | `claim-gift`: "a reserved bundle is claimed with its number and code, and staff can see and move it" |

## Path 3: scan a QR

| Board step | Built screen (board) | Walked by |
| --- | --- | --- |
| Checks the code and finds the account, then confirm with PIN or passkey; the device is added and shows in Devices | `/voucher-connect.html` (PhoneScanConnect) | `scan-connect`: "a scan shows the account's card, connects after the PIN and handles the other states" |
| No active bundle: offer to buy, then connect without scanning again | PhoneScanNoBundle | `phone-scan-no-bundle`: "a scan with no active bundle shows the account as drawn, and a purchase made from it comes back to the scan" |

## Path 4: I'm new, buy

| Board step | Built screen (board) | Walked by |
| --- | --- | --- |
| Pick a plan, pay with MTN MoMo or Orange Money; the number becomes the account | Buy a bundle (PhoneBuyBundle) | `phone-buy-bundle`: "phone customers choose a bundle, pay and get online in Buy a bundle" |
| Approve on the phone; the screen updates by itself; online, receipt in Activity | Buy a bundle, Activity | `phone-buy-bundle`. `check:billing`: "download and email a paid receipt", "lost response survives closed tab and resumes one guest payment" |
| It didn't go through (declined, low balance, timeout, wrong network): a clear next step, never pay twice | PhonePaymentFailed | `payment-failed`: "a guest sees the payment's state as drawn and the next step, on phone and desktop". `check:billing`: "unconfirmed terminal payments have no receipt, refund or recheck actions" |

## Path 5: use someone's bundle

| Board step | Built screen (board) | Walked by |
| --- | --- | --- |
| Enter the pairing code shown on the owner's Devices screen | `/pair` (PhonePairRequest) | `check:hotspot:browser` (wifi-pairing and matching-access journeys): "two independent browsers approve and finish native captive sign-in once without granting the guest an account session" |
| The owner checks the same reference and approves on their phone | `/pair-review.html` (PhonePairReview) | the same scenario; "wrong approval code remains actionable without completion"; "an unknown third device requires approval and cannot exceed the bundle's two-device limit" |
| Online; the owner can remove it any time | Devices | `check:hotspot:browser`: "a failed router disconnect leaves the device and occupied slot visible with a retry" |

## Recoveries

| Board step | Built screen (board) | Walked by |
| --- | --- | --- |
| Not on NDAHI Wi-Fi: join steps, then check again | PhoneScanConnect | `scan-connect`: the three join steps and "Check again" |
| Someone else signed in: sign them out safely, or stay | PhoneScanConnect | `scan-connect`: "This device is signed in as Kofi T. The code you scanned belongs to Amina N." and Stay |
| Forgot PIN: email link, 15 minutes, one use | PhoneForgotPin | `phone-forgot-pin`: "Forgot PIN walks the drawn steps, takes 4 to 6 digits, and keeps the support code" |
| Payment declined: no money taken, try again | PhonePaymentFailed | `payment-failed` |
| Network is down: status shown, time given back | PhoneOutage | `outage-unlimited`: "an outage on a running Unlimited bundle reads as drawn, and Home draws no Wi-Fi panel" |

## The board's rules

- **A PIN or a passkey only.** Sign-in offers phone + PIN, a passkey, or a voucher code followed by the PIN. There are no SMS codes (`phone-sign-in`, `check:pending`).
- **Scanning or entering a code never connects a device on its own.** A scan asks for the account's PIN or passkey (`scan-connect`). A pairing request waits for the owner's approval (`check:hotspot:browser`: "secondary voucher entry cannot skip main-device approval or create an account session").
- **Nobody can buy while a bundle is active.** Buy a bundle shows "You can buy once your current bundle has ended" to a customer with a running bundle (`phone-buy-bundle`, `desktop-buy`).

## Not yet

Walked on staging or on site, with a real MikroTik router and real MTN and Orange payments.
