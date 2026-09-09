import pg from "pg";
import { blank } from "../server.mjs";
import {
  readNormalizedState,
  replaceNormalizedState,
} from "../lib/postgres-store.mjs";
import {
  migrationCounts,
  reconcileMigration,
  validateLegacyState,
} from "../lib/state-migration.mjs";

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const ssl = process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 1 });
const client = await pool.connect();

try {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SELECT pg_advisory_xact_lock($1)", [731904001]);
  const marker = await client.query(
    "SELECT value FROM app_settings WHERE key = 'legacyMigration'",
  );
  const legacy = await client.query("SELECT data FROM ndahi_state WHERE id = 1 FOR UPDATE");
  if (marker.rowCount) {
    await client.query("COMMIT");
    console.log(JSON.stringify({ status: "already-migrated", marker: marker.rows[0].value }));
  } else if (!legacy.rowCount) {
    const counts = migrationCounts(blank());
    await client.query(
      "INSERT INTO app_settings (key, value) VALUES ('legacyMigration', $1::jsonb)",
      [JSON.stringify({ status: "fresh-database", counts, migratedAt: new Date().toISOString() })],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ status: "fresh-database", counts }));
  } else {
    const state = { ...blank(), ...legacy.rows[0].data };
    const errors = validateLegacyState(state);
    if (errors.length) throw new Error(`Legacy state validation failed:\n- ${errors.join("\n- ")}`);
    const current = await readNormalizedState(client, blank);
    const occupied = Object.values(migrationCounts(current)).some(Boolean);
    if (occupied) throw new Error("Normalized tables already contain data; refusing to overwrite them");
    await replaceNormalizedState(client, state);
    const result = reconcileMigration(state, await readNormalizedState(client, blank));
    if (!result.matched) throw new Error(`Migration reconciliation failed: ${result.mismatches.join("; ")}`);
    await client.query(
      "INSERT INTO app_settings (key, value) VALUES ('legacyMigration', $1::jsonb)",
      [JSON.stringify({ status: "migrated", counts: result.actual, migratedAt: new Date().toISOString() })],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ status: "migrated", ...result }));
  }
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
