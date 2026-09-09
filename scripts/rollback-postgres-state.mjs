import pg from "pg";
import { blank } from "../server.mjs";
import { replaceNormalizedState } from "../lib/postgres-store.mjs";

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (process.env.CONFIRM_STATE_ROLLBACK !== "restore-legacy-ndahi-state") {
  throw new Error("Set CONFIRM_STATE_ROLLBACK=restore-legacy-ndahi-state to confirm rollback");
}
const ssl = process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SELECT pg_advisory_xact_lock($1)", [731904001]);
  const legacy = await client.query("SELECT 1 FROM ndahi_state WHERE id = 1 FOR UPDATE");
  if (!legacy.rowCount) throw new Error("Legacy ndahi_state row is unavailable; rollback aborted");
  await replaceNormalizedState(client, blank());
  await client.query("DELETE FROM app_settings WHERE key = 'legacyMigration'");
  await client.query("COMMIT");
  console.log(JSON.stringify({ status: "rolled-back", legacyStatePreserved: true }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
