// Security regressions for targeted reads (API optimization phase 1). The fast
// paths load only some rows, so they must still: find a session only from its own
// cookie (current or configured previous secret), enforce CSRF on protected posts,
// and never show one customer's payment or bundle to another caller. Runs on the
// in-memory store and, with TEST_DATABASE_URL, on PostgreSQL where rows are selected.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { createHandler, createStore, blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { hashSecret } from "../lib/security.mjs";
import { silentLogger } from "../lib/logger.mjs";

const url = process.env.TEST_DATABASE_URL, schema = `ndahi_targeted_security_${process.pid}`, origin = "http://customer.test";
const now = new Date("2030-06-01T10:00:00Z"), later = (ms) => new Date(+now + ms).toISOString();
const tokens = { a: "a".repeat(43), b: "b".repeat(43), old: "o".repeat(43), expired: "e".repeat(43) };
const keyB = "k".repeat(40);
let admin, pool;

test.before(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    await pool.query(await readFile(new URL(file, directory), "utf8"));
  }
});
test.after(async () => {
  if (!url) return;
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

async function seed(store) {
  const plan = { id: "weekly", name: "Weekly", price: 1000, quotaGb: 5, validityHours: 168, deviceLimit: 1 };
  await store.transaction((s) => {
    s.customers.push({ id: "ca", phone: "670000601", name: "Customer A" }, { id: "cb", phone: "670000602", name: "Customer B" });
    s.payments.push(
      { id: "pa", customerId: "ca", status: "paid", confirmedAt: now.toISOString(), createdAt: now.toISOString(), provider: "mock",
        amount: 1000, currency: "XAF", planId: "weekly", planSnapshot: plan, payerPhone: "670000601", checkoutAudience: "account" },
      { id: "pb", customerId: "cb", status: "pending", creationState: "accepted", createdAt: now.toISOString(), provider: "mock", requestKey: keyB,
        amount: 1000, currency: "XAF", planId: "weekly", planSnapshot: plan, payerPhone: "670000602", checkoutAudience: "guest",
        paymentExpiresAt: later(300000), paymentClosesAt: later(300000) });
    s.vouchers.push(
      { id: "va", customerId: "ca", paymentId: "pa", code: "NC-AAAA-AAAA", planId: "weekly", status: "active", activatedAt: now.toISOString(),
        expiresAt: later(5 * 864e5), quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1 },
      { id: "vb", customerId: "cb", code: "NC-BBBB-BBBB", planId: "weekly", status: "active", activatedAt: now.toISOString(),
        expiresAt: later(5 * 864e5), quotaBytes: 5e9, usedBytes: 2e9, deviceLimit: 1 });
    const session = (id, token, secret, customerId, csrfToken, expiresAt = later(1800000)) => ({ id, tokenHash: hashSecret(token, secret),
      customerId, role: "customer", csrfToken, expiresAt, createdAt: now.toISOString(), lastSeenAt: now.toISOString() });
    s.dashboardSessions.push(session("sa", tokens.a, "current", "ca", "csrf-a"), session("sb", tokens.b, "current", "cb", "csrf-b"),
      session("so", tokens.old, "previous", "ca", "csrf-old"), session("se", tokens.expired, "current", "ca", "csrf-expired", later(-1000)));
  });
}

async function api(t, store, extra = {}) {
  const handler = createHandler({ store, now: () => now, validateConfig: false, logger: silentLogger, env: {
    NODE_ENV: "production", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    CUSTOMER_SESSION_SECRET: "current", ADMIN_SESSION_SECRET: "admin-secret", SECRET_PEPPER: "pepper", SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: origin, BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
    LOG_LEVEL: "silent", STORE_TARGETED_READS: "true", ...extra } });
  const server = await new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, { token, csrf, key, body } = {}) => {
    const response = await fetch(base + path, { method, headers: {
      ...(method === "POST" ? { "content-type": "application/json", origin } : {}),
      ...(token ? { cookie: `customer_session=${token}` } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...(key ? { "x-checkout-key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
}

const stores = [["in-memory store", false, () => createStore({ persistent: false })],
  ["PostgreSQL store (targeted rows)", url ? false : "TEST_DATABASE_URL is not set", async () => {
    await pool.query(`TRUNCATE customers, admin_users, bundles, payments, vouchers, network_sessions,
      dashboard_sessions, admin_sessions, challenges, events, audit_logs, app_settings CASCADE`);
    return createPostgresStore({ pool, initialState: blank });
  }]];

for (const [label, skip, makeStore] of stores) {
  test(`${label}: protected posts need the caller's own session and its CSRF token`, { skip }, async (t) => {
    const store = await makeStore();
    await seed(store);
    const call = await api(t, store), gift = (options) => call("POST", "/api/account/gift/recipient", { body: { phone: "670000699" }, ...options });
    assert.equal((await gift({})).status, 401, "no session");
    assert.equal((await gift({ token: tokens.a })).status, 403, "missing CSRF token");
    assert.equal((await gift({ token: tokens.a, csrf: "csrf-b" })).status, 403, "another session's CSRF token");
    assert.equal((await gift({ token: tokens.expired, csrf: "csrf-expired" })).status, 401, "expired session");
    assert.equal((await gift({ token: tokens.old, csrf: "csrf-old" })).status, 401, "previous secret without rotation configured");
    assert.equal((await gift({ token: "' OR '1'='1", csrf: "csrf-a" })).status, 401, "a quoted cookie value selects nothing");
    assert.equal((await gift({ token: hashSecret(tokens.a, "current"), csrf: "csrf-a" })).status, 401, "the stored hash is not a credential");
    assert.equal((await gift({ token: tokens.a, csrf: "csrf-a" })).status, 200);
    const rotated = await api(t, store, { CUSTOMER_SESSION_SECRET_PREVIOUS: "previous" });
    assert.equal((await rotated("POST", "/api/account/gift/recipient", { token: tokens.old, csrf: "csrf-old", body: { phone: "670000699" } })).status, 200,
      "a session from the previous secret works while rotation is configured");
  });

  test(`${label}: payment status shows a payment only to its owner or its own checkout key`, { skip }, async (t) => {
    const store = await makeStore();
    await seed(store);
    const call = await api(t, store);
    assert.equal((await call("GET", "/api/account/payments/pb/status", { token: tokens.a })).status, 404, "another customer's payment");
    assert.equal((await call("GET", "/api/account/payments/pa/status")).status, 401);
    assert.equal((await call("GET", "/api/payments/pb/status")).status, 404, "the payment ID alone");
    assert.equal((await call("GET", "/api/payments/pb/status", { key: "x".repeat(40) })).status, 404, "a wrong checkout key");
    assert.equal((await call("GET", "/api/payments/pa/status", { key: keyB })).status, 404, "another payment's checkout key");
    const guest = await call("GET", "/api/payments/pb/status", { key: keyB });
    assert.equal(guest.status, 200);
    for (const secret of ["670000601", "NC-AAAA-AAAA", "Customer A", "pa"]) assert.ok(!guest.text.includes(`"${secret}"`), `guest read leaks ${secret}`);
    const own = await call("GET", "/api/account/payments/pa/status", { token: tokens.a });
    assert.equal(own.status, 200);
    assert.equal(own.body.access.code, "NC-AAAA-AAAA");
    assert.ok(!own.text.includes("NC-BBBB-BBBB") && !own.text.includes("670000602"));
  });

  test(`${label}: bundle status returns only the caller's own bundle`, { skip }, async (t) => {
    const store = await makeStore();
    await seed(store);
    const call = await api(t, store);
    const a = await call("GET", "/api/account/bundle-status", { token: tokens.a }), b = await call("GET", "/api/account/bundle-status", { token: tokens.b });
    assert.deepEqual([a.status, a.body.bundle.id, b.status, b.body.bundle.id], [200, "va", 200, "vb"]);
    assert.ok(!a.text.includes('"vb"') && !b.text.includes('"va"'));
    for (const token of [undefined, tokens.expired, tokens.old, "unknown"]) {
      assert.equal((await call("GET", "/api/account/bundle-status", { token })).status, 401, `token ${token}`);
    }
  });
}

test("targeted row filters take values as parameters and refuse unsafe field names", { skip: url ? false : "TEST_DATABASE_URL is not set" }, async () => {
  await pool.query(`TRUNCATE customers, admin_users, bundles, payments, vouchers, network_sessions,
    dashboard_sessions, admin_sessions, challenges, events, audit_logs, app_settings CASCADE`);
  const store = createPostgresStore({ pool, initialState: blank });
  await seed(store);
  for (const value of ["' OR '1'='1", "pa' --", "%", "pa,pb", "{pa,pb}"]) {
    const state = await store.read([{ rows: { payments: { id: [value] }, dashboardSessions: { tokenHash: [value] } } }]);
    assert.deepEqual([state.payments, state.dashboardSessions], [[], []], value);
  }
  for (const field of ["id) OR (1=1", "status'", "a b", "payload->>'x'", ""]) {
    await assert.rejects(store.read([{ rows: { payments: { [field]: ["pa"] } } }]), /Invalid filter field/, field);
  }
  await assert.rejects(store.read([{ rows: { "customers; DROP TABLE payments": true } }]), /Unknown collection/);
  assert.equal((await store.snapshot()).payments.length, 2, "nothing was changed");
});
