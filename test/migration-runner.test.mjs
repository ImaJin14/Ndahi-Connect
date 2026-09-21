import test from "node:test";
import assert from "node:assert/strict";
import { applySchemaMigrations } from "../scripts/migrate-postgres.mjs";

test("Render migration runner applies schema in dependency order", async () => {
  const queries = [];
  const files = await applySchemaMigrations({ query: async (sql) => queries.push(sql) });
  assert.deepEqual(files, ["001_ndahi_state.sql", "002_normalized_schema.sql", "003_retention_archives.sql"]);
  assert.match(queries[0], /CREATE TABLE IF NOT EXISTS ndahi_state/);
  assert.match(queries[1], /CREATE TABLE IF NOT EXISTS customers/);
  assert.match(queries[2], /CREATE TABLE IF NOT EXISTS retention_archives/);
});

test("schema failure rolls back and stops before further migrations or data conversion", async () => {
  const queries = [];
  await assert.rejects(applySchemaMigrations({ query: async (sql) => {
    queries.push(sql);
    if (sql.includes("CREATE TABLE IF NOT EXISTS customers")) throw Error("schema failure");
  } }), /schema failure/);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.ok(!queries.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS retention_archives")));
});
