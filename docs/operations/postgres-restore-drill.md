# PostgreSQL restoration drill

Owner: NDAHI Connect infrastructure administrator  
Target RPO: no more than 26 hours (daily backup plus a two-hour completion/alert margin)  
Target RTO: restore and validate service within 2 hours  
Drill frequency: quarterly and after material schema or backup changes

## Guardrails

Restore only into a newly created, isolated PostgreSQL database with no production
traffic. The restore script refuses a target equal to `DATABASE_URL`, requires an exact
confirmation phrase, restricts objects to the approved daily-backup prefix, validates
the remote SHA-256 checksum, and runs `psql` with `ON_ERROR_STOP` in one transaction.
Never test restoration by overwriting the production database.

## Timed drill procedure

1. Record the incident/drill start time and select the newest successful `.enc` object.
2. Create an empty isolated Render PostgreSQL database in Frankfurt with equal or newer
   PostgreSQL major version and enough storage. Set its direct URL as
   `RESTORE_DATABASE_URL`; do not use PgBouncer.
3. Run the backup container as a Render one-off job with entrypoint
   `/backup/restore.sh`, the backup service's S3/encryption variables, and:

   ```text
   BACKUP_OBJECT_KEY=ndahi-postgres/daily/YYYY-MM-DDTHH-MM-SSZ.sql.gz.enc
   CONFIRM_DATABASE_RESTORE=restore-encrypted-backup-to-isolated-target
   ```

4. Confirm checksum verification, decryption, transactional SQL restore, core table
   counts, and zero voucher-to-customer foreign-key violations all pass.
5. Run `npm run verify:postgres` against the isolated database, then smoke-test customer
   login, voucher lookup, administrator login, and a read-only payment lookup.
6. Record backup age (RPO), elapsed restoration time (RTO), row counts, tester, target,
   result, deviations, and follow-up actions. The script uploads a non-secret JSON report
   beneath `ndahi-postgres/restore-reports/`; link that object in the drill record.
7. Delete the isolated database after approval and retain the report with operational
   audit records.

## Drill record

- Date: Pending first live drill
- Tester: Pending
- Backup object/time: Pending
- Isolated target: Pending
- Started/completed/elapsed: Pending
- Observed RPO: Pending
- Validation counts: Pending
- Application smoke checks: Pending
- Result: **Blocked — actual encrypted backup and isolated target are required**
- Follow-up actions: Configure DATA-004 credentials, trigger a backup, then run this drill.
