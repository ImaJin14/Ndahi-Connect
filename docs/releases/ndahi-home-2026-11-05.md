# NDAHI Home release verification — 5 November 2026

## Scope and current state

The user authorized review, merge/deploy with Home disabled, ether2 verification
and preparation of a controlled WISP pilot. Antigravity had already merged
[PR #179](https://github.com/ImaJin14/Ndahi-Connect/pull/179) and deployment completed
before this verification. No duplicate merge or redeployment was necessary.

- Reviewed feature head: `514fb2f72bcbe2d1271f3e48c65d5e7fe7ebc5f3`.
- Merged/deployed main: `011b75d46c8ec27d96c3d637e64862d3af878ac7`.
- The merged source tree matches the reviewed feature head exactly.
- [Main CI 41910601575](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41910601575)
  succeeded. Feature CI evidence remains in PR #179.

## Production deployment records

All three GitHub/Render deployment records identify the exact merged SHA and
successful completion:

| Service | Render deploy | GitHub deployment |
| --- | --- | --- |
| API | [dep-dblppgpsrm7s7384i5k0](https://dashboard.render.com/web/srv-da2u950u01pc7387rlq0/deploys/dep-dblppgpsrm7s7384i5k0) | 7557729967 |
| Customer | [dep-dblppgpsrm7s7384i5c0](https://dashboard.render.com/web/srv-da2u8g0u01pc7387q7s0/deploys/dep-dblppgpsrm7s7384i5c0) | 7557729940 |
| Admin | [dep-dblppgpsrm7s7384i700](https://dashboard.render.com/web/srv-da2u8g0u01pc7387q7sg/deploys/dep-dblppgpsrm7s7384i700) | 7557729996 |

Automatic deployment smoke runs
[41912090873](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41912090873),
[41912147401](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41912147401) and
[41912160123](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41912160123)
passed. Fresh strict, read-only production smoke verification also passed all
six groups on 5 November: API/PostgreSQL readiness, authentication policy,
catalogue/provider, both frontend login/config/cache checks, service separation,
authentication gates and CORS.

Live `/api/authentication-policy` reports the exact merged API revision.
`/api/home/config` returns `{"enabled":false}`. Customer revision is
`f293e94fc5962b18477d`; admin revision is `114c89317e5312769b81`.
Against a clean checkout of the deployed commit, all 16 selected customer/admin
HTML/JS/CSS artifacts matched their expected SHA-256 hashes (9 customer, 7 admin).
The canonical dashboard routes were used for the index shell; direct index URLs
correctly redirect to public entry pages. No credentials or private account data
were needed for these checks.

Local machine-readable evidence: `/tmp/ndahi-home-live-artifact-verification.json`,
`/tmp/ndahi-home-production-smoke-current.log`. No test login, charge or customer
router authorization was performed against production. Migration 008 index
presence was not independently verified: the standard readiness check proves
readable tables and migration 004 ordinals only. Check the three Home indexes in
the target database before any pilot/enablement; this verification made no
production database schema writes.

## ether2 observation

Read-only WinBox observations on the connected RB5009, RouterOS 7.24.5, showed:

- 1 Gbps, full duplex, auto-negotiation complete, link OK and traffic passing.
- Historical Link Downs counter **489**, unchanged across approximately
  05:46–05:53 Africa/Douala on 5 November. This is not a zero-flap lifetime count.
- Last link-up reported around 17:33 on 4 November. Displayed timestamps shifted
  by seconds during observation; the link-down count did not increase.
- Receive FCS/length/fragment/overflow/jabber/error-event counters were zero in
  both observed receive samples. Transmit FCS/collision/deferred counters were
  zero in the observed transmit sample.

Screenshots were retained locally as `/tmp/ndahi-ether2-status-start.png`,
`/tmp/ndahi-ether2-rx-start.png`, `/tmp/ndahi-ether2-tx-observation.png` and
`/tmp/ndahi-ether2-status-final.png`. Interpret samples by the visible tab/fields,
not merely by the filename. No counters were reset and no interface, VLAN, PoE,
rate, firewall or router configuration was changed.

Current link health is improved relative to the earlier flapping reports. This
short observation does not identify which physical component was repaired or
prove long-term/load stability. Continue observation during the hardware pilot.

## Antigravity terminology draft

A separate uncommitted branch, `feat/wisp-runtime-terminology-001`, changes default
zone terminology, reports the stored zone ID, allows audited administrator ID
updates, and updates fixture/document wording. It is not part of deployed main.
The review accepts its purpose and corrects two problems before review submission:
invalid IDs now fail without changing state; checklist labels no longer describe
software tests as physical verification or an unmerged branch as deployed.
Saved legacy IDs remain untouched until an explicit administrator change.

Independent local validation: 38 focused tests passed; full suite 1,121 tests,
1,092 passed, zero failed, 29 PostgreSQL-dependent skips; syntax and diff checks
passed. The draft remains separate from this verified Home deployment. It does
not add multi-site isolation or change AP coverage/SSIDs.

## Pilot and enablement

The user supplied a D-Link DAP-1360 C1 (MAC ending `88:39`). Offline read-only
inspection at `http://192.168.0.50/` confirmed running firmware `3.00 , 09, Nov, 2011`,
current `Access Point` + DHCP-bridged LAN state (`mode0=0`, `lan_type=1`), and the
presence of `WISP Client Router` (`mode0=5`) and `WISP Repeater` (`mode0=6`) on
`/wireless.htm`. However, `/wireless.htm` exposes only a single `#ssid0` and
`#authType` (used for the root AP in WISP modes). The UI provides no independent
private SSID/security controls for an open upstream hotspot. This finding does
not verify runtime NAT or wireless isolation. A separate downstream AP or another
CPE with independent WAN/LAN wireless settings is needed for further evaluation. See
[isolated evaluation notes](../operations/dap1360-c1-isolated-evaluation.md).
No WISP household pilot, native quota/expiry cutoff, independent overshoot,
reconnection, replacement, required payment paths or outage recovery has been
physically accepted. Home remains disabled. Issues #170–#178 stay open for these
criteria; proposed KPIs are not measured results.
