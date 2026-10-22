# Independent authentication retirement review

Review scope: the uncommitted #82 runtime/UI source snapshot based on `97a55d8`, preparation #81 through `7564e9c`, and the subsequent admin fix `8332b37`. The review used isolated source copies and synthetic in-memory accounts. No production database, credentials, readiness counts, deployment, router or actual customer information was accessed.

## Confirmed findings and disposition

1. **Last verified admin credential:** the original runtime accepted a fresh proof from key A and removed A while retaining only a structurally configured, never-asserted key B. The isolated regression observed HTTP 200 where a verified replacement required 409. The admin fix records the fresh supported proof and checks `verifiedMethods` against the remaining credentials. That exact signed regression independently passed against a copy of the updated profile module and is retained in `test/auth-retirement-independent-review.test.mjs`.
2. **GET zone mutation:** the original pathname-only `/api/admin/zone` handler let an auditor's GET change zone notes and append an audit entry without the mutation role/CSRF gate. The independent real-API regression reproduced this. The preparation/runtime integration must require POST; normal zone updates must retain the persisted retirement marker.
3. **Zone response privacy:** the same handler returned the entire zone payload, including private authentication migration review and retirement metadata. The independent POST regression reproduced that exposure. Return only public zone fields, retaining internal metadata in persistent state.

The root agent is integrating the zone fixes from preparation. At the time these regressions were added, the standalone last-verified-credential revalidation passed; the final combined candidate, all three integrated cases and required CI still required validation. Subsequent PR/test evidence must identify the exact candidate rather than treating the initial failing snapshot as a completed implementation.

The review also found that preparation `7564e9c` alone permits session-only passkey enrollment after the retirement marker. It therefore cannot be the post-cutover rollback revision. The agreed resolution is a two-stage rollout: first deploy and test the complete #82 compatibility runtime while retirement remains dormant; only after real authentication/recovery pilots and fresh readiness review may an operator attest that exact tested runtime SHA as the rollback revision and perform the separate gated cutover. All API/worker revisions sharing state must support the marker and final fresh-proof policy before cutover. No current production rollback/pilot/readiness evidence is asserted here.

The preparation privacy follow-up `31b1cc9` correctly excludes verified credential markers and internal zone review/retirement fields from generic customer records/dashboard projections. Raw customer passkey fields in the separate admin customer-mutation response were additionally flagged for explicit projection during root integration.

## Validation boundaries

The focused regressions use signed ES256 assertions, required UV, existing authenticated staff roles and real API handlers. They do not mock a successful credential verifier. The separate customer scope had 64 passing focused API/protocol tests, including ten retirement/cutover/recovery/UV/replay cases, before the later independent review.

A successful local regression or CI run does not satisfy production migration readiness, actual customer/admin recovery and sign-in pilots, the exact compatible rollback rehearsal, merge, Render deployment, strict production smoke or physical installed-app/router acceptance. Those remain separately recorded rollout prerequisites. The primary PC owns the product checklist and should add the bounded review/test evidence after final integration.

22 October integration: the prepared zone/private-projection fixes and the last-verified-credential guard now pass with the combined signed-protocol candidate: 46 targeted tests, zero failures/skips. The full candidate and CI are validated separately; this count does not establish production readiness. The method-label CodeQL flow was independently traced and corrected with a closed literal enum, without a query suppression or weaker password hashing.

The final local signed/readiness/API regression selection passes 64/64 cases, with zero failures/skips. Initial draft CI confirms the PostgreSQL cutover test passes; its one unit failure is the imported HotSpot optional-chain compatibility regression, outside the authentication review. The proof-aware identity browser fixture and that peer-owned compatibility line need coordinated integration before final full CI can be green.
