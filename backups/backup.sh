#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(DATABASE_URL GCS_BUCKET_NAME GCS_SERVICE_ACCOUNT_JSON_BASE64 BACKUP_ENCRYPTION_KEY BACKUP_ALERT_WEBHOOK_URL)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required backup configuration is missing: $name" >&2
    exit 2
  fi
done
if (( ${#BACKUP_ENCRYPTION_KEY} < 32 )); then
  echo "BACKUP_ENCRYPTION_KEY must contain at least 32 characters" >&2
  exit 2
fi

backup_tmp_dir="$(mktemp -d)"
cleanup() { rm -rf -- "$backup_tmp_dir"; }
alert_failure() {
  status=$?
  if [[ -n "${BACKUP_ALERT_WEBHOOK_URL:-}" ]]; then
    curl --fail --silent --show-error --max-time 10 \
      -H 'content-type: application/json' \
      --data '{"service":"ndahi-postgres-backup","status":"failed"}' \
      "$BACKUP_ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  echo "Encrypted PostgreSQL backup failed" >&2
  exit "$status"
}
trap cleanup EXIT
trap alert_failure ERR

retention_days="${BACKUP_RETENTION_DAYS:-35}"
[[ "$retention_days" =~ ^[0-9]+$ ]] && (( retention_days >= 7 )) || {
  echo "BACKUP_RETENTION_DAYS must be an integer of at least 7" >&2
  exit 2
}

timestamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
object_key="ndahi-postgres/daily/${timestamp}.sql.gz.enc"
encrypted_file="$backup_tmp_dir/database.sql.gz.enc"
checksum_file="$backup_tmp_dir/database.sql.gz.enc.sha256"
downloaded_file="$backup_tmp_dir/downloaded.sql.gz.enc"

node /backup/gcs.mjs configure "$retention_days"

pg_dump --no-owner --no-privileges --clean --if-exists --quote-all-identifiers \
  "$DATABASE_URL" | gzip -9 | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -out "$encrypted_file"
sha256sum "$encrypted_file" | awk '{print $1}' > "$checksum_file"

node /backup/gcs.mjs upload "$encrypted_file" "$object_key"
node /backup/gcs.mjs upload "$checksum_file" "$object_key.sha256"
node /backup/gcs.mjs download "$object_key" "$downloaded_file"
[[ "$(sha256sum "$downloaded_file" | awk '{print $1}')" == "$(cat "$checksum_file")" ]]
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$downloaded_file" | gzip -t

trap - ERR
echo "Encrypted PostgreSQL backup uploaded and verified: $object_key"
