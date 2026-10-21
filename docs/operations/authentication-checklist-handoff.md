# Auth/voucher checklist handoff to primary PC

Primary PC owns `docs/product-improvement-checklist.md`; integrate these bounded states after reviewing exact PR heads.

- #81: verified replacement migration/proof/read-only readiness preparation implemented. Focused API/proof and real browser evidence in its PR/runbook. Legacy factors preserved. Production aggregate inventory, recovery/authentication pilots, identity integration/physical acceptance and compatible rollback rehearsal remain pending. Preparation does not imply retirement readiness.
- #82: separate gated retirement implementation; no production activation. Require current verified replacements plus reviewed recovery/pilot evidence and rollback SHA. Record final tests/head from its focused draft PR. Do not mark production ready/deployed or close runtime blockers from a synthetic test.
- #83: focused scoped voucher API/UI and role matrix implemented in PR86. Unit/API691pass13PGskip; seven new and existing admin/authorization/notification browser checks pass locally. CI/deployment/physical operator acceptance recorded separately in PR/runbook.

No merges, production account changes, deployments or router actions occurred on this PC for these issues.
