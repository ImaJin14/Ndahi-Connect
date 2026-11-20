// Insights recording (#262) on PostgreSQL: concurrent funnel beacons update
// one aggregate row through targeted, scoped writes without losing a count,
// the router usage sync records its sample, and the owner reads both back.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { createServer } from "../server.mjs";
import { blank } from "../lib/api/state.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { createRouterCommandProcessor, enqueueRouterCommand } from "../lib/router-queue.mjs";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL is not set";
const schema = `ndahi_insights_${process.pid}`;
const secret = "insights-postgres-secret", portal = "http://portal.test", adminOrigin = "http://admin.test";
const now = () => new Date("2026-11-20T18:30:00Z"); // 19:30 in Douala
let admin, pool, store;

test.before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => /^\d+_.+\.sql$/.test(f)).sort())
    await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  store = createPostgresStore({ pool, initialState: blank });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "owner", username: "owner", role: "owner", active: true });
    s.adminSessions.push({ id: "session-owner", userId: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2031-01-01T00:00:00Z" });
    s.customers.push({ id: "c1", phone: "670000001", name: "Synthetic customer", status: "active", createdAt: "2026-11-01T00:00:00Z" });
    s.vouchers.push({ id: "v1", customerId: "c1", planId: "weekly", code: "NC-PG-0001", status: "active", activatedAt: "2026-11-20T10:00:00Z",
      expiresAt: "2026-11-27T10:00:00Z", quotaBytes: 5e9, usedBytes: 0, deviceLimit: 3 });
  });
});

test.after(async () => {
  if (skip) return;
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

test("funnel beacons and usage samples are recorded on PostgreSQL and read by the owner", { skip }, async (t) => {
  const server = createServer({ store, validateConfig: false, now, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    ADMIN_APP_URL: adminOrigin, ALLOWED_ADMIN_ORIGINS: adminOrigin, CUSTOMER_APP_URL: portal, OMADA_MODE: "standalone",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const beacon = (step, variant = "v2") => fetch(`${base}/api/telemetry/funnel`, { method: "POST", headers: { origin: portal, "content-type": "application/json" }, body: JSON.stringify({ step, variant }) });

  // Twenty visits open the Wi-Fi page at once: one row, twenty counts.
  const statuses = await Promise.all(Array.from({ length: 20 }, () => beacon("wifi_page").then((r) => r.status)));
  assert.deepEqual([...new Set(statuses)], [204]);
  assert.equal((await beacon("paid")).status, 204);
  assert.equal((await beacon("wifi_page", "v1")).status, 204);
  const { rows } = await pool.query("SELECT id, payload FROM events WHERE kind = 'insight_counter' ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.id, r.payload.steps.wifi_page, r.payload.steps.paid]), [["funnel:2026-11-20:v1", 1, 0], ["funnel:2026-11-20:v2", 20, 1]]);

  // A usage sync through the router queue records the devices online.
  const router = { readUsage: async () => [{ voucherId: "v1", usedBytes: 0, counterBytes: 0,
    devices: [{ mac: "AA:BB:CC:DD:EE:01", address: "10.20.0.1", sessionId: "*1", startedAt: "2026-11-20T18:00:00Z", usedBytes: 0 },
      { mac: "AA:BB:CC:DD:EE:02", address: "10.20.0.2", sessionId: "*2", startedAt: "2026-11-20T18:00:00Z", usedBytes: 0 }] }] };
  const processor = createRouterCommandProcessor({ store, now, router });
  await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, now));
  while (!(await processor.process()).idle);
  const sample = (await pool.query("SELECT payload, occurred_at FROM events WHERE kind = 'insight_counter' AND id = 'devices:2026-11-20T19'")).rows[0];
  assert.deepEqual([sample.payload.samples, sample.payload.total, sample.payload.peak, sample.occurred_at], [1, 2, 2, "2026-11-20T18:00:00.000Z"]);

  const insights = await fetch(`${base}/api/admin/insights?from=2026-11-19T23%3A00%3A00Z&to=2026-11-20T23%3A00%3A00Z`,
    { headers: { cookie: "admin_session=owner-token", origin: adminOrigin } });
  assert.equal(insights.status, 200);
  const body = await insights.json();
  assert.deepEqual(body.funnel.variants.v2, { wifi_page: 20, signed_in: 0, payment_started: 0, paid: 1 });
  assert.deepEqual(body.devices.hours[19], { hour: 19, samples: 1, average: 2, peak: 2 });
  assert.equal(body.availability.accessPointLoad.reason, "access-points-run-standalone-without-a-controller");
});
