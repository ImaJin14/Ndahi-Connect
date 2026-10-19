# Wi-Fi device names and main-device controls

Names are the client's DHCP hostname, matched to its live HotSpot MAC and IP.
They are untrusted display text, never an authorization credential. Unknown names
remain unnamed with a MAC suffix. Customer lists show only their bundle's devices;
admin records support searching announced names. DHCP naming is optional and has
a short read timeout so a permission failure cannot prevent usage accounting.

The account owner selects a currently reported device and confirms that they are
using it. PIN or passkey verification, plus enrolled authenticator verification,
registers this browser as the main controller. The cloud cannot identify a phone
from the shared public IP; the selection is explicit, not an inferred match.
A separate HttpOnly cookie identifies the controlling browser. Only its hash is
stored and it is never returned in customer or admin records.

There is one main-device designation per customer, independent of vouchers. It
does not reserve an extra device slot. Replacing it revokes the previous control
cookie. PIN reset/recovery also invalidates control, while retaining the physical
designation until the verified owner chooses a replacement. The normal account
recovery flow works without SMS. Clearing browser cookies requires selection and
owner verification again. Router configuration revisions require reselection.

Disconnecting a main device requires fresh owner proof. Existing customer and
legacy disconnect endpoints cannot bypass this rule. Authorized administrators
retain their existing ability to remove any Wi-Fi session. Disconnect means end
the current session and remove its remembered router login; it is not permanent
revocation of the customer's voucher or their portal login.

## Deployment and verification

Deploy the API, customer and admin services. If using the external management
bridge instead of the saved-router adapter, update its code too so it returns
announced names. No router configuration writes are needed for names. The router
service account needs read access to DHCP leases for names to appear.

Verify a named phone, an unnamed phone, duplicate names and an owner-verified
main-device change. Confirm old control cookies stop working after transfer or
PIN recovery. Test with a full bundle and an offline router: an unconfirmed
disconnect must never free a slot. Check the Note 8 and iPad Air 2 on hardware.
