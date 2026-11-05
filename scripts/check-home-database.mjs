import pg from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHomeDatabase } from "../lib/home-database-readiness.mjs";
import { databaseDiagnostic } from "../lib/database-diagnostics.mjs";

export async function checkHomeDatabase(env = process.env) {
  if (!env.DATABASE_URL) return { status: "unavailable", code: "DATABASE_URL_MISSING" };
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true },
    max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  let client;
  try { client = await pool.connect(); return await inspectHomeDatabase(client); }
  catch (error) { return { status: "unavailable", ...databaseDiagnostic(error) }; }
  finally { client?.release(); await pool.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await checkHomeDatabase();
  console.log(JSON.stringify(report));
  if (report.status !== "ready") process.exitCode = 1;
}
