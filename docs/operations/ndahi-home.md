# NDAHI Home: setup, operation and pilot

Status: merged and deployed with Home disabled. Production verification on
5 November 2026 confirmed merged SHA `011b75d`, healthy PostgreSQL, disabled
`/api/home/config`, matching frontend artifacts and passing smoke checks. See
[release evidence](../releases/ndahi-home-2026-11-05.md).
Native Home authorization/usage tests still use synthetic RouterOS boundaries.
Read-only ether2 observation now shows 1 Gbps/full duplex, zero observed errors
and no new link-down count during the check; the original physical fault's cause
is not established, and load/long-term pilot verification remains pending.

## Product and compatibility

Requested topology: Starlink Mini → RB5009 → Ethernet/VLAN 20 → EAP650-Outdoor
→ Wi-Fi → household WISP NAT router → private household devices. The cloud API,
database, customer portal and admin app stay on Render; no on-site server or
custom TP-Link management API is introduced.

One account-owned entitlement uses either direct devices or one upstream Home
connection. Household devices share upload plus download; **1 GB = 1,000,000,000
bytes**, as in the existing catalogue. There is no downstream device-count limit
or configured Home speed cap. Available bandwidth depends on signal, congestion,
upstream capacity and equipment. Existing calendar validity starts at verified
payment settlement, including time spent waiting for router recovery. Remaining
validity is never extended by reconnecting or replacing a router.

Home supports a vendor-neutral capability contract: wireless upstream, IPv4 NAT,
a private LAN and stable upstream identity. Integrated private Wi-Fi, Ethernet
clients and an external LAN access point are supported topologies; no model/OUI
allow-list or vendor API is used. Match the available Wi-Fi band/security, and keep
the LAN subnet separate from upstream/management. Bridge or repeater modes without
NAT do not meet the Home contract. A changed WAN MAC requires verified replacement.

Physical reports record exact model/revision/firmware and topology; they do not
turn a product family into a compatibility guarantee. The earlier TL-WR902AC V3
candidate is an example, not a required device or validated model. The available
DAP-1360 C1 firmware 3.00 remains limited to isolated evaluation because of its
end-of-support security status and observed single-SSID controls; see
[its evaluation notes](dap1360-c1-isolated-evaluation.md). A separate LAN AP can
provide private Wi-Fi for a routed CPE with only wired downstream access. The
application does not certify a device's firmware security or infer NAT from its
name. See the [readiness/migration and pilot workflow](ndahi-home-readiness.md).

## Customer setup

1. In the WISP router's own interface, select Share Hotspot / WISP NAT, choose
   NDAHI Connect as upstream, and configure a separate private LAN. Use integrated
   Wi-Fi, wired clients or a private AP on its LAN; set Wi-Fi credentials in that
   device. Keep its subnet distinct from upstream and management. Use the
   vendor's instructions.
2. Connect the device through that private LAN. Open the normal HTTPS customer
   portal and choose Home router. Existing customers sign in; a new Home account
   may register with a Cameroon account number and PIN. Registration does not
   verify SIM ownership and cannot overwrite an existing account.
3. Choose Link / replace Home router, then Continue to local gateway sign-in.
   The temporary credentials are restricted to a two-minute enrollment. Confirm
   the household connection after returning to the portal. Never type the label
   MAC; the upstream wireless identity may differ.
4. Assign an eligible existing bundle with current PIN/passkey verification, or
   buy a bundle through the normal Mobile Money process. An active bundle with
   data blocks another purchase. An exhausted bundle may renew before expiry.
5. Wait for **Router authorization confirmed**. A payment redirect is not proof
   of payment; the server checks the provider. If payment is confirmed during a
   router outage, retain the pending entitlement and retry; do not pay again.
6. Renew from the restricted portal or mobile data once linked. Renewal reuses
   the verified link. Initial linking and replacement always require local proof.

