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
The new changes are not yet merged or deployed. Production reconciliation needs
authenticated access to the API service's existing database environment.
Physical phone/router and actual Mobile Money acceptance remain separate.

See the [reconciliation runbook](../operations/account-reconciliation.md).
