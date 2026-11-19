// Measures API request cost against PostgreSQL as stored data grows, with
// targeted reads on and off (STORE_TARGETED_READS), in one run.
//
//   BENCH_DATABASE_URL=postgres://… node scripts/benchmark-api-reads.mjs [--scales=100x3,300x8] [--modes=off,on] [--out=file.json]
//
// It works only inside its own new schema, which it drops at the end, so any
// disposable or development database will do. Never point it at production: it
// loads synthetic customers and runs the billing worker against them. Synthetic
// records are cloned from the shapes the real purchase flow produces (mock
// provider, no network calls). The load generator shares the process with the
// API, so absolute numbers are local; compare the on/off columns and the growth.
import http from "node:http";
import { writeFile, readdir, readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { createHandler, blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { hashSecret } from "../lib/security.mjs";
import { silentLogger } from "../lib/logger.mjs";

const url = process.env.BENCH_DATABASE_URL;
if (!url) { console.error("Set BENCH_DATABASE_URL to a disposable PostgreSQL database."); process.exit(2); }
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const scales = arg("scales", "100x3,300x8,600x20,1000x40").split(",").map((s) => s.split("x").map(Number));
const modes = arg("modes", "off,on").split(",").filter((mode) => ["off", "on"].includes(mode));
const secret = "benchmark-secret", schema = `ndahi_bench_${process.pid}`, origin = "http://customer.bench";
const env = (extra) => ({ NODE_ENV: "production", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  SECRET_PEPPER: secret, CUSTOMER_SESSION_SECRET: secret, ADMIN_SESSION_SECRET: secret, SESSION_COOKIE_SECURE: "false",
  CUSTOMER_APP_URL: origin, ADMIN_APP_URL: "http://admin.bench", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false",
  SECURITY_ALERTS_ENABLED: "false", PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", LOG_LEVEL: "silent", ...extra });
const round = (x) => Math.round(x * 10) / 10;
const stats = (values) => {
  const v = [...values].sort((a, b) => a - b), at = (q) => v[Math.min(v.length - 1, Math.floor(v.length * q))];
  return { n: v.length, median: round(at(0.5)), p95: round(at(0.95)), max: round(v.at(-1)) };
};

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
const servers = [];
async function serve(handler) {
  const server = await new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, { cookie, body, headers = {}, from = origin } = {}) => {
    const started = performance.now();
    const response = await fetch(base + path, { method, headers: { ...(method === "POST" ? { "content-type": "application/json", origin: from } : {}),
      ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, ms: performance.now() - started, bytes: text.length };
  };
}

try {
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    await pool.query(await readFile(new URL(file, directory), "utf8"));
  }
  const store = createPostgresStore({ pool, initialState: blank });
  const handlers = { on: createHandler({ store, validateConfig: false, logger: silentLogger, env: env({ STORE_TARGETED_READS: "true" }) }),
    off: createHandler({ store, validateConfig: false, logger: silentLogger, env: env({ STORE_TARGETED_READS: "false" }) }) };
  const call = { on: await serve(handlers.on), off: await serve(handlers.off) };
  // Record shapes from the real flow: a guest purchase, mock confirmation and voucher sign-in.
  const setup = await serve(createHandler({ store, validateConfig: false, logger: silentLogger, env: env({ NODE_ENV: "test" }) }));
  const bought = await setup("POST", "/api/purchase", { body: { phone: "670000001", name: "Template", planId: "weekly", requestKey: "t".repeat(40) } });
  if (bought.status !== 201) throw Error("template purchase failed");
  const template = await store.snapshot();
  await setup("POST", `/api/payments/${template.payments[0].id}/confirm`, { body: {} });
  const confirmed = await store.snapshot(), voucher = confirmed.vouchers[0];
  await setup("POST", "/api/vouchers/redeem", { body: { phone: "670000001", deviceId: "template", code: voucher.code } });
  const t = await store.snapshot();
  const shapes = { customer: t.customers[0], payment: t.payments[0], voucher: t.vouchers[0], session: t.sessions[0] };

  const results = [];
  for (const [customers, perCustomer] of scales) {
    const fixture = build(shapes, customers, perCustomer);
    await load(pool, fixture.state);
    const size = (await pool.query(`SELECT (SELECT count(*) FROM payments)::int AS payments, (SELECT count(*) FROM vouchers)::int AS vouchers,
      (SELECT count(*) FROM events)::int AS events, pg_database_size(current_database())::bigint AS bytes`)).rows[0];
    const signedIn = fixture.sessions[Math.floor(fixture.sessions.length / 2)];
    const cookie = `customer_session=${signedIn.token}`, payment = fixture.state.payments.find((p) => p.customerId === signedIn.customerId);
    const routes = [
      ["GET /api/plans", "GET", "/api/plans", {}],
      ["GET /api/status", "GET", "/api/status", {}],
      ["GET /api/account/bundle-status (Home poll)", "GET", "/api/account/bundle-status", { cookie }],
      ["GET /api/account/payments/:id/status (checkout poll)", "GET", `/api/account/payments/${payment.id}/status`, { cookie }],
      ["POST /api/account/gift/recipient (CSRF check + write)", "POST", "/api/account/gift/recipient", { cookie, body: { phone: "650099999" }, headers: { "x-csrf-token": signedIn.csrf } }],
      ["GET /api/account/dashboard (not yet targeted)", "GET", "/api/account/dashboard", { cookie }],
    ];
    const n = size.payments > 20000 ? 6 : size.payments > 5000 ? 10 : 20;
    const row = { customers, perCustomer, payments: size.payments, vouchers: size.vouchers, events: size.events, databaseMB: round(Number(size.bytes) / 1e6), routes: {} };
    for (const [name, method, path, options] of routes) {
      row.routes[name] = {};
      for (const mode of modes) {
        await call[mode](method, path, options);
        const times = [];
        let status;
        for (let i = 0; i < n; i++) { const r = await call[mode](method, path, options); times.push(r.ms); status = r.status; }
        row.routes[name][mode] = { status, ...stats(times) };
      }
    }
    // 16 different signed-in customers polling Home at the same moment.
    row.concurrent = {};
    for (const mode of modes) {
      const started = performance.now();
      const each = await Promise.all(fixture.sessions.slice(0, 16).map((s) => call[mode]("GET", "/api/account/bundle-status", { cookie: `customer_session=${s.token}` })));
      row.concurrent[mode] = { wallMs: round(performance.now() - started), ...stats(each.map((r) => r.ms)) };
    }
    // One billing worker pass: up to 25 payments whose receipt email is not sent.
    row.billingRun = {};
    for (const mode of modes) {
      const before = store.stats.committed, started = performance.now();
      await handlers[mode].billing.run();
      row.billingRun[mode] = { ms: round(performance.now() - started), transactions: store.stats.committed - before };
    }
    results.push(row);
    console.log(`\n${customers} customers x ${perCustomer} bundles: ${size.payments} payments, ${size.events} event rows, ${row.databaseMB} MB`);
    console.table(Object.fromEntries(Object.entries(row.routes).map(([name, v]) => [name,
      Object.fromEntries(modes.flatMap((mode) => [[`${mode} median`, v[mode].median], [`${mode} p95`, v[mode].p95], [`${mode} status`, v[mode].status]]))])));
    console.table({ "16 concurrent Home polls (wall ms)": Object.fromEntries(modes.map((mode) => [mode, row.concurrent[mode].wallMs])),
      "billing worker pass (ms)": Object.fromEntries(modes.map((mode) => [mode, row.billingRun[mode].ms])) });
  }
  const out = arg("out");
  if (out) await writeFile(out, JSON.stringify({ node: process.version, measuredAt: new Date().toISOString(), results }, null, 1));
} finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}

// Synthetic data: every customer has `perCustomer` bundles (a third have one
// active), a provider webhook per payment and the router jobs kept for 90 days;
// a sixth are signed in. Shapes come from the real flow above.
function build(shapes, count, perCustomer) {
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString(), state = {
    customers: [], payments: [], vouchers: [], sessions: [], dashboardSessions: [], providerEvents: [], routerCommands: [], events: [] };
  const sessions = [];
  const symbols = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let seq = 1;
  const code = () => { let n = seq++, out = ""; for (let i = 0; i < 8; i++) { out = symbols[n % 31] + out; n = Math.floor(n / 31); } return `NC-${out.slice(0, 4)}-${out.slice(4)}`; };
  for (let i = 0; i < count; i++) {
    const customerId = randomUUID(), phone = String(650000000 + i);
    state.customers.push({ ...structuredClone(shapes.customer), id: customerId, phone, name: `Customer ${i}`, email: `c${i}@example.test`, createdAt: iso(now - 864e5 * 30) });
    for (let k = 0; k < perCustomer; k++) {
      const paymentId = randomUUID(), voucherId = randomUUID(), active = k === 0 && i % 3 === 0;
      const created = now - (active ? 36e5 : 864e5 * (8 + k * 8));
      state.payments.push({ ...structuredClone(shapes.payment), id: paymentId, customerId, payerPhone: phone, providerReference: `mock-${randomUUID()}`,
        requestKey: randomUUID() + randomUUID(), createdAt: iso(created), confirmedAt: iso(created + 20000) });
      state.vouchers.push({ ...structuredClone(shapes.voucher), id: voucherId, paymentId, customerId, code: code(), status: active ? "active" : "expired",
        activatedAt: iso(created + 20000), expiresAt: iso(active ? now + 864e5 * 5 : created + 864e5 * 7), routerSyncStatus: "synced" });
      if (k < 2) state.sessions.push({ ...structuredClone(shapes.session), id: randomUUID(), voucherId, status: "inactive", lastSeenAt: iso(created + 72e5) });
      if (k < 4) for (const action of ["sync_voucher", "disconnect_voucher"]) state.routerCommands.push({ id: `router:${action}:${voucherId}`,
        kind: "router_command", action, targetId: voucherId, status: "processed", attempts: 1, at: iso(created + 21000), processedAt: iso(created + 26000) });
      state.providerEvents.push({ id: `webhook:mesomb:${createHash("sha256").update(paymentId).digest("hex")}`, kind: "payment_webhook", provider: "mesomb",
        payload: { paymentId, transactionId: randomUUID(), type: "payment.transaction.success" }, status: "processed", attempts: 1, at: iso(created + 19000) });
    }
    if (i % 6 === 0) {
      const token = randomUUID() + randomUUID(), csrf = randomUUID();
      sessions.push({ token, customerId, csrf });
      state.dashboardSessions.push({ id: randomUUID(), tokenHash: hashSecret(token, secret), customerId, role: "customer", csrfToken: csrf,
        expiresAt: iso(now + 864e5), createdAt: iso(now), lastSeenAt: iso(now) });
    }
  }
  for (let i = 0; i < 500; i++) state.events.push({ id: randomUUID(), type: "voucher.activated", meta: {}, at: iso(now - i * 6e4) });
  return { state, sessions };
}

async function load(pool, state) {
  await pool.query("TRUNCATE network_sessions, dashboard_sessions, admin_sessions, challenges, vouchers, payments, events, audit_logs, bundles, admin_users, customers, app_settings");
  const tables = { customers: ["customers"], payments: ["payments"], vouchers: ["vouchers"], sessions: ["network_sessions"], dashboardSessions: ["dashboard_sessions"],
    providerEvents: ["events", "provider"], routerCommands: ["events", "router_command"], events: ["events", "application"] };
  for (const [key, [table, kind]] of Object.entries(tables)) {
    const rows = state[key].map((item, ordinal) => ({ id: String(item.id), ordinal, next: item }));
    for (let at = 0; at < rows.length; at += 4000) {
      const chunk = JSON.stringify(rows.slice(at, at + 4000));
      await pool.query(kind
        ? `INSERT INTO ${table} (kind, id, ordinal, payload) SELECT $2, i.id, i.ordinal, i.next FROM jsonb_to_recordset($1::jsonb) AS i(id text, ordinal integer, next jsonb)`
        : `INSERT INTO ${table} (id, ordinal, payload) SELECT i.id, i.ordinal, i.next FROM jsonb_to_recordset($1::jsonb) AS i(id text, ordinal integer, next jsonb)`,
      kind ? [chunk, kind] : [chunk]);
    }
  }
  await pool.query("ANALYZE");
}
