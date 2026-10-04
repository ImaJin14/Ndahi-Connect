# Receipt and recovery accessibility review

Reviewed: 2026-10-05. Public source base:
`78eacae7cdeb3be3ccc0e0d2b4427fb1d0739c75`.

Google Antigravity inspected the customer receipt and saved-checkout sources in
its assigned worktree. Its CLI returned a partial report after the 120-second
print timeout. Codex reviewed the returned finding and reproduced the focus
failure below in local Chrome with Playwright 1.63.0. Other draft findings have
not been accepted as verified. This is an initial contribution to A11Y-002/003;
the full receipt, keyboard, screen-reader, and 200%/400% zoom audit remains open.

## Verified: closing a resumed expired checkout loses focus

The affected flow is an interrupted guest payment resumed after its approval
window and grace period. After the checkout reports that the payment expired,
closing the dialog does not return focus to an available package or other
relevant visible control.

Source locations in [customer-app/onboarding.js](../../customer-app/onboarding.js):

- The saved-payment handler calls `showCheckout()` at line 193 without recording
  an opener. Normal package selection records its opener in `openCheckout()` at
  lines 249–253.
- `releaseFailedPayment()` clears `paymentInProgress`, removes the resume notice,
  and rerenders the package buttons at lines 298–308. An earlier stored package
  button can therefore also be detached.
- `closeCheckout()` hides the dialog and attempts `checkoutTrigger?.focus()` at
  lines 267–273. The pending-payment fallback at lines 274–278 is unavailable
  after expiry.

### Local reproduction and evidence

Codex used the existing “an expired guest checkout closes and can be started
again” fixture in `scripts/check-billing-journeys.mjs`, with temporary focus
instrumentation. All payment, email, router, and storage adapters were local mock
fixtures; remote browser requests were blocked.

1. Start a guest Weekly checkout and simulate a lost response after the API saves
   the payment, preserving its local-storage recovery input.
2. Open a new page in the same browser context after advancing the fixture clock
   eight minutes. Select **Resume saved payment** and wait for the expired-payment
   message and **Buy Weekly** checkout heading.
3. Select **Back to packages** (`#closeCheckout`) and inspect
   `document.activeElement` after two animation frames.
4. Press Tab once and inspect focus again.

Observed in a 1440px Chrome viewport:

| Point | Active element |
| --- | --- |
| Immediately after close | Hidden `button#closeCheckout` |
| After two animation frames | `BODY` |
| After one Tab press | `BODY` |

The existing scenario still passed its payment-expiry and fresh-checkout
assertions. Those assertions do not check focus restoration. This observation
confirms the missing focus destination in this flow; it does not establish a
permanent keyboard trap across browsers.

## Assigned next steps

Google Antigravity owns the proposed focus correction. Restore focus to a
connected, visible, enabled control after a resumed checkout closes, including
when the resume button or original package button has been replaced. Agree
ownership of `customer-app/onboarding.js` with Codex before editing it.

Add a browser assertion for the focus destination after closing expired and
failed recovery dialogs. Cover the close button and Escape, normal package
checkout, and still-pending recovery. Then finish receipt/download/email keyboard
checks and actual 200%/400% zoom/reflow verification. Screen-reader behavior
requires a separate recorded check. No UI correction is included in this report.
