import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "../server.mjs";
import { blank } from "../lib/api/state.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { deployAccountReconciliation, openAccountBackup } from "../scripts/deploy-account-reconciliation.mjs";

const url = process.env.TEST_DATABASE_URL, skip = url ? false : "TEST_DATABASE_URL is not set";
const schema = `ndahi_reseller_${process.pid}`, secret = "reseller-postgres-test-secret", token = "reseller-owner-test-token";
const now = () => new Date("2030-01-01T00:00:00Z"), origin = "http://admin.test";
let admin, pool, store;
test.before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url }); await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(f => /^\d+_.+\.sql$/.test(f)).sort())
    await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  store = createPostgresStore({ pool, initialState: blank });
});
test.beforeEach(async () => {
  if (skip) return;
  await pool.query("TRUNCATE customers, admin_users, admin_sessions, payments, vouchers, dashboard_sessions, challenges, events, audit_logs, app_settings CASCADE");
  await store.transaction(s => {
    s.adminUsers.push({ id: "owner", username: "owner", role: "owner", active: true },
      { id: "reseller", username: "reseller", role: "reseller", active: true, commissionPercent: 10 });
    s.adminSessions.push({ id: "session", userId: "owner", tokenHash: hashSecret(token, secret), csrfToken: "csrf", expiresAt: "2031-01-01T00:00:00Z" });
    s.vouchers.push({ id: "sold", code: "NC-PG-RESALE", assignedResellerId: "reseller", planId: "weekly", status: "active",
      activatedAt: "2029-12-31T00:00:00Z", expiresAt: "2031-01-01T00:00:00Z", quotaBytes: 5e9, usedBytes: 0,
      faceValue: 1000, saleAmount: 1000, saleType: "sold", deviceLimit: 1 });
  });
});
test.after(async () => {
  if (skip) return;
  await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});
async function handler(t, target = store) {
  const server = createServer({ store: target, now, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
    BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", PAYMENT_WEBHOOK_WORKER_ENABLED: "false",
    SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret, ADMIN_APP_URL: origin, ALLOWED_ADMIN_ORIGINS: origin } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (path, input) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: input ? "POST" : "GET",
      headers: { origin, cookie: `admin_session=${token}`, "content-type": "application/json", "x-csrf-token": "csrf" },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  };
}

test("PostgreSQL independent handlers deduplicate concurrent cash retries and retain the receipt after reopen", { skip }, async t => {
  const other = createPostgresStore({ pool, initialState: blank }), a = await handler(t), b = await handler(t, other);
  const input = { resellerId: "reseller", amount: 300, note: "One actual handoff", operationKey: randomUUID() };
  const results = await Promise.all([a, b].map(call => call("/api/admin/resellers/remittances", input)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  const reopened = createPostgresStore({ pool, initialState: blank }), s = await reopened.snapshot();
  assert.equal(s.adminUsers.find(u => u.id === "reseller").remittances.length, 1);
  assert.equal(s.auditLogs.filter(a => a.action === "reseller.remittance_recorded").length, 1);
  assert.equal((await b("/api/admin/resellers/remittances", { ...input, amount: 301 })).status, 409);
  const beforeVersion = (await pool.query("SELECT xmin::text AS version FROM vouchers WHERE id='sold'")).rows[0].version;
  await a("/api/admin/resellers/ledger");
  assert.equal((await pool.query("SELECT xmin::text AS version FROM vouchers WHERE id='sold'")).rows[0].version, beforeVersion, "read-only ledger cannot snapshot voucher terms");
});

test("PostgreSQL deployment reconciliation stores encrypted before-images and a single durable marker across competing workers", { skip }, async () => {
  await store.transaction(s => {
    s.customers.push({ id: "first", phone: "+237670180001", name: "Original", pinHash: "original-proof", createdAt: "2029-01-01T00:00:00Z" },
      { id: "later", phone: "670180001", name: "Later", emailVerificationRequired: true, createdAt: "2029-02-01T00:00:00Z" });
    s.payments.push({ id: "paid", customerId: "later", status: "paid", amount: 1000 });
    s.vouchers.push({ id: "historical", customerId: "later", paymentId: "paid", status: "expired", usedBytes: 25 });
  });
  const other = createPostgresStore({ pool, initialState: blank });
  const results = await Promise.all([store, other].map(target => deployAccountReconciliation({ store: target, pepper: secret, now })));
  assert.equal(results.filter(r => r.alreadyApplied).length, 1);
  const s = await other.snapshot();
  assert.equal(s.customers.length, 1); assert.equal(s.payments[0].customerId, "first");
  assert.equal(s.zone.accountReconciliation.summary.status, "complete");
  const backup = openAccountBackup(s.zone.accountReconciliation.backup, secret);
  assert.equal(backup.collections.payments.before[0].customerId, "later");
  assert.equal(s.auditLogs.filter(a => a.action === "customer.reconciliation_inventory_completed").length, 1);
});
