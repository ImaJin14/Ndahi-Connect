# NDAHI Connect redesign — handoff

Everything an agent needs to build the redesign is in this folder. It was assembled from the design canvas and plan doc on claude.ai, which agents in the repo can't open.

| File | What it is |
| --- | --- |
| [`execution-plan.md`](execution-plan.md) | The eight phases, done-when criteria, testing bar, risks, and which agent leads each phase. **Start here.** |
| [`decisions.md`](decisions.md) | Product decisions already made, and the open questions the owner still has to answer. |
| [`screens/`](screens/) | Source of all 64 canvas screens (`*.dc.html`) and the canvas index (`canvas.json`). |
| [`prompts/`](prompts/) | Ready-to-run prompts, one per PR. `phase-0-rollout-switch.md` is first. |
| [`../../AGENTS.md`](../../AGENTS.md) | Rules every agent follows (Claude Code, Antigravity, Codex, Copilot). |

## Reading the screen files

The `*.dc.html` files are design-canvas sources, not production pages. They won't render on their own (they expect the canvas runtime `support.js`), but they are plain HTML and easy to read:

- **Layout and styles** are inline. Colours, type, spacing and radii are the values to turn into tokens in Phase 1.
- `<dc-import name="X">` embeds another screen file — for example `TabBar`, `AdminSide` or `VoucherSlip`.
- `<sc-if value="{{flag}}">` and `<sc-for list="{{items}}">` show conditional and repeated blocks. The `class Component extends DCLogic` script at the bottom shows the states and sample data.
- `data-props` on that script lists the screen's variants (for example `PhoneScanConnect` has `active`, `noBundle`, `notOnWifi`, `wrongAccount`).
- Placeholders in square brackets — `[PRICE]`, `[PLAN 2]`, `[XAF]`, `[PICKUP LOCATION]` — must come from the API, never be hard-coded.
- `href="Other.dc.html"` links show the intended navigation between screens.

Screens are 390 × 844 (phone, `Phone*`), 1280 wide (desktop, `Desktop*`, `Shop`, `ProductDesktop`, `StoreGuest`, `Main`), or 1280 wide with the admin side menu (`Admin*`).

## Visual references

PNG exports of each screen can be added to `screens/png/`, named like the artboards (`PhoneHome.png`). Until then, ask the owner for a screenshot of the screen you're building, or a link to the canvas. Agents with a browser (Antigravity) should compare their result against the PNG at 390 px and 1280 px.

## Local preview and design-vs-build captures

`node scripts/redesign-preview.mjs` starts the portal (:8080), admin (:8081), API (:8082), public store (:8083) and a design page (:8090) that renders the canvas sources with a local stand-in for `support.js` (`scripts/redesign-preview-canvas.js`). Everything is in memory with mock payments, email, router and Omada; nothing external is contacted and no real credentials are used. Add `--capture` (Playwright's Chromium must be installed) to capture every screen once, or press **Capture again** on `:8090/compare`. Captures and `manifest.json` go to `/tmp/ndahi-redesign-preview`.

The screen list (`SCREENS` in the script) pairs each artboard with the page that builds it. A capture counts only when all of this holds:

- **Design:** the artboard answered 200, the runtime set `data-dc-ready=""` (not `"error"`, which any failed import, parse error, uncaught script error or unhandled rejection before ready produces), the page is still that artboard, and something was drawn.
- **Build:** the page answered 200; every click/fill step worked; the address is the screen's page and matches its `hash`; the tab/panel/menu and every `expect` selector are visible; no `reject` selector (the store's `#message`, `#checkoutError` and "Loading store…", the portal shop's error line) is visible — and all of it is checked again after the page stops changing, so a late error or redirect is caught.

Otherwise the result is **failed** with the reason, no gallery PNG is kept (old ones are removed first), and a `-failed.png` of what was on screen is saved for diagnosis only. **Blocked** screens are pages the preview can't put in the artboard's state; their capture checks for, and is labelled with, what they show instead, and never counts as a match. The manifest records the source commit (and uncommitted changes), viewport, session, state, steps, final address and error of each capture.

Guest store selectors follow the full-page store (bb1f908): products open at `#product/<id>` (`body[data-view="product"]`, `#productTitle`, enabled `#buy`); checkout is the `#checkoutDialog` over that page; a guest order is `.order-page` with `.code-card__code` and `#privateLink` at `#order/<id>/<token>` (`.order-card` is the Orders list, not one order). `npm test` covers the screen inventory, that these selectors still exist in `store-app/` and `customer-app-v2/portal-shop.js`, the canvas helpers, and the capture rules (with a scripted fake browser, `test/redesign-preview-capture.test.mjs`); it does not open a real browser.

## Screen index

**Customer — phone:** PhoneHome, PhoneInternet, PhoneShop, PhoneActivity, PhoneAccount (the five tabs, with `TabBar`); PhoneBuyBundle, PhoneCheckout, PhoneOrder, PhoneProduct, PhoneReceipt, PhoneVoucher, PhoneVoucherReady, `VoucherSlip`; PhoneScanConnect, PhoneScanNoBundle, PhoneHotspot, PhoneWifiConnected; PhoneLogin, PhonePasskey, PhoneForgotPin, PhoneChangePin, PhoneSessions, PhoneEditProfile; PhoneDevices, PhonePairRequest, PhonePairReview; PhoneNotifications, PhoneHelp, PhoneBillingTerms, PhoneHomeRouter.

**Customer — desktop:** Main (home), DesktopInternet, DesktopActivity, DesktopAccount, Shop, ProductDesktop.

**Public store (guests):** StoreGuest (desktop), PhoneGuestShop, PhoneGuestProduct, PhoneGuestCheckout, PhoneGuestOrder.

**Admin:** AdminLogin, Admin (home), AdminSide (menu); AdminPayments, AdminCash, AdminResellers; AdminStore, AdminProducts, AdminProductEdit; AdminVouchers, AdminVoucherPrint; AdminBundles, AdminBundleEdit; AdminCustomers, AdminCustomerDetail, AdminDevices; AdminConnections, AdminNetworkSetup, AdminHomeRouters, AdminAudit, AdminProfile.
