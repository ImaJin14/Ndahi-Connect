import pg from "pg";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHomeDatabase } from "../lib/home-database-readiness.mjs";
import { databaseDiagnostic } from "../lib/database-diagnostics.mjs";

export function homeMigrationAuthorization(env) {
  if (env.HOME_MIGRATION_CONFIRM !== "apply-reviewed-additive-home-indexes" ||
      typeof env.HOME_BACKUP_REFERENCE !== "string" || env.HOME_BACKUP_REFERENCE.trim().length < 8)
    throw Object.assign(Error("A verified backup reference and explicit migration confirmation are required"), { code: "HOME_MIGRATION_CONFIRMATION_REQUIRED" });
}

export async function applyHomeMigration(client, env) {
  homeMigrationAuthorization(env);
  const before = await inspectHomeDatabase(client);
  if (before.status === "ready") return { ...before, applied: false };
  if (before.checks.some(check => check.status === "invalid"))
    return { ...before, applied: false, code: "HOME_INDEX_DEFINITION_REVIEW_REQUIRED" };
  try {
    // Only the additive Home indexes: never import JSON state or run legacy rollback.
    await client.query(await readFile(new URL("../migrations/008_ndahi_home.sql", import.meta.url), "utf8"));
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  return { ...await inspectHomeDatabase(client), applied: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pool, client;
  try {
    homeMigrationAuthorization(process.env);
    if (!process.env.DATABASE_URL) throw Object.assign(Error(), { code: "DATABASE_URL_MISSING" });
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true }, max: 1,
      connectionTimeoutMillis: 5000, statement_timeout: 30000, lock_timeout: 5000 });
    client = await pool.connect();
    const report = await applyHomeMigration(client, process.env);
    console.log(JSON.stringify(report));
    if (report.status !== "ready") process.exitCode = 1;
  } catch (error) {
    const code = ["HOME_MIGRATION_CONFIRMATION_REQUIRED", "DATABASE_URL_MISSING"].includes(error.code) ? error.code : "HOME_MIGRATION_FAILED";
    console.error(JSON.stringify({ status: "unavailable", ...databaseDiagnostic(error), code }));
    process.exitCode = 1;
  } finally { client?.release(); await pool?.end(); }
}
