// Catalog reads only. Names alone cannot prove that the migration's uniqueness
// predicates or index expressions are correct.
export const homeIndexRequirements = Object.freeze([
  { name: "home_active_mac_unique", unique: true, expression: "payload->>'mac'",
    predicate: "kind='home_connection' AND payload->>'status'=ANY(ARRAY['linked','reserved','retiring'])" },
  { name: "home_linked_customer_unique", unique: true, expression: "payload->>'customerId'",
    predicate: "kind='home_connection' AND payload->>'status'='linked'" },
  { name: "home_operations_due", unique: false, expression: "payload->>'nextAttemptAt'",
    predicate: "kind='home_operation'" },
]);

// Normalize PostgreSQL formatting without changing quoted JSON keys or values.
const canonical = value => String(value || "").replace(/'(?:[^']|'')*'|::text\b|[\s()]/g,
  token => token.startsWith("'") ? token : "");

export function evaluateHomeIndexes(rows) {
  const checks = homeIndexRequirements.map(expected => {
    const row = rows.find(row => row.name === expected.name);
    if (!row) return { id: expected.name, status: "missing", reasons: ["index_missing"] };
    const reasons = [];
    if (row.table_name !== "events" || row.method !== "btree") reasons.push("wrong_relation_or_method");
    if (row.is_unique !== expected.unique) reasons.push("wrong_uniqueness");
    if (row.is_valid !== true || row.is_ready !== true) reasons.push("index_not_usable");
    if (Number(row.key_count) !== 1 || Number(row.attribute_count) !== 1) reasons.push("wrong_columns");
    if (canonical(row.expression) !== canonical(expected.expression)) reasons.push("wrong_expression");
    if (canonical(row.predicate) !== canonical(expected.predicate)) reasons.push("wrong_predicate");
    if (row.operator_class !== "text_ops") reasons.push("wrong_operator_class");
    return { id: expected.name, status: reasons.length ? "invalid" : "passed", reasons };
  });
  return { status: checks.every(check => check.status === "passed") ? "ready" : "migration_required",
    migration: "008_ndahi_home.sql", checks };
}

export async function inspectHomeDatabase(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const { rows } = await client.query(`
      SELECT idx.relname AS name, tbl.relname AS table_name, am.amname AS method,
        i.indisunique AS is_unique, i.indisvalid AS is_valid, i.indisready AS is_ready,
        i.indnkeyatts AS key_count, i.indnatts AS attribute_count,
        pg_get_expr(i.indexprs, i.indrelid) AS expression,
        pg_get_expr(i.indpred, i.indrelid) AS predicate, opc.opcname AS operator_class
      FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      JOIN pg_am am ON am.oid = idx.relam
      JOIN pg_opclass opc ON opc.oid = i.indclass[0]
      WHERE ns.nspname = current_schema() AND idx.relname = ANY($1::text[])
    `, [homeIndexRequirements.map(index => index.name)]);
    const result = evaluateHomeIndexes(rows);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
