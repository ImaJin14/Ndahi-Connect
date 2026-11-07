# Returning account identity and reconciliation — 7 November 2026

## Scope

Continue the peer PC's `7d096ef` account-identity fix from production baseline
`6b2998c7c7ef69c19f5513b9790d558a4f381759`. Preserve the original saved account
when new checkout details conflict; keep alternate payers transaction-specific.
Add a private read-only reconciliation inventory and digest-bound transactional
repair for eligible existing duplicate shells. Original peer working-copy
pricing drafts are already represented by merged changes and remain untouched.

## Validation

- Final local suite: **1,178 passed, zero failures/skips**, using disposable
  PostgreSQL 18.6. All 39 focused account/reconciliation/store tests pass,
  including backup failure, foreign-key-safe reparenting, JSONB round trips,
  store reopen, stale credentials and independent-worker races.
- All ten new 320/1280px real-API account purchase browser journeys pass,
  including conflicting details, selected-plan return, original-profile
  renewal/switch, existing active access and lost replies.
- `npm run check`, explicit reconciliation CLI/module syntax, offline provider
  contracts and `git diff --check` pass. Final hosted CI, deployed revisions and
  live audit results will be recorded after completion. No production account
  mutation is claimed by these local results.

## Production status

Before release, public API health reports PostgreSQL ready and authentication
policy revision `6b2998c7c7ef69c19f5513b9790d558a4f381759`.
The implementation was merged in [PR #185](https://github.com/ImaJin14/Ndahi-Connect/pull/185)
as `f813bf297dbce50c0a1ae214d6ebb0b3a9cac962`, exactly matching reviewed
head `d5b8808f54303feb42942a30998296e436896dd9`. All seven exact-head checks
pass ([CI 42397908350](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/42397908350)).
[Main CI 42398641537](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/42398641537) passes. All three Render services deployed this exact revision successfully:

| Service | GitHub deployment | Render artifact | Success UTC |
| --- | --- | --- | --- |
| API | 7624914102 | dep-dbnmfvks728c739d1590 | 18:04:36 |
| Customer | 7624914150 | dep-dbnmfvks728c739d169g | 18:04:38 |
| Admin | 7624914134 | dep-dbnmfvks728c739d16g0 | 18:04:37 |

Live API revision and PostgreSQL readiness match. Customer asset revision is
`b40fda1c65f97c9181c0`; admin is `f544e010d429efbbe978`. Six delivered source
asset SHA-256 comparisons match. All six strict smoke groups and six read-only
320/1280px browser checks pass. Automatic smoke runs 42399443502, 42399441789
and 42399440412 pass; the last was retried after an old stylesheet reference
returned 404 during replica transition. No source or configuration change was
needed for that retry.

Existing-account reconciliation is not claimed by this account rollout. The
user subsequently authorized including PR #183 and running reconciliation in
the API's existing private environment; that follow-up release records actual
inventory/repair outcomes separately.
Physical phone/router and actual Mobile Money acceptance remain separate.

See the [reconciliation runbook](../operations/account-reconciliation.md).
