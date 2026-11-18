// API optimization phase 1: the polled and public routes read only the rows they
// use. On one PostgreSQL database, with the clock frozen, every response must
// match the original full-state path (STORE_TARGETED_READS=false), and lifecycle
// housekeeping must still happen when a poll touches an expired bundle.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { createHandler, createServer, createStore, blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { hashSecret } from "../lib/security.mjs";
import { silentLogger } from "../lib/logger.mjs";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL is not set";
const schema = `ndahi_targeted_${process.pid}`;
const secret = "targeted-reads-secret", origin = "http://customer.test";
let admin, pool;

test.before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 20 });
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    await pool.query(await readFile(new URL(file, directory), "utf8"));
  }
});
test.after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

const env = (extra) => ({
  NODE_ENV: "production", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  SECRET_PEPPER: secret, CUSTOMER_SESSION_SECRET: secret, ADMIN_SESSION_SECRET: secret, SESSION_COOKIE_SECURE: "false",
  CUSTOMER_APP_URL: origin, BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
  PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", LOG_LEVEL: "silent", ...extra,
});
async function serve(handler, t) {
  const server = await new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, { cookie, body, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(method === "POST" ? { "content-type": "application/json", origin } : {}),
      ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
}

test("targeted routes answer exactly as the full-state routes", { skip }, async (t) => {
  let now = new Date("2030-03-01T10:00:00Z");
  const clock = () => now, store = createPostgresStore({ pool, initialState: blank });
  t.after(() => pool.query(`TRUNCATE customers, admin_users, bundles, payments, vouchers, network_sessions,
    dashboard_sessions, admin_sessions, challenges, events, audit_logs, app_settings CASCADE`));
  const handlers = Object.fromEntries(["true", "false"].map((value) => [value, createHandler({ store, now: clock, validateConfig: false,
    logger: silentLogger, env: env({ STORE_TARGETED_READS: value }) })]));
  const targeted = await serve(handlers.true, t), full = await serve(handlers.false, t);
  // Real flows build the records: a paid, redeemed bundle and a guest's open checkout.
  const setup = await serve(createHandler({ store, now: clock, validateConfig: false, logger: silentLogger, env: env({ NODE_ENV: "test" }) }), t);
  const bought = await setup("POST", "/api/purchase", { body: { phone: "670000201", name: "Paid Customer", planId: "weekly", requestKey: "a".repeat(40) } });
  assert.equal(bought.status, 201);
  const paid = await setup("POST", `/api/payments/${bought.body.payment.id}/confirm`, { body: {} });
  assert.equal(paid.status, 200);
  assert.ok((await setup("POST", "/api/vouchers/redeem", { body: { phone: "670000201", deviceId: "device-1", code: paid.body.access.code } })).status < 400);
  const pendingKey = "b".repeat(40);
  const pending = await setup("POST", "/api/purchase", { body: { phone: "670000202", name: "Guest", planId: "daily", requestKey: pendingKey } });
  assert.equal(pending.status, 201);
  const token = "c".repeat(43), csrf = "csrf-token-value";
  await store.transaction((s) => {
    const customer = s.customers.find((c) => c.phone === "670000201");
    s.dashboardSessions.push({ id: "session-1", tokenHash: hashSecret(token, secret), customerId: customer.id, role: "customer", csrfToken: csrf,
      expiresAt: new Date(+now + 1800000).toISOString(), createdAt: now.toISOString(), lastSeenAt: now.toISOString() });
    s.bundles.push({ id: "custom-1", name: "Custom", price: 700, quotaGb: 3, validityHours: 72, deviceLimit: 1 });
    s.zone = { id: "ndahi-wisp-main", status: "online", notes: "Planned works tonight" };
  });
  const cookie = `customer_session=${token}`;
  const requests = [
    ["GET", "/api/plans"],
    ["GET", "/api/status"],
    ["GET", "/api/account/bundle-status", { cookie }],
    ["GET", "/api/account/bundle-status"],
    ["GET", "/api/account/bundle-status", { cookie: "customer_session=unknown" }],
    ["GET", `/api/account/payments/${bought.body.payment.id}/status`, { cookie }],
    ["GET", `/api/payments/${bought.body.payment.id}/status`, { cookie }],
    ["GET", `/api/account/payments/${pending.body.payment.id}/status`, { cookie }],
    ["GET", `/api/payments/${pending.body.payment.id}/status`, { headers: { "x-checkout-key": pendingKey } }],
    ["GET", `/api/payments/${pending.body.payment.id}/status`],
    ["POST", "/api/account/gift/recipient", { cookie, body: { phone: "670000209" }, headers: { "x-csrf-token": "wrong" } }],
    ["POST", "/api/account/gift/recipient", { body: { phone: "670000209" }, headers: { "x-csrf-token": csrf } }],
  ];
  for (const [method, path, options] of requests) {
    const expected = await full(method, path, options), actual = await targeted(method, path, options);
    assert.deepEqual(actual, expected, `${method} ${path} ${JSON.stringify(options || {})}`);
  }
  // The CSRF check accepts the right token from the session it loaded.
  assert.equal((await targeted("POST", "/api/account/gift/recipient", { cookie, body: { phone: "670000209" }, headers: { "x-csrf-token": csrf } })).status, 200);
  assert.ok(store.stats.targeted > 0, "targeted transactions ran");
  assert.equal(store.stats.fullFallbacks, 0, "no request needed the full state");

  // Two days later the bundle has expired. A poll that touches it still records
  // the expiry and queues the router disconnect, as the full-state path does.
  now = new Date(+now + 8 * 86400000);
  await store.transaction((s) => { s.dashboardSessions[0].expiresAt = new Date(+now + 1800000).toISOString(); });
  const status = await targeted("GET", "/api/account/bundle-status", { cookie });
  assert.equal(status.status, 200);
  assert.equal(status.body.bundle.status, "expired");
  const state = await store.snapshot(), voucher = state.vouchers.find((v) => v.paymentId === bought.body.payment.id);
  assert.equal(voucher.status, "expired");
  assert.ok(state.routerCommands.some((c) => c.id === `router:disconnect_voucher:${voucher.id}` && c.status === "queued"));
  assert.ok(store.stats.fullFallbacks >= 1, "the expiry write reran on the full state");
});

test("the housekeeping worker expires bundles without any request", async () => {
  let now = new Date("2030-03-01T10:00:00Z");
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c", phone: "670000301" });
    s.vouchers.push({ id: "v", customerId: "c", status: "active", expiresAt: new Date(+now + 60000).toISOString(), quotaBytes: null, usedBytes: 0 });
  });
  const server = createServer({ store, now: () => now, validateConfig: false, logger: silentLogger, env: env({ NODE_ENV: "test", STORE_TARGETED_READS: "true" }) });
  const handler = server.listeners("request")[0];
  assert.equal(handler.housekeepingEnabled, true);
  assert.equal(handler.housekeepingIntervalMs, 30000);
  now = new Date(+now + 120000);
  await handler.housekeeping();
  const state = await store.snapshot();
  assert.equal(state.vouchers[0].status, "expired");
  assert.ok(state.routerCommands.some((c) => c.id === "router:disconnect_voucher:v"));
  const off = createServer({ store, validateConfig: false, logger: silentLogger, env: env({ NODE_ENV: "test", STORE_TARGETED_READS: "false" }) });
  assert.equal(off.listeners("request")[0].housekeepingEnabled, false, "the switch restores the original behaviour");
});
