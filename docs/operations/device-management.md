# Wi-Fi device names and main-device controls

Names are the client's DHCP hostname, matched to its live HotSpot MAC and IP.
They are untrusted display text, never an authorization credential. Unknown names
remain unnamed with a MAC suffix. Customer lists show only their bundle's devices;
admin records support searching announced names. DHCP naming is optional and has
a short read timeout so a permission failure cannot prevent usage accounting.

The account owner selects a currently reported device and confirms that they are
using it. Fresh PIN or passkey verification registers this browser as the main
controller. An enrolled authenticator code is optional for selection or replacement;
if supplied, it must be valid. The cloud cannot identify a phone
from the shared public IP; the selection is explicit, not an inferred match.
A separate HttpOnly cookie identifies the controlling browser. Only its hash is
stored and it is never returned in customer or admin records.

There is one main-device designation per customer, independent of vouchers. It
does not reserve an extra device slot. Replacing it revokes the previous control
cookie. PIN reset/recovery also invalidates control, while retaining the physical
designation until the verified owner chooses a replacement. The normal account
recovery flow works without SMS. Clearing browser cookies requires selection and
owner verification again. Router configuration revisions require reselection.

Disconnecting a main device requires fresh owner proof and, when enrolled, an
authenticator code. Existing customer and
legacy disconnect endpoints cannot bypass this rule. Authorized administrators
retain their existing ability to remove any Wi-Fi session. Disconnect ends the current session and removes its remembered router login. Under
the approval policy it also revokes device approval and unused codes; the device
can reconnect after fresh approval. It does not revoke the customer's voucher or
portal login.

The first confirmed owner connection prompts **Is this your main device?** Yes
opens PIN/passkey verification with that device selected; No leaves it connected
without selecting a main browser. Further devices can request access but need a
main browser before receiving an approval code. See
[main-issued approval codes](assisted-wifi-pairing.md).

## Deployment and verification

Deploy the API, customer and admin services. If using the external management
bridge instead of the saved-router adapter, update its code too so it returns
announced names. No router configuration writes are needed for names. The router
service account needs read access to DHCP leases for names to appear.

Verify a named phone, an unnamed phone, duplicate names and an owner-verified
main-device change. Confirm old control cookies stop working after transfer or
PIN recovery. Test with a full bundle and an offline router: an unconfirmed
disconnect must never free a slot. Check the Note 8 and iPad Air 2 on hardware.
