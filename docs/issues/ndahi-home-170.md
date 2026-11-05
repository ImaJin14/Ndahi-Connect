# NDAHI Home delivery and review evidence

Parent [#170](https://github.com/ImaJin14/Ndahi-Connect/issues/170) and all children
were opened before implementation. Dependency order: #171 → #172 → #173/#175 →
#174/#176/#177 → #178. Software scope #172, #173, #174 and #176 is closed;
#170, #171, #175, #177 and #178 retain the remaining database, operational and
physical acceptance gates. Closing software scope does not certify hardware.

| Issue | Implemented | Remaining acceptance |
| --- | --- | --- |
| [#171](https://github.com/ImaJin14/Ndahi-Connect/issues/171) | Four normalized payload collections; additive migration 008 with uniqueness/due indexes; JSON defaults and state migration. | Target production index check and production encrypted-backup recovery acceptance. Local PostgreSQL replay/rollback, exact index definitions and native synthetic dump/restore now pass; migration does not create four tables. |
| [#172](https://github.com/ImaJin14/Ndahi-Connect/issues/172) | Session-bound two-minute, single-use local HotSpot proof; trusted host/MAC; atomic competing claims; replacement owner proof and revocation barrier. | Actual local HTTPS/captive portal, negative hardware cases and residual MAC-cloning risk acceptance. |
| [#173](https://github.com/ImaJin14/Ndahi-Connect/issues/173) | Exclusive assignment, direct credential/grant revocation, final counter reconciliation, usage offset returning to direct, fresh native Home meter on reassignment. | Active-session and packet-capture proof across repeated transitions. |
| [#174](https://github.com/ImaJin14/Ndahi-Connect/issues/174) | Existing server-verified payments; frozen Home target; one entitlement per payment; pending router activation; exhausted-before-expiry/offsite renewal; active-with-data blocker. | Real provider acceptance, healthy latency measurements. A changed/removed link requires verified reassignment, never arbitrary browser identifiers. |
| [#175](https://github.com/ImaJin14/Ndahi-Connect/issues/175) | Private MAC-bound native user; aggregate remaining quota; local calendar/volatile guards; strict IPv6/FastTrack/firewall preparation; monotonic fail-closed counters and reboot handling. | Native RouterOS transport/scripts/counter semantics and all quota/traffic/reconnect/outage trials. No automatic lost-counter recovery. |
| [#176](https://github.com/ImaJin14/Ndahi-Connect/issues/176) | Explicit Home flow, EN/FR, new account/link/assign/buy/renew, shared usage/freshness, pending/retry, masked identity; direct counters/controls hidden for Home. | Real old-device and assistive-technology acceptance. No WISP management API. |
| [#177](https://github.com/ImaJin14/Ndahi-Connect/issues/177) | Owner/operator masked view, safe retry/revoke with audit reason, customer-assisted verified replacement; bounded durable worker retries. | Support pilot and real throughput/freshness/lost-counter rehearsal. Read-only readiness, queue/freshness/activation diagnostics, confirmed cutoff observations and a bounded synthetic 100-household worker test are implemented. |
| [#178](https://github.com/ImaJin14/Ndahi-Connect/issues/178) | Security/domain/API/gateway and browser checks; reviewed network template; setup/rollback/pilot/KPI runbook. | Independent physical/provider evidence and rollout decision. Structured, audited pilot reports distinguish synthetic/incomplete/operator-reported results and never enable Home automatically. |

## Review of Antigravity additions

Accepted the newer customer UI and package-script wiring after independent local
browser validation. Replaced the checklist/issue/runbook/network-template claims
that confused existing payload tables with new tables, overstated PostgreSQL
verification, named unverified WISP models, used invented local service URLs, or
proposed globally disabling IPv6. The corrected template cannot be imported as a
whole and places scoped Home jumps first. Unrelated main-checkout drafts remain
untouched. The review also found and corrected mode-switch accounting gaps and
narrowed firewall matcher acceptance before continuing delivery.

## Local evidence

- `npm run check`: passed, including new server/browser module syntax.
- Hosted full-suite validation: 1,120 tests passed, zero failures or skips,
  including PostgreSQL, plus both 300-customer load tests and all seven checks on
  [run 41903679541](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41903679541).
  Latest Home security/domain/API suite: 38 passed locally. Current head CI:
  [PR #179](https://github.com/ImaJin14/Ndahi-Connect/pull/179).
- `npm run check:home:browser`: 20 checks passed at 320px/1280px with real browser,
  local API and **synthetic** gateway/mock payments. Linking, assignment, shared
  balance, French, main dashboard, exhausted offsite renewal, paid router outage,
  recovery, masked admin view and PIN-less owner revocation through a virtual
  authenticator with server-verified WebAuthn. Screenshots inspected locally.
- Added PostgreSQL tests for concurrent claims, uniqueness and all four collection
  reloads. Both passed against disposable PostgreSQL in initial CI run
  [41901266984](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41901266984).
  That run also exposed an existing mock-confirmation response-before-commit race
  in a separate PostgreSQL payment test; the route now buffers the response until
  commit. Static synthetic credentials were replaced/derived at runtime after scanner
  findings, and the feature commits consolidated with a retained local backup;
  no real key was involved and no scanner exclusion was added. Final CI is tracked
  in PR #179. No production database, payment, router or network writes for tests.
- `git diff --check`: passed at review.

## Proposed KPIs and pending hardware work

All hardware KPI values are **proposed targets**, not measurements: exactly one
upstream and mode; zero duplicate payment entitlement, unauthorized claim or
allowance/validity reset; zero successful new general-internet connections after
confirmed cutoff; retained portal/payment paths; no configured household cap.
Proposed healthy activation/renewal p95 ≤30s, usage freshness ≤60s, maximum native
quota overshoot ≤1 MiB per entitlement across ≥100 exhaustion trials. Compare
independent packet capture, native and durable counters and explain layer/sample
differences. Details and rejection gates are in the
[operations runbook](../operations/ndahi-home.md).

Release verified 5 November 2026: PR #179 merged as `011b75d` and all three
production services deployed that exact revision; Home remains disabled. Fresh
strict smoke and 16 selected asset hashes match the release. See
[release evidence](../releases/ndahi-home-2026-11-05.md).

Read-only ether2 observations now show 1 Gbps/full duplex, no new link-down count
and zero observed error counters. This does not prove the Home NAT/quota pilot or
identify the earlier physical fault. Any WISP router with IPv4 NAT, a private LAN and stable upstream MAC can be
evaluated; the application has no vendor/model allow-list. The available DAP-1360 C1 / label 3.00 is disconnected and requires the
separate isolated evaluation and security caveats; no model compatibility is
claimed from its WISP mode name. All physical acceptance criteria remain open.


## Readiness follow-up (#171, #175, #177, #178)

Implemented a capability-based setup guide, exact read-only Home index checks,
production enrollment/authorization schema guards, additive-only migration tooling,
and an isolated native PostgreSQL dump/restore rehearsal. The owner/operator Home
page checks the API's existing private database connection; external PostgreSQL
access remains disabled. No production schema or router changes were made during
implementation.

Gateway inspection uses GET requests and reports configuration separately from
physical evidence. Quota cutoff is recorded only after confirmed revocation and
final accounting. Terminal/review households do not create endless refresh work.
Operations diagnostics show unknown ages/readings honestly and distinguish
server-observed activation latency from controlled physical measurements. Pilot
JSON includes topology/firmware, evidence hashes, required scenarios and at least
100 quota/activation trials. Synthetic or incomplete reports cannot pass physical
acceptance; even a reported pass requires independent review.

Local validation on 5 November: 1,152 tests passed, zero failures/skips, against
isolated PostgreSQL 18.6; 24 Home browser checks passed at 320/1280 pixels with
blocked storage and missing SubmitEvent.submitter. Native custom-format dump and
restore preserved paid history, all four Home collections, and Home/direct usage.
This rehearsal used synthetic data and did not test production encrypted backups
or establish production RPO/RTO. Final candidate CI and deployment remain pending.
See [readiness and evidence workflow](../operations/ndahi-home-readiness.md).
