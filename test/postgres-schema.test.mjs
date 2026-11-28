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
  assert.equal(normalizedCollections.length, 44);
  // The rewards points ledger (#526), in the events table: no new table.
  assert.deepEqual(normalizedCollections.find((c) => c.stateKey === "pointsLedger"), { stateKey: "pointsLedger", table: "events", kind: "points_ledger" });
  assert.deepEqual(normalizedCollections.find((c) => c.stateKey === "referrals"), { stateKey: "referrals", table: "events", kind: "referral" });
  // Store kits (#424), in the events table like the other store records.
  assert.deepEqual(normalizedCollections.find((c) => c.stateKey === "storeKits"), { stateKey: "storeKits", table: "events", kind: "store_kit" });
  // Insights aggregates (#262).
  assert.deepEqual(normalizedCollections.find((c) => c.stateKey === "insightCounters"), { stateKey: "insightCounters", table: "events", kind: "insight_counter" });
  // Staff messages to customers (#257).
  assert.deepEqual(normalizedCollections.find((c) => c.stateKey === "customerMessages"),
    { stateKey: "customerMessages", table: "events", kind: "customer_message" });
  // Outage notices (#259).
  assert.deepEqual(normalizedCollections.find((c) => c.stateKey === "outages"), { stateKey: "outages", table: "events", kind: "outage" });
  assert.deepEqual(normalizedCollections.find((c) => c.stateKey === "wifiDeviceGrants"),
    { stateKey: "wifiDeviceGrants", table: "challenges", kind: "wifi_device_grant" });
  assert.deepEqual(normalizedCollections.find((c) => c.stateKey === "notificationStates"),
    { stateKey: "notificationStates", table: "events", kind: "notification_state" });
  assert.deepEqual(normalizedCollections.find((c) => c.stateKey === "wifiPairingRequests"),
    { stateKey: "wifiPairingRequests", table: "challenges", kind: "wifi_pairing" });
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