The portal does not edit the WISP router's private Wi-Fi credentials. Replacement
requires a new local challenge and fresh owner proof. Old sessions and cookies
are revoked and final usage saved before the replacement receives access.

## Configuration and migration

- API: `NDAHI_HOME_ENABLED=false` by default. Enable only after the complete pilot
  below, with the same tested router configuration and firmware. Public
  `/api/home/config` exposes the boolean only.
- `NDAHI_HOME_DRAIN_ENABLED=true` runs revocation/accounting work while enrollment
  is disabled. It does not authorize Home access while the main flag is false.
- Existing saved live router connection must be enabled. `NETWORK_CONFIG_KEY`
  protects its encrypted secret and derives private scoped credentials;
  `NETWORK_ALLOWED_ORIGINS` restricts HTTPS management through WireGuard.
  Legacy bridge/mock adapters are not a Home deployment path. Do not rotate this
  key without the existing secret migration procedure and a household recheck.
- Local ingress guard: `COVERAGE_ACCESS_ENABLED=true`, `TRUST_PROXY=render`, and
  `COVERAGE_ALLOWED_IPS` contain the verified site exit address. Preserve the
  existing trusted-proxy/network path. Public IP proves site ingress only;
  identity comes from a challenge-specific MikroTik session and unique host.
- Customer `HOTSPOT_LOGIN_URL` must exactly match the certified HotSpot HTTPS
  `/login` URL returned by the router, including the DNS name. Use the normal
  public customer/API/admin URLs and CORS configuration. Never use invented
  `.local` portal/provider URLs or accept an invalid certificate.
- Correct router clock/NTP is essential to absolute challenge and calendar expiry.
  RB5009 RouterOS 7 REST, scripting, HotSpot, scheduler and scoped management
  permissions must be tested on the actual version. Inspect script errors first.
- Apply the existing migration workflow with migration `008_ndahi_home.sql`.
  The standard production readiness check proves readable tables and migration
  004 ordinals. The new Home readiness command/protected endpoint verifies index
  expressions, predicates and usability; enabled-Home predeploy also checks them.
  Verify all three migration
  008 indexes in the target database before any Home pilot/enablement. Four
  collections map to existing normalized payload tables: `homeConnections`
  → events/home_connection, `homeChallenges` → challenges/home_enrollment,
  `homeOperations` → events/home_operation, `homeUsageObservations` →
  events/home_usage. Migration 008 adds unique active-MAC/customer indexes and
  a due-operation index; it does **not** create four new tables.
- Back up the database and configuration using existing procedures. Rehearse
  migration/restore in an isolated database. Retain Home records on rollback;
  rolling code back must not erase usage or paid entitlements.

## MikroTik preparation

Use [ndahi-home-network.rsc](ndahi-home-network.rsc) as a review template. It is
intentionally blocked from whole-file import. Do not reset the RB5009/EAP650 or
change unrelated users. Prepare a saved export and recovery through ether8.

The API validates a certified existing `ndahi-hotspot` HTTPS server, the first two
active IPv4 forward rules and exact Home chains, an owned nonempty required
address list, guest exclusion from FastTrack in both directions, and an
unconditional first IPv6 forward drop from the actual guest interface (or an
already globally disabled IPv6 stack). Narrowing a guard with extra matchers is
rejected. The API does not install topology or bypass entries.

