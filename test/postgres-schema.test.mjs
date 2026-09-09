import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizedCollections } from "../lib/postgres-store.mjs";

const migrationUrl = new URL("../migrations/002_normalized_schema.sql", import.meta.url);

test("normalized PostgreSQL schema covers every state collection", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const tables = new Set(normalizedCollections.map(({ table }) => table));
  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
  }
  assert.equal(normalizedCollections.length, 21);
});

test("normalized PostgreSQL schema declares relational integrity and indexes", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const fragment of [
    "BEGIN;", "COMMIT;", "PRIMARY KEY", "FOREIGN KEY", "REFERENCES customers(id)",
    "REFERENCES payments(id)", "REFERENCES vouchers(id)", "UNIQUE (phone)",
    "UNIQUE (code)", "UNIQUE (provider_reference)", "CREATE INDEX IF NOT EXISTS",
  ]) assert.ok(sql.includes(fragment), `missing schema requirement: ${fragment}`);
});

test("legacy state table is not used by the normalized store", async () => {
  const source = await readFile(new URL("../lib/postgres-store.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ndahi_state/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
});
