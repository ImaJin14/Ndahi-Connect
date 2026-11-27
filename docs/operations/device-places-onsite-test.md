# Where a device is: on-site check (#344, #341)

The voucher page says where a code was redeemed ("Redeemed by J. Fon on an Android phone at AP-Market"). Customer detail's Devices tab (#341) says where each device is ("online at AP-Market since 08:12").

The access point comes from the Omada controller's client list, matched to the MAC the router saw. The owner chose on 26 Nov to build it and check it on-site before anyone relies on it ([#344 decision](https://github.com/ImaJin14/Ndahi-Connect/issues/344#issuecomment-7202629546)).

The device kind ("an Android phone") comes from the browser that entered the code or asked for access. It is a display hint, never identity.

## What runs

- `lib/device-places.mjs` asks the controller for its clients once a minute and records:
  - the access point of a voucher started in the last six hours, from the first device the router read on it;
  - each approved device slot's current access point, and since when.
- It only reads. Nothing is sent to the controller or the router.
- It writes only when a place changes.
- It is off unless `DEVICE_PLACES_ENABLED=true` is set on the API.
- With the setting on, it still does nothing until a **live** Omada connection is saved in Admin → Network setup.
- With `OMADA_MODE=standalone`, or with no saved connection, nothing shows and nothing changes.

## Before you start

1. Admin → Network setup: a live Omada controller connection is saved, and "Check controller" lists the access points.
2. On the API service in Render, set `DEVICE_PLACES_ENABLED=true` and let it redeploy. This is the owner's step.
3. You need a phone you can sign in with, a test voucher made in Admin (Vouchers → Batch), and two access points you can walk between.

## Steps

1. **Controller list.** Connect the phone to NDAHI Wi-Fi near the first access point (say AP-Market). In the Omada controller, confirm the phone is listed as a client on that access point.
2. **Redeemed at.** On the phone, sign in with the test voucher's code.
   - Within two minutes, open the voucher in Admin.
   - History says "Redeemed by … on an Android phone at AP-Market" (or iPhone, or the phone's kind).
   - Record the time it took.
3. **A device's place (#341, once merged).** With a Personal Unlimited bundle on the phone, open the customer in Admin → Devices.
   - The phone's slot says "online at AP-Market since HH:MM".
4. **Moving.** Walk to the second access point and wait two minutes, then refresh Devices.
   - The slot names the second access point, with a new "since" time.
   - The voucher's "Redeemed at" stays at the first access point.
5. **No controller.** Set `DEVICE_PLACES_ENABLED=false`, or remove the controller connection, and redeem another code.
   - Its history says "Redeemed by … on an Android phone", with no place.
   - Nothing else changes.

## If something is wrong

- **No place after five minutes:** check the controller's API version.
  - The client list is read from `GET /openapi/v1/{controllerId}/sites/{siteId}/clients`, page by page.
  - A controller that answers it differently gives no places, and logs `device_places.failed` on the API.
  - Turn the setting off and report the controller version on #344.
- **A wrong access point:** report the client's MAC suffix, the access point the controller shows and the one the page shows on #344.
- Turning `DEVICE_PLACES_ENABLED` off stops new places at once. Places already recorded stay as history.

## Record

Write the results on #344, including:
- the controller version;
- the times from steps 2 and 4;
- what each step showed.

Until then, the checklist entry keeps "a place shown from the live controller" under "Not yet".
