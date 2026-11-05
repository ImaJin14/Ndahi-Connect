import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyHomeMigration, homeMigrationAuthorization } from "../scripts/apply-home-migration.mjs";

test("additive Home migration refuses to query or write before explicit backup/confirmation acknowledgement", async () => {
  const client = { async query() { throw Error("Database must not be touched"); } };
  for (const env of [{}, { HOME_MIGRATION_CONFIRM: "apply-reviewed-additive-home-indexes" },
    { HOME_BACKUP_REFERENCE: "verified-backup-reference" }]) {
    assert.throws(() => homeMigrationAuthorization(env), { code: "HOME_MIGRATION_CONFIRMATION_REQUIRED" });
    await assert.rejects(applyHomeMigration(client, env), { code: "HOME_MIGRATION_CONFIRMATION_REQUIRED" });
  }
});

test("migration CLI preserves a safe actionable confirmation error without a database connection", () => {
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/apply-home-migration.mjs", import.meta.url))], { env: {}, stdio: "pipe" });
    assert.fail("Migration must refuse an unconfirmed run");
  } catch (error) {
    assert.equal(error.status, 1);
    assert.equal(JSON.parse(error.stderr.toString()).code, "HOME_MIGRATION_CONFIRMATION_REQUIRED");
  }
});
