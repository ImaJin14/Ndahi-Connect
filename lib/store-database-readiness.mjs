// Verify expressions and predicates, not merely index names, before store startup.
export const storeIndexRequirements = Object.freeze([
  {
    name: "store_product_sku_unique",
    expression: "lower(payload->>'sku')",
    predicate: "kind='store_product'",
    keys: 1,
  },
  {
    name: "store_order_checkout_unique",
    expression: "payload->>'checkoutKeyHash'",
    predicate: "kind='store_order'",
    keys: 1,
  },
  {
    name: "store_payment_id_unique",
    expression: "payload->'payment'->>'id'",
    predicate: "kind='store_order'",
    keys: 1,
  },
  {
    name: "store_payment_provider_reference_unique",
    expression:
      "payload->'payment'->>'provider',payload->'payment'->>'providerReference'",
    predicate:
      "kind='store_order' AND payload->'payment'->>'providerReference' IS NOT NULL",
    keys: 2,
  },
  {
    name: "store_operation_key_unique",
    expression: "payload->>'key'",
    predicate: "kind='store_operation'",
    keys: 1,
  },
]);
const canonical = (value) =>
  String(value || "").replace(/'(?:[^']|'')*'|::text\b|[\s()]/g, (token) =>
    token.startsWith("'") ? token : "",
  );
export function evaluateStoreIndexes(rows) {
  const checks = storeIndexRequirements.map((expected) => {
    const row = rows.find((row) => row.name === expected.name);
    if (!row) return { id: expected.name, status: "missing" };
    const passed =
      row.table_name === "events" &&
      row.method === "btree" &&
      row.is_unique === true &&
      row.is_valid === true &&
      row.is_ready === true &&
      Number(row.key_count) === expected.keys &&
      Number(row.attribute_count) === expected.keys &&
      canonical(row.expression) === canonical(expected.expression) &&
      canonical(row.predicate) === canonical(expected.predicate);
    return { id: expected.name, status: passed ? "passed" : "invalid" };
  });
  return {
    status: checks.every((check) => check.status === "passed")
      ? "ready"
      : "migration_required",
    migration: "010_device_store.sql",
    checks,
  };
}
export async function inspectStoreDatabase(client) {
  const { rows } = await client.query(
    `
    SELECT idx.relname AS name, tbl.relname AS table_name, am.amname AS method,
      i.indisunique AS is_unique, i.indisvalid AS is_valid, i.indisready AS is_ready,
      i.indnkeyatts AS key_count, i.indnatts AS attribute_count,
      pg_get_expr(i.indexprs, i.indrelid) AS expression,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_am am ON am.oid = idx.relam
    WHERE ns.nspname = current_schema() AND idx.relname = ANY($1::text[])
  `,
    [storeIndexRequirements.map((index) => index.name)],
  );
  return evaluateStoreIndexes(rows);
}
