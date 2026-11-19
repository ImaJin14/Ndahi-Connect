import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createServer } from "../server.mjs";
import { blank } from "../lib/api/state.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL is not set";
const schema = `ndahi_reseller_home_${process.pid}`;
const secret = "reseller-home-postgres-secret";
const origin = "http://admin.test";
const tokens = { reseller: "reseller-session-token", other: "other-session-token", owner: "owner-session-token" };
const now = () => new Date("2030-01-01T00:00:00Z");
let admin, pool, store;

test.before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  store = createPostgresStore({ pool, initialState: blank });
});

test.beforeEach(async () => {
  if (skip) return;
  await pool.query("TRUNCATE customers, admin_users, admin_sessions, payments, vouchers, dashboard_sessions, challenges, events, audit_logs, app_settings CASCADE");
  await store.transaction(s => {
    for (const [id, role] of [["reseller", "reseller"], ["other", "reseller"], ["owner", "owner"]]) {
      s.adminUsers.push({ id, username: id, role, active: true, commissionPercent: 10 });
      s.adminSessions.push({ id: `session-${id}`, userId: id, tokenHash: hashSecret(tokens[id], secret), csrfToken: "csrf", expiresAt: "2031-01-01T00:00:00Z" });
    }
    for (const [id, assignedResellerId] of [["stock", "reseller"], ["other-stock", "other"]]) {
      s.vouchers.push({ id, code: `NC-PG-${id.toUpperCase()}`, assignedResellerId, planId: "weekly", status: "available", faceValue: 1000, saleType: "sold", deviceLimit: 1 });
    }
  });
});

test.after(async () => {
  if (skip) return;
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

async function handler(t, target) {
  const server = createServer({ store: target, now, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", PAYMENT_WEBHOOK_WORKER_ENABLED: "false", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret, ADMIN_APP_URL: origin, ALLOWED_ADMIN_ORIGINS: origin } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (role, path, input) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: input ? "POST" : "GET", headers: { origin, cookie: `admin_session=${tokens[role]}`, "content-type": "application/json", "x-csrf-token": "csrf" }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  };
}

test("PostgreSQL persists one cash sale across concurrent authenticated retries and reopened stores", { skip }, async t => {
  const other = createPostgresStore({ pool, initialState: blank });
  const a = await handler(t, store), b = await handler(t, other);
  const path = "/api/admin/resellers/cash-sale";
  const input = { voucherId: "stock", operationKey: randomUUID() };
  assert.equal((await a("owner", path, input)).status, 403);
  assert.equal((await a("other", path, input)).status, 404);
  const results = await Promise.all([a, b].map(call => call("reseller", path, input)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal(results.filter(r => r.body.replayed).length, 1);
  assert.equal(results[0].body.sale.id, results[1].body.sale.id);
  assert.equal(results[0].body.sale.amount, 1000);
  assert.equal((await b("reseller", path, { voucherId: "stock", operationKey: randomUUID() })).status, 409);
  const reopened = createPostgresStore({ pool, initialState: blank });
  const snapshot = await reopened.snapshot();
  const voucher = snapshot.vouchers.find(v => v.id === "stock");
  assert.equal(voucher.status, "available");
  assert.equal(voucher.cashSale.operationKey, input.operationKey);
  assert.equal(voucher.cashSale.resellerId, "reseller");
  assert.equal(snapshot.auditLogs.filter(a => a.action === "reseller.cash_sale_recorded").length, 1);
  const home = await b("reseller", "/api/admin/resellers/ledger?view=home");
  assert.equal(home.status, 200);
  assert.equal(home.body.reseller.cashCollected, 1000);
  assert.equal(home.body.stock.some(v => v.id === "stock"), false);
});

test("PostgreSQL persists one stock request across retries and limits owner review", { skip }, async t => {
  const other = createPostgresStore({ pool, initialState: blank });
  const a = await handler(t, store), b = await handler(t, other);
  const path = "/api/admin/resellers/stock-requests", input = { operationKey: randomUUID() };
  assert.equal((await a("owner", path, input)).status, 403);
  const results = await Promise.all([a, b].map(call => call("reseller", path, input)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal(results.filter(r => r.body.replayed).length, 1);
  assert.equal(results[0].body.request.id, results[1].body.request.id);
  assert.equal((await b("other", path, input)).status, 409);
  assert.equal((await b("reseller", "/api/admin/resellers/ledger?view=stock-requests")).status, 403);
  const owner = await b("owner", "/api/admin/resellers/ledger?view=stock-requests");
  assert.equal(owner.status, 200);
  assert.equal(owner.body.requests.length, 1);
  assert.equal(owner.body.requests[0].resellerId, "reseller");
  const reopened = createPostgresStore({ pool, initialState: blank });
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.adminUsers.find(u => u.id === "reseller").stockRequests.length, 1);
  assert.equal(snapshot.auditLogs.filter(a => a.action === "reseller.stock_requested").length, 1);
});
