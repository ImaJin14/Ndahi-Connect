import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHomeIndexes, homeIndexRequirements, inspectHomeDatabase } from "../lib/home-database-readiness.mjs";
import { checkHomeDatabase } from "../scripts/check-home-database.mjs";

const rows = () => homeIndexRequirements.map(index => ({ name: index.name,
  table_name: "events", method: "btree", is_unique: index.unique,
  is_valid: true, is_ready: true, key_count: 1, attribute_count: 1,
  expression: index.expression, predicate: index.predicate, operator_class: "text_ops" }));

test("Home readiness requires all three usable index definitions, not just matching names", () => {
  assert.equal(evaluateHomeIndexes(rows()).status, "ready");
  for (const change of [r => r.splice(0, 1), r => { r[0].is_unique = false; },
    r => { r[0].predicate = "kind='home_connection' AND payload->>'status'='linked'"; },
    r => { r[1].expression = "payload->>'otherCustomer'"; },
    r => { r[0].expression = "payload->>'ma c'"; },
    r => { r[0].predicate = r[0].predicate.replace("'linked'", "'lin ked'"); },
    r => { r[0].predicate = r[0].predicate.replace("'linked'", "'lin(ked)'"); },
    r => { r[1].is_valid = false; }, r => { r[2].is_ready = false; },
    r => { r[2].table_name = "challenges"; }, r => { r[2].attribute_count = 2; },
    r => { r[0].operator_class = "text_pattern_ops"; }]) {
    const broken = rows(); change(broken);
    const report = evaluateHomeIndexes(broken);
    assert.equal(report.status, "migration_required");
    assert.ok(report.checks.some(check => check.status !== "passed"));
  }
});

test("Home catalog inspection owns a read-only transaction and rolls back errors", async () => {
  const calls = [];
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: rows() }; } };
  assert.equal((await inspectHomeDatabase(client)).status, "ready");
  assert.equal(calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.deepEqual(calls[1].params, [homeIndexRequirements.map(index => index.name)]);
  assert.equal(calls.at(-1).sql, "COMMIT");
  assert.equal(calls.some(call => /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/.test(call.sql)), false);
  calls.length = 0;
  const failed = { async query(sql) { calls.push({ sql }); if (sql.includes("FROM pg_index")) throw Error("private driver detail"); } };
  await assert.rejects(inspectHomeDatabase(failed));
  assert.equal(calls.at(-1).sql, "ROLLBACK");
  assert.deepEqual(await checkHomeDatabase({}), { status: "unavailable", code: "DATABASE_URL_MISSING" });
});
