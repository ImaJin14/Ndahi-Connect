# NDAHI Home delivery and review evidence

Parent [#170](https://github.com/ImaJin14/Ndahi-Connect/issues/170) and all children
were opened before implementation. Dependency order: #171 → #172 → #173/#175 →
#174/#176/#177 → #178. Software workstreams #172, #173, #174 and #176 were
closed after the 5 November acceptance audit. Parent #170 and #171/#175/#177/#178
remain open for migration, native enforcement, operational and physical acceptance.

| Issue | Implemented | Remaining acceptance |
| --- | --- | --- |
| [#171](https://github.com/ImaJin14/Ndahi-Connect/issues/171) | Four normalized payload collections; additive migration 008 with uniqueness/due indexes; JSON defaults and state migration. | Migration/restore rehearsal. Home PostgreSQL claim/reload/uniqueness tests passed in initial CI; migration does not create four tables. |
| [#172](https://github.com/ImaJin14/Ndahi-Connect/issues/172) | **Software complete; issue closed.** Session-bound two-minute, single-use local HotSpot proof; trusted host/MAC; atomic competing claims; replacement owner proof and revocation barrier. | Tracked in #175/#178: actual local HTTPS/captive portal, negative hardware cases and residual MAC-cloning risk acceptance. |
| [#173](https://github.com/ImaJin14/Ndahi-Connect/issues/173) | **Software complete; issue closed.** Exclusive assignment, direct credential/grant revocation, final counter reconciliation, usage offset returning to direct, fresh native Home meter on reassignment. | Tracked in #175/#178: active-session and packet-capture proof across repeated transitions. |
| [#174](https://github.com/ImaJin14/Ndahi-Connect/issues/174) | **Software complete; issue closed.** Existing server-verified payments; frozen Home target; one entitlement per payment; pending router activation; exhausted-before-expiry/offsite renewal; active-with-data blocker. | Tracked in #178/#143: real provider acceptance and healthy latency measurements. A changed/removed link requires verified reassignment, never arbitrary browser identifiers. |
| [#175](https://github.com/ImaJin14/Ndahi-Connect/issues/175) | Private MAC-bound native user; aggregate remaining quota; local calendar/volatile guards; strict IPv6/FastTrack/firewall preparation; monotonic fail-closed counters and reboot handling. | Native RouterOS transport/scripts/counter semantics and all quota/traffic/reconnect/outage trials. No automatic lost-counter recovery. |
| [#176](https://github.com/ImaJin14/Ndahi-Connect/issues/176) | **Software complete; issue closed.** Explicit Home flow, EN/FR, new account/link/assign/buy/renew, shared usage/freshness, pending/retry, masked identity; direct counters/controls hidden for Home. | Tracked in #178/#143: real old-device and assistive-technology acceptance. No WISP management API. |
| [#177](https://github.com/ImaJin14/Ndahi-Connect/issues/177) | Owner/operator masked view, safe retry/revoke with audit reason, customer-assisted verified replacement; bounded durable worker retries. | Support pilot, load/freshness and lost-counter operational rehearsal. |
| [#178](https://github.com/ImaJin14/Ndahi-Connect/issues/178) | Security/domain/API/gateway and browser checks; reviewed network template; setup/rollback/pilot/KPI runbook. | Final CI tracked in PR #179; physical pilot and deployment decision. |

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
identify the earlier physical fault. The named TL-WR902AC V3 pilot remains a
candidate. The available DAP-1360 C1 / label 3.00 is disconnected and requires the
separate isolated evaluation and security caveats; no model compatibility is
claimed from its WISP mode name. All physical acceptance criteria remain open.

## Issue acceptance audit — 5 November 2026

Completed software issues #172/#173/#174/#176 were closed with individual test and release evidence. The live release remains `91ad174`; Home remains disabled. Fresh verification passed 42 focused Home/advisory tests and 20 Home browser journeys at 320px/1280px, including blocked storage and supplementary keyboard activation/focus checks. Expired/exhausted assignment rejected without changing voucher state or queueing work. Final main CI42016061250 passed 1,130 tests with PostgreSQL and no skips.

These closures certify the implementation/API/browser scope. They do not certify packet-level restriction, physical router possession, quota overshoot, provider completion or native phone behavior. Shared physical/KPI conditions remain under open parent #170 and workstreams #171/#175/#177/#178; no native acceptance checkbox was waived.
