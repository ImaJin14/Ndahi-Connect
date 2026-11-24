# Personal Unlimited device slots: on-site test plan (#334)

Run on the **test HotSpot** before the Unlimited catalogue is switched on (#337). Nothing here changes the live RB5009 until the switch is on: device slots apply only to bundles bought or given from the Unlimited catalogue.

## Before you start

- Router: the test HotSpot (or the RB5009 in a test window). Write down the RouterOS version and the router board.
- Admin → Network setup: **device approval is on and live**. The admin catalogue view (`GET /api/admin/catalogue`) shows `deviceApproval: true`. Slots bind to the MAC the router sees, which needs device approval.
- Catalogue switch on **in the test environment only** (Admin → catalogue, owner: `POST /api/admin/catalogue/mode {"mode":"unlimited"}`).
- Phones: **A** and **B** (and **C** for the two-device test), each with **mobile data off**, Wi-Fi joined to the test SSID. Note each phone's per-network Wi-Fi address (private MAC is fine).
- A customer account with a PIN, and Mobile Money in sandbox, or the owner's own number.
- Also one **legacy bundle** (for example Weekly or Connect Family) on another account, with devices online.

## Tests

| # | Test | Steps | Expected |
|---|---|---|---|
| 1 | **Waits for its first connection** | Buy "Personal Unlimited · 24 hours · 1 device". | Admin → the voucher shows status *available*, no start and no end. Nothing is created on the router yet. |
| 2 | **First connection starts it** | On phone **A**, sign in to the portal and connect this device (or enter the code at the HotSpot). | The bundle starts now: its end is 24 hours from this moment. The router gets the HotSpot user, and phone A browses. |
| 3 | **One slot: Phone B denied while A is online** | On phone **B**, sign in to the same account and request access. | Refused: "This bundle's device slot is in use…". Phone B can't browse. |
| 4 | **Full slots + offline device** | Turn phone **A**'s Wi-Fi off. Wait 3 minutes, until A is gone from the router's active list. Request access from phone **B** again. | Still refused: a registered device holds its slot while offline. |
| 5 | **Registered device reconnects** | Turn phone **A**'s Wi-Fi back on. | A browses again without a new request. |
| 6 | **Replace while the old device is online** | With **A** online, forget A from the account (PIN). Then request access from **B**. | The router removes A's session, saved login and binding, and A stops browsing. Until the router confirms, B's request is refused; once confirmed, B connects. Admin → the voucher shows 1 replacement, and its end date is unchanged. |
| 7 | **Router unreachable mid-replace** | Cut the API path to the router (for example disable the WireGuard peer). Forget **B**, then request access from **C**. Restore the path after 2 minutes. | While the router is unreachable, C is refused and B keeps its slot ("Wait for this device's saved access to be removed…"). After the path is back, the removal completes, then C can connect. At no time are both B and C authorised. |
| 8 | **Admin revoke** | Admin → revoke **C** from the bundle, with a reason (`POST /api/admin/vouchers/devices/revoke`). | C stops browsing once the router confirms (the response says `pending`, then the slot frees). Audited with the reason. |
| 9 | **Two slots** | Buy "Personal Unlimited · 24 hours · 2 devices" on a second account. Connect **A**, then **B**, then try **C**. | A and B browse; C is refused, also with A offline. |
| 10 | **Legacy bundle untouched** | Throughout, the legacy bundle's devices (up to its own device rule) stay online. | No device on the legacy bundle is disconnected, refused or re-bound. |

## Record the results

| # | Date | RouterOS version | Pass / fail | Notes |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | |
| 9 | | | | |
| 10 | | | | |

Post the filled table on #334. #337's rollout uses these results.

## How it works

- **Binding.** A slot is a device approval bound to the MAC the router saw when the device made its authenticated access request (`lib/wifi-approval.mjs`). A MAC sent by a browser is never used.
- **Counting.** A device holds its slot while approved, online or not. A removed device holds it until the router confirms the removal. So the replacement can't be authorised before the old device is gone, and a failed removal changes nothing (`lib/device-slots.mjs`).
- **Validity.** Replacing or revoking never restarts or extends the bundle.
- **First connection.** A Personal Unlimited bundle waits after payment or a gift, and its first connection starts it, once. That connection is either the code entered at the HotSpot or a device's access request.
