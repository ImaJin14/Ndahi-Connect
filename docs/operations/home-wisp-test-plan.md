# Home WISP Unlimited: on-site test plan (#336)

Run on the **test HotSpot first**, then on the RB5009, before the Unlimited catalogue is switched on (#337). Post the filled results table on #336. #337's rollout uses these results.

## How it works

Home WISP Unlimited runs on the **NDAHI Home router path** (`docs/operations/ndahi-home.md`), which already does what spec §5 asks:

- **Registration.** The customer's router connects to NDAHI Wi-Fi in WISP or client mode. The customer signs in to the portal through it. RouterOS reports the router's upstream address during that local sign-in, and the customer confirms with their PIN (canvas PhoneHomeRouter, "Router found"). An address typed or sent by a browser is refused. A MAC or vendor prefix alone never authorizes anything.
- **Only that router.** The bundle is a HotSpot user bound to the router's address, so another router can't use it, and one address can't be linked to two accounts.
- **Sharing.** Home sessions never join the `ndahi-personal` address list, so the TTL rule from #335 never matches them. That is the sharing exception, and it exists only while the subscription is active on the registered router. Personal Unlimited bundles can't be moved onto a router, and a Home WISP bundle can't be moved off one.
- **When time starts.** After payment or a gift, the bundle waits. Registering the router starts it, once, for 30 days. If a router is already registered, it starts at payment. A code typed at the HotSpot or a phone's access request never starts it.
- **Replacing the router.** The old router is revoked and disconnected first, then the new one is bound. The end date doesn't change.
- **Expiry and revocation.** The Home worker disconnects the router and removes its authorization. It reconciles after failures, reconnects and router restarts, and withholds access while it can't confirm the entitlement. The customer sees "Sharing is paused"; admins can retry from Home routers.
- **Not sold while NDAHI Home is off.** Checkout refuses Home WISP Unlimited unless `NDAHI_HOME_ENABLED=true`. Admins can't make Home WISP resale stock.

NDAHI shows no device or router count for Home WISP (owner, 24 Nov): how many devices join is up to the customer's router.

## Before you start

- Router: the test HotSpot, later the RB5009. NDAHI Home's gateway preflight must pass: Admin → Home routers → **Check readiness** (`docs/operations/ndahi-home-readiness.md` §2). Write down the RouterOS version.
- Test environment: `NDAHI_HOME_ENABLED=true` on the API, and the catalogue switch on (owner: `POST /api/admin/catalogue/mode {"mode":"unlimited"}`).
- The #335 sharing rules applied and kept on the test HotSpot (`unlimited-sharing-rules-test-plan.md`).
- **Router A** and **Router B**: two WISP-capable routers, each with a phone or laptop on its private LAN. Mobile data off on every phone.
- **Phone P**: a Personal Unlimited bundle on another account, for comparison.
- A **legacy NDAHI Home** household (an earlier plan in Home mode), if one exists on the test HotSpot.

## Tests

| # | Test | Steps | Expected |
|---|---|---|---|
| 1 | **Waits for the router** | Buy Home WISP Unlimited for a test account with no router registered. | Admin → the voucher is *available*, with no start and no end. Nothing is created on the router. |
| 2 | **Register and start** | Set up Router A in WISP mode on NDAHI Wi-Fi. From a phone on Router A's LAN, sign in to the portal, choose Home router, continue to the local sign-in, then confirm with the PIN. | The router is found and registered. The bundle starts now and ends in 30 days. Admin → Home routers shows the household, authorization confirmed. |
| 3 | **Household sharing works** | Join two more devices to Router A's LAN and browse on each. | All browse. `/ip firewall address-list print where list=ndahi-personal` doesn't list Router A's address, and the `ndahi:sharing-ttl` counter doesn't rise for its traffic. (#335 acceptance test 4) |
| 4 | **Another router can't use it** | Connect Router B to NDAHI Wi-Fi with no registration. Try to browse behind it. Then try to register Router B to a second account while Router A is registered to the first. | Router B gets the sign-in page, not the internet. Linking an address already linked to another account is refused. |
| 5 | **Never from a phone directly** | On a phone connected straight to NDAHI Wi-Fi, sign in to the same account and request device access; also enter the Home WISP voucher code at the HotSpot. | Both are refused: "Home WISP Unlimited works through your registered router." The phone can't browse on this bundle. |
| 6 | **Replace the router** | From a device on Router B's LAN, sign in and replace the router (PIN). | Router A is disconnected first and loses access; then Router B is authorized and shares. The end date is unchanged. Admin → Home routers shows one replacement. |
| 7 | **Router reboot mid-session** | Reboot the RB5009 (or the test HotSpot router) while Router B is browsing. | After the reboot, the Home worker re-authorizes Router B within a few minutes without a new payment. No other router gains access in between. |
| 8 | **Outage: sharing paused** | Cut the API path to the router (for example disable the WireGuard peer) for 5 minutes, then restore it. | While the entitlement can't be confirmed, the customer's Home page shows the operation waiting, "do not pay again". After the path is back, the worker reconciles and sharing resumes. |
| 9 | **Expiry** | On the test environment, move the voucher's end to a minute from now (Admin, or a short custom gift: owner, 1 hour, Home WISP). Wait past it. | Router B is disconnected and its authorization removed. Devices behind it stop browsing. |
| 10 | **Revocation** | Admin → revoke the subscription (`POST /api/admin/vouchers/revoke`). | Router B is disconnected on the worker's next pass, and the revocation is audited. |
| 11 | **Personal stays restricted** | With Phone P on Personal Unlimited, share its hotspot to another phone. | The second phone can't browse through ordinary forwarding (#335). Phone P can't be switched to Home mode. |
| 12 | **Legacy NDAHI Home untouched** | Throughout, watch the legacy NDAHI Home household. | It keeps working exactly as before: same bundle, same data allowance and end date, never disconnected by these tests. |
| 13 | **Live devices: the router and Disconnect** (#381) | With Router B registered and browsing, open Admin → Live devices. Then open the household's row and press **Disconnect** on the router. | The household is one row, "1 router", with today's data and "online since" matching the router's session. Disconnect ends only the router's session (`/ip hotspot active`): it signs in again within a minute or two and the household browses again. The registration, the end date and the router binding are unchanged, and the request is in the audit log. If the router doesn't come back by itself, note it: the step must not be relied on until it does. |
| 14 | **The page finds the router before registering** (#351) | From a phone on Router A's LAN, open Account → Home WISP router and follow the three steps, then tap **I've done this — find my router**. Then tap **That's not my router** once, and find it again. | After the router's sign-in the page shows **Router found**: "Upstream address ••:••:••:" with the last three pairs of Router A's upstream MAC (as RouterOS reports it, never from the phone), "Seen just now" and, with device places on, the access point it is on. Nothing is registered until **Register this router** with the PIN; "That's not my router" goes back to the steps. |
| 15 | **The page follows the router's state** (#351) | With Router A registered, open the page. Then run test 8's outage while it is open, and restore. Then tap **Replace this router**. | Registered: "Sharing with your household", **Online**, the router's masked address and the subscription's end. During the outage: **Checking**, "Sharing is paused… last try N min ago. You don't need to pay again." within about 15 seconds, and back to Online after it. Replace shows the explanation and **I've done this — find my router**, which leads to test 6. No device or router count anywhere. |

## Record the results

| # | Date | Router (test HotSpot / RB5009) | RouterOS version | WISP router model | Pass / fail | Notes |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |
| 6 | | | | | | |
| 7 | | | | | | |
| 8 | | | | | | |
| 9 | | | | | | |
| 10 | | | | | | |
| 11 | | | | | | |
| 12 | | | | | | |
| 13 | | | | | | |
| 14 | | | | | | |
| 15 | | | | | | |

Also note which WISP router models worked. Only routers that pass belong in "supported routers" in customer copy.
