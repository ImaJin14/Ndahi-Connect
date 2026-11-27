# Home WISP reconcile: on-site test (#340)

The Home WISP routers page (Admin → Network → Home WISP routers) shows each registered router and whether sharing applies. It has a **Reconcile now** button.

The reconcile pass behind it:
- re-checks each registered router's entitlement;
- removes stale sharing exceptions.

The owner chose on 26 Nov to build it as router work: off until Home WISP is turned on, and checked here on-site before production. There are no mock-router tests ([#340 decision](https://github.com/ImaJin14/Ndahi-Connect/issues/340#issuecomment-7202632406)).

## What the pass does

It runs every 5 minutes, within a minute after a Home change fails, and on Reconcile now. It only runs while `NDAHI_HOME_ENABLED=true`.

1. **Reads the router's Home users.** It lists `ip/hotspot/user` and keeps the users whose comment is `ndahi:home:<voucher>:<generation>`. This is a read only.
2. **Stale exception.** A Home user is stale when its subscription has ended or been revoked, or it belongs to an older router generation, for example after a router replacement. The pass queues a **revoke** for that customer through the Home worker, the same operation as Admin's Revoke.
3. **Withheld.** A subscription that is active but whose last Home change failed is **retried** through the Home worker. Sharing stays withheld until the retry succeeds.
4. **Record.** Each run is recorded (`reconcile.completed`). The page shows when it last ran, the counts and the recent changes.

The pass never authorises anything by itself. A MAC or vendor prefix alone never allows sharing. If the router can't be read, the pass still retries failed changes from the server's records and reports "router not read".

## Before you start

- Use a test HotSpot (not production) with Home WISP turned on: `NDAHI_HOME_ENABLED=true`, router saved in Network setup.
- Have two supported WISP routers (A and B) and a phone for the customer's sign-in.
- Have a test customer with a Home WISP Unlimited subscription.

## Steps

1. **Registered and sharing.** Register router A for the customer (portal → Home router).
   - Admin → Home WISP routers shows the customer, "Ends [date]", the MAC as `••:••:••:XX:XX:XX`, **Online**, and **Sharing** with "Entitlement checked … ago".
   - Connect a second device behind router A; it gets online.
2. **Reconcile now.** Press Reconcile now.
   - The bar turns green: "Reconciled just now: N subscriptions and routers checked, 0 stale sessions or exceptions removed."
   - Recent changes gains a "Reconciled" line.
3. **Offline.** Power router A off and wait 2 minutes.
   - The row shows **Offline** and **Sharing (idle)**: "Applies when the router reconnects".
   - Power it back on; it returns to Online and Sharing.
4. **Withheld.** Stop the Home worker reaching the router (unplug the management link) and make a Home change, such as a renewal.
   - The row shows **Withheld**: "Couldn't verify — retrying".
   - Restore the link. Within about a minute the pass retries; the row returns to Sharing.
5. **Stale exception after expiry.** Shorten the test subscription so it ends, then wait for the cutoff.
   - The row shows **Disconnected** and **Removed** ("Expired HH:MM").
   - On the router, the customer's `nh_…` HotSpot user is gone.
6. **Stale exception the server didn't remove.** On the router, restore a backup that still holds the expired customer's `nh_…` user. Press Reconcile now.
   - The bar says 1 stale exception removed, and "stale exceptions found" shows 1.
   - After the revoke runs, the user is gone from the router.
7. **Replacement.** Replace router A with router B (portal → Home router → replace).
   - Recent changes shows "replaced router ••:…A → ••:…B".
   - Router A's old user is removed by the replacement, or by the next pass if it remains.
8. **Revoke.** Press Revoke on the row, enter a reason and confirm.
   - The router is disconnected and sharing is removed.
   - The audit log has the reason.
   - The customer's other records stay.
9. **Home off.** With `NDAHI_HOME_ENABLED` unset, Reconcile now says "Home WISP is off, so there's nothing to reconcile yet." No router call is made.

## Record

Write the results on #340, including:
- the RouterOS version;
- each step's outcome;
- the times for steps 4 and 6.

Until then, the checklist entry keeps "reconcile checked on the test HotSpot" under "Not yet".
