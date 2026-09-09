import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { retentionPolicy, runRetention } from "../lib/retention.mjs";

test("retention policy covers required sensitive record classes", () => {
  assert.deepEqual(retentionPolicy, {
    expiredSessionsDays: 7, expiredChallengesDays: 7, rateLimitEventsDays: 7,
    inactiveNetworkSessionsDays: 90, applicationEventsDays: 365,
    securityEventsDays: 365, auditLogsDays: 730, providerEventsDays: 730,
    paymentsOnlineDays: 2555, dormantCustomerReviewDays: 730,
    operationalArchiveDays: 730, auditAndPaymentArchiveDays: 2555,
  });
});

test("retention job archives before deletion and commits reported counts", async () => {
  const queries = [];
  const client = { query: async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("SELECT COUNT(*)::int AS count")) return { rows: [{ count: 2 }], rowCount: 1 };
    return { rows: [], rowCount: sql.includes("RETURNING 1") ? 2 : 0 };
  } };
  const counts = await runRetention(client, new Date("2026-09-09T02:17:00.000Z"));
  assert.equal(counts.networkSessions, 2);
  assert.equal(counts.securityEvents, 2);
  assert.equal(counts.expiredChallenges, 2);
  assert.equal(queries[0].sql, "BEGIN");
  assert.equal(queries.at(-1).sql, "COMMIT");
  assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO retention_archives")));
  assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO retention_job_runs")));
  assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO retention_reviews")));
});

test("retention failure rolls back atomically", async () => {
  const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (sql.includes("DELETE FROM challenges")) throw new Error("database unavailable");
    return { rows: [], rowCount: 0 };
  } };
  await assert.rejects(runRetention(client), /database unavailable/);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.ok(!queries.includes("COMMIT"));
});

test("Render schedules the retention worker and schema provisions restricted archives", async () => {
  const render = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
  const schema = await readFile(new URL("../migrations/003_retention_archives.sql", import.meta.url), "utf8");
  assert.match(render, /type: cron[\s\S]*name: ndahi-data-retention[\s\S]*schedule: "17 2 \* \* \*"[\s\S]*npm run retention:run/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS retention_archives/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS retention_reviews/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS retention_job_runs/);
});
