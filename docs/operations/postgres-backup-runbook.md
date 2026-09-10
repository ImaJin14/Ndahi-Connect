# Encrypted PostgreSQL backup runbook

Owner: NDAHI Connect infrastructure administrator  
Frequency: daily at 01:43 UTC  
Retention: 35 days
Last reviewed: 2026-09-09

The `ndahi-postgres-backup` Render cron job creates a consistent `pg_dump`, compresses
it, encrypts it locally with AES-256 and PBKDF2, and uploads only ciphertext to a
dedicated off-site Google Cloud Storage bucket. Google Cloud Storage also encrypts
stored object data at rest.
The job downloads the uploaded object, decrypts it as a stream, and validates the gzip
payload before reporting success. Render documents scheduled direct-database backups
to off-site object storage and specifically warns against using a PgBouncer URL for dumps.

## Required configuration

- `DATABASE_URL`: Render direct database connection supplied by the Blueprint.
- `GCS_BUCKET_NAME`: dedicated private Google Cloud Storage bucket in a separate
  security boundary from Render.
- `GCS_SERVICE_ACCOUNT_JSON_BASE64`: base64 encoding of a dedicated Google service
  account JSON key. Never use a personal account or paste raw JSON into logs.
- `BACKUP_ENCRYPTION_KEY`: independently generated secret of at least 32 characters.
- `BACKUP_ALERT_WEBHOOK_URL`: private operations alert endpoint.
- `BACKUP_RETENTION_DAYS`: 35 by default and never less than seven.

Grant the service account `Storage Object Admin` on this bucket and only the additional
bucket-metadata permission needed to maintain its lifecycle rule. Prevent public access
on the bucket. Do not reuse application credentials, store the encryption key in GCS,
or put secrets in Git. Restrict Render environment access to infrastructure
administrators and require MFA on Render and Google Cloud.

## Monitoring and response

Every failed command exits the job nonzero, causing a failed Render cron run, and sends
a secret-free failure message to the configured webhook. Operators must enable Render
failure notifications as a second channel, review the cron result daily, and investigate
any missing object, unexpected size change, integrity failure, or lifecycle error.

Trigger one manual run after configuring the Blueprint. Confirm the job succeeds, the
`.enc` and `.sha256` objects exist, public access is disabled, and the lifecycle rule
expires objects after 35 days.
DATA-005 covers performing a timed restore with the encrypted object.

References: [Cloud Storage for Firebase and Google Cloud integration](https://firebase.google.com/docs/storage/gcp-integration),
[Google Cloud Storage encryption](https://docs.cloud.google.com/storage/docs/encryption/default-keys),
and [Render Blueprint specification](https://render.com/docs/blueprint-spec).
