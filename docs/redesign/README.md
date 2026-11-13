# NDAHI Connect redesign — handoff

Everything an agent needs to build the redesign is in this folder. It was assembled from the design canvas and plan doc on claude.ai, which agents in the repo can't open.

| File | What it is |
| --- | --- |
| [`execution-plan.md`](execution-plan.md) | The eight phases, done-when criteria, testing bar, risks, and which agent leads each phase. **Start here.** |
| [`decisions.md`](decisions.md) | Product decisions already made, and the open questions the owner still has to answer. |
| [`screens/`](screens/) | Source of all 65 canvas screens (`*.dc.html`) and the canvas index (`canvas.json`). |
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

## Screen index

**Customer — phone:** PhoneHome, PhoneInternet, PhoneShop, PhoneActivity, PhoneAccount (the five tabs, with `TabBar`); PhoneBuyBundle, PhoneCheckout, PhoneOrder, PhoneProduct, PhoneReceipt, PhoneVoucher, PhoneVoucherReady, `VoucherSlip`; PhoneScanConnect, PhoneScanNoBundle, PhoneHotspot, PhoneWifiConnected; PhoneLogin, PhonePasskey, PhoneForgotPin, PhoneChangePin, PhoneSessions, PhoneEditProfile; PhoneDevices, PhonePairRequest, PhonePairReview; PhoneNotifications, PhoneHelp, PhoneBillingTerms, PhoneHomeRouter.

**Customer — desktop:** Main (home), DesktopInternet, DesktopActivity, DesktopAccount, Shop, ProductDesktop.

**Public store (guests):** StoreGuest (desktop), PhoneGuestShop, PhoneGuestProduct, PhoneGuestCheckout, PhoneGuestOrder.

**Admin:** AdminLogin, Admin (home), AdminSide (menu); AdminPayments, AdminCash, AdminResellers; AdminStore, AdminProducts, AdminProductEdit; AdminVouchers, AdminVoucherDetail, AdminVoucherPrint; AdminBundles, AdminBundleEdit; AdminCustomers, AdminCustomerDetail, AdminDevices; AdminConnections, AdminNetworkSetup, AdminHomeRouters, AdminAudit, AdminProfile.
