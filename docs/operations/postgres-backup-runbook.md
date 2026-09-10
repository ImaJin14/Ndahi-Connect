# Encrypted PostgreSQL backup runbook

Owner: NDAHI Connect infrastructure administrator  
Frequency: daily at 01:43 UTC  
Retention: 35 days
Last reviewed: 2026-09-09

The `ndahi-postgres-backup` Render cron job creates a consistent `pg_dump`, compresses
it, encrypts it locally with AES-256 and PBKDF2, and uploads only ciphertext to a
dedicated off-site Cloudflare R2 bucket. R2 also encrypts stored object data at rest.
The job downloads the uploaded object, decrypts it as a stream, and validates the gzip
payload before reporting success. Render documents scheduled direct-database backups
to off-site object storage and specifically warns against using a PgBouncer URL for dumps.

## Required configuration

- `DATABASE_URL`: Render direct database connection supplied by the Blueprint.
- `R2_ENDPOINT`: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` from Cloudflare.
- `R2_BUCKET_NAME`: dedicated private R2 bucket in a separate security boundary from Render.
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: bucket-scoped R2 S3 API credentials;
  these variable names are required by the compatible AWS CLI and do not use AWS storage.
- `BACKUP_ENCRYPTION_KEY`: independently generated secret of at least 32 characters.
- `BACKUP_ALERT_WEBHOOK_URL`: private operations alert endpoint.
- `BACKUP_RETENTION_DAYS`: 35 by default and never less than seven.

Create an R2 Admin Read & Write token scoped only to this bucket so the job can verify
the bucket and maintain its lifecycle rule. Keep the bucket's public development URL
and custom domains disabled. Do not reuse application
credentials, store the encryption key in R2, or put secrets in Git. Restrict Render
environment access to infrastructure administrators and require MFA on Render and
Cloudflare.

## Monitoring and response

Every failed command exits the job nonzero, causing a failed Render cron run, and sends
a secret-free failure message to the configured webhook. Operators must enable Render
failure notifications as a second channel, review the cron result daily, and investigate
any missing object, unexpected size change, integrity failure, or lifecycle error.

Trigger one manual run after configuring the Blueprint. Confirm the job succeeds, the
`.enc` and `.sha256` objects exist, public access is disabled, and the lifecycle rule
expires objects after 35 days.
DATA-005 covers performing a timed restore with the encrypted object.

References: [Cloudflare R2 S3 API setup](https://developers.cloudflare.com/r2/get-started/s3/),
[R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/),
and [Render Blueprint specification](https://render.com/docs/blueprint-spec).
