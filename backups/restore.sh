#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(RESTORE_DATABASE_URL BACKUP_OBJECT_KEY AWS_REGION S3_BUCKET_NAME AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY BACKUP_ENCRYPTION_KEY CONFIRM_DATABASE_RESTORE)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "Required restore configuration is missing: $name" >&2; exit 2; }
done
[[ "$CONFIRM_DATABASE_RESTORE" == "restore-encrypted-backup-to-isolated-target" ]] || {
  echo "Restore confirmation value is invalid" >&2
  exit 2
}
[[ "$BACKUP_OBJECT_KEY" =~ ^ndahi-postgres/daily/[0-9TZ:-]+\.sql\.gz\.enc$ ]] || {
  echo "BACKUP_OBJECT_KEY is outside the approved backup prefix or format" >&2
  exit 2
}
if [[ -n "${DATABASE_URL:-}" && "$RESTORE_DATABASE_URL" == "$DATABASE_URL" ]]; then
  echo "Restore target must not be the production source database" >&2
  exit 2
fi
if (( ${#BACKUP_ENCRYPTION_KEY} < 32 )); then
  echo "BACKUP_ENCRYPTION_KEY must contain at least 32 characters" >&2
  exit 2
fi

restore_tmp_dir="$(mktemp -d)"
cleanup() { rm -rf -- "$restore_tmp_dir"; }
trap cleanup EXIT
started_epoch="$(date +%s)"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
encrypted_file="$restore_tmp_dir/backup.sql.gz.enc"
checksum_file="$restore_tmp_dir/backup.sql.gz.enc.sha256"
sql_file="$restore_tmp_dir/backup.sql"

aws s3 cp "s3://$S3_BUCKET_NAME/$BACKUP_OBJECT_KEY" "$encrypted_file" \
  --region "$AWS_REGION" --only-show-errors
aws s3 cp "s3://$S3_BUCKET_NAME/$BACKUP_OBJECT_KEY.sha256" "$checksum_file" \
  --region "$AWS_REGION" --only-show-errors
expected_checksum="$(tr -d '[:space:]' < "$checksum_file")"
[[ "$expected_checksum" =~ ^[a-f0-9]{64}$ ]]
[[ "$(sha256sum "$encrypted_file" | awk '{print $1}')" == "$expected_checksum" ]]

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$encrypted_file" | gzip -dc > "$sql_file"
[[ -s "$sql_file" ]]
psql -v ON_ERROR_STOP=1 --single-transaction "$RESTORE_DATABASE_URL" -f "$sql_file" >/dev/null

validation="$(psql -v ON_ERROR_STOP=1 -At "$RESTORE_DATABASE_URL" -c \
  "SELECT json_build_object('customers',(SELECT count(*) FROM customers),'payments',(SELECT count(*) FROM payments),'vouchers',(SELECT count(*) FROM vouchers),'audit_logs',(SELECT count(*) FROM audit_logs),'foreign_key_violations',(SELECT count(*) FROM vouchers v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.customer_id IS NOT NULL AND c.id IS NULL));")"
[[ "$validation" == *'"foreign_key_violations" : 0'* || "$validation" == *'"foreign_key_violations":0'* ]]

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
elapsed_seconds="$(( $(date +%s) - started_epoch ))"
report_key="ndahi-postgres/restore-reports/${completed_at//:/-}.json"
report_file="$restore_tmp_dir/restore-report.json"
printf '{"status":"passed","backupObject":"%s","startedAt":"%s","completedAt":"%s","elapsedSeconds":%s,"validation":%s}\n' \
  "$BACKUP_OBJECT_KEY" "$started_at" "$completed_at" "$elapsed_seconds" "$validation" > "$report_file"
aws s3 cp "$report_file" "s3://$S3_BUCKET_NAME/$report_key" --region "$AWS_REGION" \
  --sse AES256 --only-show-errors
echo "Restore drill passed in ${elapsed_seconds}s; report: $report_key"
