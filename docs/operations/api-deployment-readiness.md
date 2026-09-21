# API deployment readiness

## Confirmed deployment blocker

The deployment of `9542aa5` on Node 22 timed out while the payment and network
workers repeatedly failed. A read-only check from Render confirmed PostgreSQL
connectivity but found `customers`, `payments`, `vouchers`, `events`, `audit_logs`,
and `app_settings` absent. The normalized schema must be migrated before this API
can become ready.

The Render Shell was running the previous successful release, `b29b289`, without
`healthCheck()`. Its `UNKNOWN` result was not a database diagnosis. A successful
public response or an old Shell session does not verify the failed new instance.

## Recovery procedure

1. Merge the migration tooling and readiness checks into the branch Render deploys.
2. Take and verify a database backup and pause old API writes. Follow the
   [normalized-state migration runbook](normalized-state-migration-runbook.md).
3. For the coordinated migration deployment, set the API pre-deploy command to:

   ```bash
   npm run migrate:postgres && npm run check:database
   ```

   This runs the new release's files, rather than the old instance's Shell files.
   The Node migration runner applies the checked-in transactional SQL files in
   order, then invokes the existing legacy-data migration. That migration validates
   relationships, refuses to overwrite occupied normalized tables without a marker,
   reconciles collection counts, and retains the legacy row as a rollback source.
4. Confirm the migration result and that the new deployment becomes live. Verify
   customer and administrator access and historical payment/voucher records.
5. Restore the normal read-only gate, also specified in `render.yaml`:

   ```bash
   npm run check:database
   ```

Apply the Blueprint changes or set the pre-deploy command in Render's service
settings. The default gate deliberately does not modify production data. It fails
if required tables are absent; merging this PR alone does not perform migration.
Confirm branch `main`, health path `/api/health`, and bind address `0.0.0.0`.

## Diagnostics

The read-only gate reports missing table names or a sanitized failure code. Startup
logs include actual bind address, runtime, and Render commit. Readiness checks use
a separate PostgreSQL connection pool and return `503` within four seconds when
unavailable, without waiting for the application's global write lock.

`api.readiness_failed` and worker failure logs include safe codes and fixed hints:

| Code | Meaning |
| --- | --- |
| `42P01` | Required table missing |
| `42501` | Insufficient database permissions |
| `28P01` | Authentication failed |
| `3D000` | Database does not exist |
| `53300` | Connection limit reached |
| `57014` | Query canceled or timed out |
| `23503` / `23505` / `23514` | Foreign-key / uniqueness / check constraint violation |
| `ENOTFOUND` / `EAI_AGAIN` | DNS resolution failure |
| `ECONNREFUSED` / `ETIMEDOUT` | Connection refused / timed out |
| `HEALTH_TIMEOUT` | Readiness deadline exceeded |
| `DATABASE_UNAVAILABLE` | Other error; inspect connectivity, SSL, and schema |

Driver messages, connection strings, and row details are not logged. Render-private
hostnames cannot be diagnosed from an unrelated local network; use the API's Render
environment. Router/access-point configuration is not part of database readiness.

## Validation

All 141 local tests, syntax checks, and diff checks passed. Coverage includes
readiness timeouts, concurrent probes, sanitized errors, schema migration ordering,
and rollback/stop behavior on a schema failure. Unit tests use fake database clients;
the production migration and deployed PostgreSQL verification remain outstanding.
