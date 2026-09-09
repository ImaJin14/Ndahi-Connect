# Encrypted PostgreSQL backup runbook

Owner: NDAHI Connect infrastructure administrator  
Frequency: daily at 01:43 UTC  
Retention: 35 days, including noncurrent object versions  
Last reviewed: 2026-09-09

The `ndahi-postgres-backup` Render cron job creates a consistent `pg_dump`, compresses
it, encrypts it locally with AES-256 and PBKDF2, and uploads only ciphertext to a
dedicated off-site S3 bucket. S3 AES-256 encryption provides a second layer at rest.
The job downloads the uploaded object, decrypts it as a stream, and validates the gzip
payload before reporting success. Render documents scheduled direct-database backups
to S3 and specifically warns against using a PgBouncer URL for dumps.

## Required configuration

- `DATABASE_URL`: Render direct database connection supplied by the Blueprint.
- `AWS_REGION` and `S3_BUCKET_NAME`: dedicated backup bucket in a separate provider
  account or security boundary from Render.
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: a dedicated non-human IAM identity.
- `BACKUP_ENCRYPTION_KEY`: independently generated secret of at least 32 characters.
- `BACKUP_ALERT_WEBHOOK_URL`: private operations alert endpoint.
- `BACKUP_RETENTION_DAYS`: 35 by default and never less than seven.

Grant the backup identity only bucket metadata/configuration access plus list, put,
get, and delete-version access under `ndahi-postgres/*`. Block all public access. Do
not reuse application credentials, store the encryption key in S3, or put secrets in
Git. Restrict Render environment access to infrastructure administrators and require
MFA on both Render and AWS.

## Monitoring and response

Every failed command exits the job nonzero, causing a failed Render cron run, and sends
a secret-free failure message to the configured webhook. Operators must enable Render
failure notifications as a second channel, review the cron result daily, and investigate
any missing object, unexpected size change, integrity failure, or lifecycle error.

Trigger one manual run after configuring the Blueprint. Confirm the job succeeds, the
`.enc` and `.sha256` objects exist, public access is blocked, encryption reports AES256,
versioning is enabled, and the lifecycle rule expires current and noncurrent versions.
DATA-005 covers performing a timed restore with the encrypted object.

References: [Render PostgreSQL-to-S3 guide](https://render.com/docs/backup-postgresql-to-s3)
and [Render Blueprint specification](https://render.com/docs/blueprint-spec).
