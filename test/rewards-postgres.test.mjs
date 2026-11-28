// Rewards (#526) on PostgreSQL: the points ledger is stored as `points_ledger`
// rows and the settings as one setting; with targeted reads on, two redeem
// requests with points for one spend them once.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createHandler, blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";
import { hashSecret } from "../lib/security.mjs";
import { balanceOf } from "../lib/rewards.mjs";

const url = process.env.TEST_DATABASE_URL, secret = "rewards-postgres";

test("PostgreSQL: points earned, stored and redeemed once under concurrent requests", { skip: url ? false : "TEST_DATABASE_URL is not set", timeout: 90000 }, async (t) => {
  const schema = `ndahi_rewards526_${process.pid}`, admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) await pool.query(await readFile(new URL(file, dir), "utf8"));
  const store = createPostgresStore({ pool, initialState: blank });
  await store.transaction((s) => {
    seedCatalogue(s); s.catalogue = { ...s.catalogue, mode: "unlimited" };
    s.adminUsers.push({ id: "owner", role: "owner", username: "owner", active: true });
    s.adminSessions.push({ id: "owner", userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "csrf-owner", expiresAt: "2031-01-01T00:00:00Z" });
  });
  const handler = createHandler({ store, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", STORE_TARGETED_READS: "true", LOG_LEVEL: "silent",
    ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false" } });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, input, cookie) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { ...(input ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie: cookie + "=" + (cookie === "admin_session" ? "owner" : "buyer"), "x-csrf-token": cookie === "admin_session" ? "csrf-owner" : "csrf-buyer" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call("/api/admin/rewards/settings", { points: { enabled: true } }, "admin_session")).status, 200);
  const placed = await call("/api/purchase", { phone: "670600001", planId: "unlimited-7d-3", network: "mtn", requestKey: randomUUID() }); // 5,500 XAF
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.equal((await call(`/api/payments/${placed.body.payment.id}/confirm`, {})).status, 200);
  await store.transaction((s) => {
    const c = s.customers.find((x) => x.phone.endsWith("670600001"));
    s.dashboardSessions.push({ id: "buyer", customerId: c.id, tokenHash: hashSecret("buyer", secret), csrfToken: "csrf-buyer", expiresAt: "2031-01-01T00:00:00Z" });
  });
  const { rows } = await pool.query("SELECT payload FROM events WHERE kind = 'points_ledger'");
  assert.deepEqual(rows.map((r) => [r.payload.kind, r.payload.points]), [["earned", 55]]);
  const view = (await call("/api/account/rewards", undefined, "customer_session")).body;
  assert.deepEqual([view.balance, view.offers.find((o) => o.id === "unlimited-5h-1").points], [55, 50]);

  const tries = await Promise.all([1, 2].map(() => call("/api/account/rewards/redeem", { offerId: "unlimited-5h-1", idempotencyKey: randomUUID() }, "customer_session")));
  assert.deepEqual(tries.map((x) => x.status).sort(), [200, 409]);
  const fresh = createPostgresStore({ pool, initialState: blank }), s = await fresh.snapshot();
  const c = s.customers.find((x) => x.phone.endsWith("670600001"));
  assert.equal(balanceOf(s, c.id), 5, "spent once");
  assert.equal(s.vouchers.filter((v) => v.reward).length, 1);
  assert.equal(s.rewardsSettings.points.enabled, true, "the settings are stored");
});
