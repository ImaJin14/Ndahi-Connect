import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backupUrl = new URL("../backups/backup.sh", import.meta.url);

test("backup workflow encrypts before off-site upload and verifies the remote copy", async () => {
  const source = await readFile(backupUrl, "utf8");
  for (const requirement of [
    "pg_dump --no-owner --no-privileges", "gzip -9",
    "openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000",
    "--sse AES256", "put-bucket-encryption", "put-public-access-block",
    "put-bucket-versioning", "put-bucket-lifecycle-configuration",
    "sha256sum \"$downloaded_file\"", "openssl enc -d -aes-256-cbc",
    "BACKUP_ALERT_WEBHOOK_URL", "set -Eeuo pipefail", "umask 077",
  ]) assert.ok(source.includes(requirement), `missing backup safeguard: ${requirement}`);
  assert.ok(source.indexOf("openssl enc -aes-256-cbc") < source.indexOf("aws s3 cp \"$encrypted_file\""));
  assert.doesNotMatch(source, /echo\s+["']?\$\{?BACKUP_ENCRYPTION_KEY/);
});

test("Render schedules a direct-database backup with secret configuration", async () => {
  const render = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
  assert.match(render, /type: cron[\s\S]*name: ndahi-postgres-backup[\s\S]*schedule: "43 1 \* \* \*"/);
  assert.match(render, /dockerfilePath: \.\/backups\/Dockerfile/);
  for (const name of [
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "BACKUP_ENCRYPTION_KEY",
    "BACKUP_ALERT_WEBHOOK_URL",
  ]) assert.match(render, new RegExp(`key: ${name}\\n\\s+sync: false`));
  assert.match(render, /name: ndahi-postgres[\s\S]*property: connectionString/);
});

test("backup policy documents frequency, retention, access, off-site storage, and monitoring", async () => {
  const policy = await readFile(
    new URL("../docs/operations/postgres-backup-runbook.md", import.meta.url), "utf8",
  );
  for (const term of ["daily", "35 days", "off-site S3", "nonzero", "failure", "MFA", "restore"]) {
    assert.ok(policy.includes(term), `backup runbook must document ${term}`);
  }
});
