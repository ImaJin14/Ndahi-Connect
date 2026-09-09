# Normalized PostgreSQL state migration runbook

Last exercised: 2026-09-09 (automated production-shaped rehearsal)

## Safety model

The migration locks the legacy row and application state, validates identifiers,
uniqueness, and relationships, writes all normalized tables in one serializable
transaction, and reconciles every collection count before commit. Any error rolls
back the entire transaction. The `ndahi_state` row is retained unchanged as the
rollback source.

## Production procedure

1. Take and verify a PostgreSQL backup. Record its identifier and timestamp.
2. Disable API writes or stop the API service. Static services may remain online.
3. Run `npm run migrate:postgres` with `DATABASE_URL` and `DATABASE_SSL` set for
   the target database. Do not start the normalized application if this exits nonzero.
4. Save the JSON result. A successful legacy conversion reports `status: migrated`,
   `matched: true`, and identical `expected` and `actual` counts. A new empty database
   reports `status: fresh-database`. Re-running reports `status: already-migrated`.
5. Run `npm run verify:postgres`, then deploy the new API and perform customer login,
   voucher lookup, payment lookup, and administrator login smoke checks.
6. Retain `ndahi_state` until at least one verified backup and restoration drill cover
   the normalized schema. Remove it only under a separately reviewed retention change.

## Rollback

Stop all API writers and redeploy the last JSONB-compatible API version. Then run:

```bash
CONFIRM_STATE_ROLLBACK=restore-legacy-ndahi-state npm run rollback:postgres:state
```

The rollback transaction clears normalized entity rows and the migration marker but
does not alter `ndahi_state`. Never run rollback after accepting new production writes
into the normalized schema: those writes are not present in the retained legacy row.
