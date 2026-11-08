import pg from "pg";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { storeLockId } from "../lib/postgres-store.mjs";
import { inspectStoreDatabase } from "../lib/store-database-readiness.mjs";

// Only reviewed additive indexes. Never import state, repair data, drop indexes,
// or print connection details. The existing store lock excludes concurrent writes.
export async function deployStoreSchema(client) {
  await client.query("SELECT pg_advisory_lock($1)", [storeLockId]);
  try {
    const before = await inspectStoreDatabase(client);
    if (before.status === "ready") return { ...before, applied: false };
    if (before.checks.some((check) => check.status === "invalid"))
      throw Object.assign(Error("Store index definitions require review."), {
        code: "STORE_INDEX_REVIEW_REQUIRED",
      });
    try {
      await client.query(
        await readFile(
          new URL("../migrations/010_device_store.sql", import.meta.url),
          "utf8",
        ),
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const after = await inspectStoreDatabase(client);
    if (after.status !== "ready")
      throw Object.assign(Error("Store schema verification failed."), {
        code: "STORE_SCHEMA_NOT_READY",
      });
    return { ...after, applied: true };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [storeLockId]);
  }
}
async function main() {
  if (process.env.NODE_ENV !== "production") return;
  let pool, client;
  try {
    if (!process.env.DATABASE_URL)
      throw Error("Database configuration missing.");
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.DATABASE_SSL === "false"
          ? false
          : { rejectUnauthorized: true },
      max: 1,
      connectionTimeoutMillis: 10000,
      statement_timeout: 60000,
      lock_timeout: 10000,
    });
    client = await pool.connect();
    console.log(
      JSON.stringify({
        component: "device-store",
        ...(await deployStoreSchema(client)),
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        component: "device-store",
        status: "unavailable",
        code:
          error.code === "STORE_INDEX_REVIEW_REQUIRED"
            ? error.code
            : "STORE_SCHEMA_STARTUP_FAILED",
      }),
    );
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool?.end();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
