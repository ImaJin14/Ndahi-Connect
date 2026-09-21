import pg from "pg";
import { normalizedCollections } from "../lib/postgres-store.mjs";
import { databaseDiagnostic } from "../lib/database-diagnostics.mjs";

if (!process.env.DATABASE_URL) {
  console.error(JSON.stringify({ status: "unavailable", code: "DATABASE_URL_MISSING" }));
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true },
    max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
  });
  try {
    const required = [...new Set(normalizedCollections.map(({ table }) => table)), "app_settings"];
    const { rows } = await pool.query(
      "SELECT name, to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS name",
      [required],
    );
    const missing = rows.filter((row) => !row.present).map((row) => row.name);
    console.log(JSON.stringify({ status: missing.length ? "schema_missing" : "schema_present", missing }));
    if (missing.length) process.exitCode = 1;
    else {
      await pool.query(required.map((table) => `SELECT 1 FROM ${table} WHERE false`).join(" UNION ALL "));
      console.log(JSON.stringify({ status: "ready", access: "readable" }));
    }
  } catch (error) {
    // Never log error.message: drivers may include usernames or connection details.
    console.error(JSON.stringify({ status: "unavailable", ...databaseDiagnostic(error) }));
    process.exitCode = 1;
  } finally { await pool.end(); }
}
