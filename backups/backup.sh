#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(DATABASE_URL AWS_REGION S3_BUCKET_NAME AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY BACKUP_ENCRYPTION_KEY BACKUP_ALERT_WEBHOOK_URL)
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

aws s3api head-bucket --bucket "$S3_BUCKET_NAME" --region "$AWS_REGION" >/dev/null
aws s3api put-public-access-block --bucket "$S3_BUCKET_NAME" --region "$AWS_REGION" \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
aws s3api put-bucket-versioning --bucket "$S3_BUCKET_NAME" --region "$AWS_REGION" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$S3_BUCKET_NAME" --region "$AWS_REGION" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-lifecycle-configuration --bucket "$S3_BUCKET_NAME" --region "$AWS_REGION" \
  --lifecycle-configuration "{\"Rules\":[{\"ID\":\"expire-ndahi-backups\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"ndahi-postgres/\"},\"Expiration\":{\"Days\":$retention_days},\"NoncurrentVersionExpiration\":{\"NoncurrentDays\":$retention_days}}]}"

pg_dump --no-owner --no-privileges --clean --if-exists --quote-all-identifiers \
  "$DATABASE_URL" | gzip -9 | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -out "$encrypted_file"
sha256sum "$encrypted_file" | awk '{print $1}' > "$checksum_file"

aws s3 cp "$encrypted_file" "s3://$S3_BUCKET_NAME/$object_key" --region "$AWS_REGION" \
  --sse AES256 --only-show-errors
aws s3 cp "$checksum_file" "s3://$S3_BUCKET_NAME/$object_key.sha256" --region "$AWS_REGION" \
  --sse AES256 --only-show-errors
aws s3api head-object --bucket "$S3_BUCKET_NAME" --key "$object_key" \
  --region "$AWS_REGION" --query '{size:ContentLength,encryption:ServerSideEncryption}' >/dev/null
aws s3 cp "s3://$S3_BUCKET_NAME/$object_key" "$downloaded_file" \
  --region "$AWS_REGION" --only-show-errors
[[ "$(sha256sum "$downloaded_file" | awk '{print $1}')" == "$(cat "$checksum_file")" ]]
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$downloaded_file" | gzip -t

trap - ERR
echo "Encrypted PostgreSQL backup uploaded and verified: $object_key"
