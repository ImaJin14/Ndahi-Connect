import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFile } from "node:fs/promises";
import {
  storeIndexRequirements,
  evaluateStoreIndexes,
  inspectStoreDatabase,
} from "../lib/store-database-readiness.mjs";
import { deployStoreSchema } from "../scripts/deploy-store-schema.mjs";
const row = (expected) => ({
  name: expected.name,
  table_name: "events",
  method: "btree",
  is_unique: true,
  is_valid: true,
  is_ready: true,
  key_count: expected.keys,
  attribute_count: expected.keys,
  expression: expected.expression,
  predicate: expected.predicate,
});
test("store index verification rejects missing and incorrectly defined uniqueness guards", () => {
  const rows = storeIndexRequirements.map(row);
  assert.equal(evaluateStoreIndexes(rows).status, "ready");
  assert.equal(
    evaluateStoreIndexes(rows.slice(1)).status,
    "migration_required",
  );
  for (const change of [
    { is_valid: false },
    { is_unique: false },
    { expression: "payload->>'wrong'" },
    { predicate: "kind='application'" },
    { table_name: "customers" },
    { key_count: 9 },
  ]) {
    const copy = structuredClone(rows);
    Object.assign(copy[0], change);
    assert.equal(evaluateStoreIndexes(copy).checks[0].status, "invalid");
  }
});
test(
  "production store migration is additive, idempotent and refuses unexpected existing definitions",
  { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not set" },
  async () => {
    const schema = "store_deploy_" + process.pid,
      admin = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const client = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await client.connect();
    try {
      await client.query(
        await readFile(
          new URL("../migrations/002_normalized_schema.sql", import.meta.url),
          "utf8",
        ),
      );
      await client.query(
        'INSERT INTO events (kind,id,ordinal,payload) VALUES (\'application\',\'retained\',0,\'{"id":"retained","type":"existing"}\')',
      );
      const before = (await client.query("SELECT kind,id,payload FROM events"))
        .rows;
      assert.equal((await deployStoreSchema(client)).applied, true);
      assert.equal((await inspectStoreDatabase(client)).status, "ready");
      assert.equal((await deployStoreSchema(client)).applied, false);
      assert.deepEqual(
        (await client.query("SELECT kind,id,payload FROM events")).rows,
        before,
      );
      await client.query(
        "DROP INDEX store_product_sku_unique; CREATE INDEX store_product_sku_unique ON events ((payload->>'wrong'))",
      );
      await assert.rejects(
        deployStoreSchema(client),
        (error) => error.code === "STORE_INDEX_REVIEW_REQUIRED",
      );
    } finally {
      await client.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
