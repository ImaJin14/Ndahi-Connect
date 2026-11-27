# Replace a device: on-site check (#350)

Replace a device lets a phone refused because every Personal Unlimited slot is
full take another device's slot. It uses the router work already used to remove
a device (`revoke_wifi_device`, #334): the old device's session, saved sign-in
and binding are removed, the slot frees only when the router confirms, and then
the new phone connects with the owner's PIN as proof. These checks need the test
HotSpot and real devices; mock routers don't count (owner).

## Before you start

- A test account with a Personal Unlimited bundle of **2 device slots**, its
  catalogue switch on for the test only.
- Three devices: A and B already holding the two slots, C new.
- The test HotSpot reachable from Admin → Network.

## Checks

1. **Full slots, one device offline.** Turn B's Wi-Fi off. On C, join NDAHI
   Wi-Fi and sign in: the connection is refused ("All 2 device slots are in
   use…") with **Replace a device**. Open it: A shows "online now", B "offline …".
   Pick B, enter the PIN, Replace B. Expect: the steps run, the router removes B
   (its session and the saved login are gone in Winbox), then C connects. B can't
   reconnect without fresh approval. The bundle's end date is unchanged.
2. **Old device still online.** Repeat with B online and in use. Expect B to be
   disconnected first (its traffic stops), and C to connect only after that.
3. **Router unreachable mid-replace.** Start a replacement, then block the API's
   access to the router (or stop its service) before it confirms. Expect
   "Replacement paused … Nothing changed": B still holds the slot and C isn't
   connected. Restore the router and tap Try again: B is removed and C connects.
   Repeating Try again never creates a second removal while one is still waiting.
4. **Wrong PIN.** A wrong PIN changes nothing and says so; the PIN back-off applies.

Record each result (device, time, what Winbox showed) on #350 before the
Unlimited catalogue goes on sale.
