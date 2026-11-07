import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blank } from "../lib/api/state.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { runAccountReconciliation } from "../scripts/reconcile-accounts.mjs";

const url = process.env.TEST_DATABASE_URL, skip = url ? false : "TEST_DATABASE_URL is not set";
const schema = `ndahi_reconciliation_${process.pid}`, pepper = "postgres-test-key", now = () => new Date("2030-01-01T00:00:00Z");
let admin, pool, store, dir;
test.before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(f => /^\d+_.+\.sql$/.test(f)).sort())
    await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  store = createPostgresStore({ pool, initialState: blank });
  dir = await mkdtemp(join(tmpdir(), "ndahi-pg-reconcile-"));
});
test.beforeEach(async () => {
  if (skip) return;
  await pool.query("TRUNCATE customers, payments, vouchers, dashboard_sessions, challenges, events, audit_logs CASCADE");
  await store.transaction(s => {
    s.customers.push({ id: "original", phone: "+237670180001", name: "Original", pinHash: "original-hash", createdAt: "2029-01-01T00:00:00Z" },
      { id: "duplicate", phone: "670180001", name: "Different", emailVerificationRequired: true, createdAt: "2029-02-01T00:00:00Z" });
    s.payments.push({ id: "paid", customerId: "duplicate", status: "paid", amount: 1000, payerPhone: "690180002", receipt: { amount: 1000, customerName: "Different" } });
    s.vouchers.push({ id: "voucher", customerId: "duplicate", paymentId: "paid", status: "expired", quotaBytes: 5e9, usedBytes: 42, deviceLimit: 1 });
    s.dashboardSessions.push({ id: "session", customerId: "duplicate", tokenHash: "test-session" });
  });
});
test.after(async () => {
  if (skip) return;
  await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  await rm(dir, { recursive: true, force: true });
});
const report = () => runAccountReconciliation({ store, pepper, now });

test("PostgreSQL merge survives JSONB/reopen and preserves foreign keys, original identity and immutable history", { skip }, async () => {
  const before = await store.snapshot(), r = await report();
  const result = await runAccountReconciliation({ store, pepper, now, apply: true, expectedDigest: r.digest, backupFile: join(dir, "success.json") });
  assert.equal(result.removedCustomerCount, 1);
  const reopened = createPostgresStore({ pool, initialState: blank }), s = await reopened.snapshot();
  assert.deepEqual(s.customers, [{ ...before.customers[0], phone: "670180001" }]);
  assert.deepEqual(s.payments, [{ ...before.payments[0], customerId: "original" }]);
  assert.deepEqual(s.vouchers, [{ ...before.vouchers[0], customerId: "original" }]);
  assert.deepEqual(s.dashboardSessions, []); assert.equal(s.auditLogs.length, 1);
  assert.equal((await report()).repairs.length, 0);
});

test("PostgreSQL backup failure rolls back ownership, account deletion, credential revocation and audit together", { skip }, async () => {
  const before = await store.snapshot(), r = await report();
  await assert.rejects(runAccountReconciliation({ store, pepper, now, apply: true, expectedDigest: r.digest, backupFile: join(dir, "missing", "backup.json") }), { code: "ENOENT" });
  assert.deepEqual(await store.snapshot(), before);
});

test("independent PostgreSQL transactions cannot apply the same reviewed merge twice or overwrite new credentials", { skip }, async () => {
  const other = createPostgresStore({ pool, initialState: blank }), r = await report();
  await other.transaction(s => { s.customers.find(c => c.id === "duplicate").pinHash = "new-owner-proof"; });
  const before = await store.snapshot();
  await assert.rejects(runAccountReconciliation({ store, pepper, now, apply: true, expectedDigest: r.digest, backupFile: join(dir, "stale.json") }), { code: "STALE_RECONCILIATION" });
  assert.deepEqual(await store.snapshot(), before);
  await other.transaction(s => { delete s.customers.find(c => c.id === "duplicate").pinHash; });
  const fresh = await report();
  const results = await Promise.allSettled([store, other].map((target, index) => runAccountReconciliation({ store: target, pepper, now,
    apply: true, expectedDigest: fresh.digest, backupFile: join(dir, `race-${index}.json`) })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "STALE_RECONCILIATION");
  assert.equal((await store.snapshot()).auditLogs.length, 1);
});
