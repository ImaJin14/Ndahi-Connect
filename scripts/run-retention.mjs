import pg from "pg";
import { runRetention } from "../lib/retention.mjs";
import { createLogger } from "../lib/logger.mjs";

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const ssl = process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 1 });
const client = await pool.connect();
try {
  const counts = await runRetention(client);
  createLogger({ service: "retention", level: process.env.LOG_LEVEL }).info("retention.completed", { counts });
} finally {
  client.release();
  await pool.end();
}