Enrollment and Home live sessions use restricted source address lists. Owned
volatile live permits expire after three seconds and are refreshed locally once
a second only for the current in-memory accounting epoch. General packets then
return to the existing HotSpot rules, rather than receiving unrestricted accept.
Native `limit-bytes-total` and one upstream session enforce finite Home quota;
a one-second local calendar guard removes expired sessions/cookies independently
of the cloud. [MikroTik documents these HotSpot limits and IPv4-only accounting](https://help.mikrotik.com/docs/spaces/ROS/pages/56459266/HotSpot+-+Captive+portal).

The required address list accepts only individually reviewed, owned IPv4 host
addresses (optionally /32); subnet-wide, unmanaged and DNS-name entries fail
verification. Keep the reviewed address inventory current as provider/CDN DNS
changes. HotSpot trial login is rejected. Required destination rules do not replace the existing unauthenticated HotSpot
walled garden. Review both layers for portal, API, login, DNS, static assets,
certificate needs, provider checkout and status paths. Enumerate exact production
hosts and their resolved addresses with the payment provider; shared CDN IPs can
allow unrelated services. Never permit all internet or full RFC1918 ranges to
make checkout work. Input-chain DNS/login access and existing management isolation
remain under the current network policy. Verify HTTPS paths with packet captures.

Home profiles use an empty rate limit, shared-users=1, and a MAC-bound private
user password. Conflicting reserved profiles and exact-IP simple queue caps are
rejected for review, rather than rewriting unrelated caps. Audit queue trees,
parent/simple queues, bridge/offload paths and all alternate egress during the
pilot; static inspection is not a proof that the complete network has no cap or
bypass. FastTrack can bypass HotSpot and queues; see MikroTik's
[packet-flow documentation](https://help.mikrotik.com/docs/spaces/ROS/pages/328227/Packet+Flow+in+RouterOS).

## Recovery and accounting limits

A durable operation queue keeps payment, entitlement creation and native access
separate. Customer operations have a lease, serial account processing, bounded
backoff and an explicit support-review state. Usage high-water observations and
refresh jobs are reused; accounting is monotonic and generation-bound. Direct
credentials are disabled before Home activation. Return to direct uses an offset
for all previously consumed Home bytes and a reduced native direct quota. A
subsequent Home assignment uses a fresh native meter with the spent data as base.
Converted direct profiles also retain the volatile reboot guard; ordinary direct
customers retain their existing policy.

A WISP power cycle/signal loss normally reconnects through the one-day MAC cookie
or the worker while the same RB5009 epoch and counters remain valid. A missing
cookie may need the owner to open the portal and retry. This must be measured on
the pilot model. A MikroTik reboot clears the volatile permit/epoch. Regressed,
missing or inconsistent counters fail closed in `HOME_ACCOUNTING_REVIEW`; neither
retry nor replacement reconstructs lost usage or resets quota. The current
implementation does not provide automatic recovery from lost native counters.
Support must reconcile independent evidence before restoring service. Do not
waive the active-with-data purchase rule, credit fresh data, or extend expiry as
a recovery shortcut. This availability limitation must be accepted in pilot.

Owner/operator admin users can view masked identifiers and retry/revoke with an
audit reason. Replacement is assisted through the customer's local possession
flow; staff cannot assign an arbitrary MAC. Revocation remains pending until the
router confirms. Keep full identifiers, enrollment passwords, PINs, provider
secrets and router credentials out of logs and issue evidence.

MAC binding and a local login prove control of an observed connection at that
moment, not tamper-resistant hardware identity. A malicious party able to clone
the upstream MAC and authentication context may impersonate it. This release
does not promise resistance to MAC cloning or prove a device is physically a
router. AP isolation, WPA policy and management isolation remain necessary.

## Rollback

1. Disable new setup/purchases with `NDAHI_HOME_ENABLED=false`, and set
   `NDAHI_HOME_DRAIN_ENABLED=true`. Restart the API normally. Do not remove the
   forwarding guards while any Home/converted-direct access remains enabled.
2. Request audited Home revocations, allow the worker to disable native users,
   clear their sessions/cookies/live permits, and capture final counters. For
   converted-direct users, disable the exact `ndahi:voucher:<id>` users and clear
   their exact sessions/cookies too. Confirm zero active affected sessions at
   the router; a UI response alone is insufficient. Preserve final evidence.
3. Retain database state, native counters and scoped resources until reconciled.
   If cloud access is unavailable, an operator may disable only individually
   identified Home/enrollment/converted-direct users and remove their sessions
   locally; record this for reconciliation. Do not use broad delete patterns.
4. Only after confirmation, remove the exact Home filter/profile/scheduler/script
   resources recorded in the pre-change inventory. Preserve unrelated firewall,
   FastTrack, IPv6, HotSpot, AP, WireGuard and queue policies. Do not globally
   re-enable IPv6 or reset counters. Restore reviewed prior network rules only.
5. Deploy previous code only after draining. Disable the drain flag when complete.
   If revocation/counter verification fails, keep guards and maintenance state;
   do not claim rollback completed or silently change modes.

## Physical pilot and KPI evidence (all pending)

Use the actual RB5009/AP topology and any WISP/NAT CPE meeting the capability
contract. Record its exact model/revision/firmware, NTP, topology,
reviewed configuration hash, start/end timestamps and anonymized entitlement
references. Repair the physical ether2 path first. Measure with an independent
capture/counter on a controlled test endpoint plus native and database readings.
Do not use mock tests as hardware evidence.

| Check | Proposed acceptance and measurement |
| --- | --- |
| Setup | New account → local proof → confirmed payment → access; existing bundle assignment; EN/FR at 320px; Note 8/iPad Air 2 acceptance on real devices. |
| Identity | Replay, expired challenge, changed identifiers, cross-account and concurrent claims: zero unauthorized links. Replacement revokes old user/session/cookies before new access. |
| Mode | Exactly one active Home/direct mode and one linked upstream; alternating modes/replacement retain consumed bytes and the original expiry. Inspect real active users and traffic. |
| Shared usage | Two or more private devices upload and download controlled files simultaneously; their total consumes one decimal-GB allowance, no downstream count gate or per-household rate policy. |
| Quota | At least 100 finite-quota exhaustion trials, mixed directions/concurrent flows. Proposed overshoot ≤1 MiB (1,048,576 bytes) per entitlement beyond remaining quota at the native meter boundary. Compare independent captures and native counters, quantify layer/packet differences; report maximum and p95. This tolerance is not guaranteed by RouterOS documentation. |
| Cut-off | After confirmed native exhaustion/expiry, zero successful **new** general-internet TCP/UDP/IPv6 connections; test multiple ports, VPN and established-flow cessation separately. Portal, required assets, provider/status paths and offsite renewal still work. |
| Timing | ≥100 healthy confirmed payments/renewals: proposed p95 ≤30s to gateway-confirmed access. Record server confirmation and observed gateway timestamps, separate outages. No measurements yet. |
| Reconciliation | Proposed healthy last-usage freshness ≤60s for 100 active households; compare native and durable readings at the same boundary. Separate network, sampling and counter-layer differences; zero regression/double counting. Current worker processes batches of 25 with serialized account operations, so load acceptance is required. |
| Failure | WISP restart, signal loss, RB5009 restart/counter reset, backend outage while consuming quota, router outage at payment, duplicate/out-of-order and failed/cancelled/delayed payments; zero extra entitlement, reset or general-internet bypass. Confirm support-review behavior after lost epoch. |
| Reconnection | Prove cookie/worker reconnect without paying/relinking, then test missing cookie and documented manual recovery. No allowance or expiry increase. |
| Rollback | Rehearse the drain above with direct customers unaffected; preserve paid state, counters and audit trail. |

Keep #170/#175/#178 and the remaining #171/#177 acceptance gates open; attach
measured results, including failed trials. Software issues #172/#173/#174/#176
are closed without claiming physical acceptance. If quota, no-bypass, timing, safe recovery or required-path targets
fail, keep Home disabled and revise the implementation before another pilot.

## Readiness implementation follow-up

The current readiness work adds catalog-based migration 008 validation, an
additive-only migration command, isolated native dump/restore rehearsal, GET-only
gateway diagnostics, vendor-neutral customer setup, operational queue/usage/cutoff
metrics and audited operator-reported pilot summaries. These software checks do
not replace physical enforcement measurements. See `ndahi-home-readiness.md` for
commands, access controls, report fields and unresolved acceptance limits.
