import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";

export async function applySchemaMigrations(client) {
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const file of files) {
    try {
      // Each checked-in migration owns its BEGIN/COMMIT boundary.
      await client.query(await readFile(new URL(file, directory), "utf8"));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true },
    max: 1, connectionTimeoutMillis: 10000,
  });
  let client;
  try {
    client = await pool.connect();
    const files = await applySchemaMigrations(client);
    console.log(JSON.stringify({ status: "schema-applied", files }));
  } finally {
    client?.release();
    await pool.end();
  }
  // Preserve the existing validation, no-overwrite guard, and count reconciliation.
  await import("./migrate-postgres-state.mjs");
}
