# Trusted connection evidence — #133

`GET /api/account/connectivity` is a no-store public/optional-session view. It
reports request-path ingress, account state, subscription state, exact session-bound
HotSpot authorization, router-management observations and a conservative next action.
The customer cookie remains scoped to `/api/account`; no session scope is widened.
Anonymous responses contain no phone, voucher, customer ID, quota or device details.
No browser-supplied MAC, query parameter, online flag, plan or successful API request
can establish HotSpot authorization. Purchase eligibility still uses its independent
coverage guard and the transactional active-subscription rule from #132.

The frontend treats API reachability as hosted-service reachability. It no longer
calls this a local gateway ping, infers mobile data from an unsuccessful coverage
check, or identifies a Starlink model/link from a customer's paid bundle.
Fresh ingress identifies the request path, not an SSID or a physical device. A VPN
or mixed mobile/Wi-Fi route may leave network presence unconfirmed; account access,
balances, history and recovery remain available.

Authenticated HotSpot devices can perform one bounded independent browser-path
check against `https://www.cloudflare.com/cdn-cgi/trace`, without cookies, referrer
or account/device data. Only a nonredirected, readable plain-text response with the
expected host/trace structure counts. Opaque responses, HTML captive pages, errors
and timeouts never count as success. A positive result proves this browser reached
that external endpoint, not that all traffic uses Wi-Fi or all internet destinations
work. A negative result means the check could not be completed; it does not diagnose
Starlink, AP or router failure. Public API/walled-garden reachability alone cannot
pass this check. No router whitelist is added. Customer CSP permits only the fixed
Cloudflare origin; administrator CSP is unchanged.

Reference: [Cloudflare-managed diagnostic endpoint](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/).

Evidence expires: request observations after 45 seconds, router/session observations
under their existing freshness/identity limits. Banner reads are bounded/coalesced,
pause while hidden/offline and ignore invalidated responses. Unknown or unavailable
evidence never causes an automatic checkout/login redirect. Explicit links lead to
sign-in, eligible bundles, Dashboard or help. #134 builds the automatic device
indicators on these separated observations; #135 applies safe entry destinations.

## Site configuration inspection

Before implementation, reviewed the recorded **actual** installation observations:
RB5009UPr+S+IN; EAP650-Outdoor in standalone mode; guest VLAN 20/10.20.0.0/22;
WireGuard 10.77.0.2/router→10.77.0.1/cloud; direct Starlink ordinary internet plus
specific portal/API VPN routes and fallback blackholes. Source: selective-egress
section 8A of `render-hotspot-coverage-setup.md`, current peer CONTEXT, and the
21 October read-only captive inspection. That inspection recorded RouterOS 7.24.5,
server ndahi-hotspot/profile ndahi-profile/effective HTML directory hotspot. These are
historical observations, not fresh runtime assertions. No Starlink model is inferred,
no Omada controller is assumed, and no policy/file/credential/router change is made.

Fresh 24 October inspection from both PCs found only the home Wi-Fi path. Peer
192.168.1.46 has no Ethernet address; route to 192.168.88.1 goes via 192.168.1.1/wlo1.
Router ports 22/80/443/8291/8443 are unreachable. Thus a current on-router config dump,
physical pre-auth test, mobile-data-off browsing, AP/router restart and selective
routing verification cannot be attested from this environment. Preserve the routing
and confirm these on site before release acceptance; synthetic tests do not replace
those checks. No broad scanner, private browser session or credentials were used.

Read-only on-site checklist: inspect system resource, active HotSpot server/profile,
VLAN/DHCP address, current routes and mangle/filter ordering. Verify no broad cloud
default or fallback bypass was introduced. Compare API-specific routes with current
DNS, rather than using a general IP-check site's Starlink address as coverage proof.
Never disable HotSpot or blanket-whitelist connectivity hosts to make a test pass.

## Validation and release

Dedicated API/browser matrices cover anonymous unpaid presence, exact authorized
sessions, stale/router failure, mobile-data/VPN ambiguity, expired/exhausted/absent
bundles, session expiry, privacy and independent internet responses. Browser tests
use the real API/static CSP and a synthetic isolated router; external probe replies
are explicitly intercepted. Run standard backend, security, coverage/current-device,
provider and browser CI as well. Implementation/PR status is separate from merge,
deployment and physical acceptance. No new merge/deploy authorization is inferred.
