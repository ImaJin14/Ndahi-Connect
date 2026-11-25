import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { createServer, createStore, blank } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { resellerCommissionRate, resellerRate } from "../lib/reseller-ledger.mjs";

// One commission rate for every reseller (#390; owner, 25 Nov): "Change" sets
// it for codes issued from then on, and codes keep the rate recorded on them
// (#261).

test("the shared rate is 10% until the owner sets one, and a reseller without their own uses it", () => {
  assert.equal(resellerCommissionRate({}), 10);
  assert.equal(resellerCommissionRate({ resellerSettings: { commissionPercent: 12.5 } }), 12.5);
  assert.equal(resellerCommissionRate({ resellerSettings: { commissionPercent: "nope" } }), 10, "an unreadable rate falls back to 10%");
  const s = { resellerSettings: { commissionPercent: 15 } };
  assert.equal(resellerRate(s, { role: "reseller" }), 15);
  assert.equal(resellerRate(s, { role: "reseller", commissionPercent: 8 }), 8);
});

test("Change sets one rate for every reseller; issued codes keep theirs and new codes take it", async (t) => {
  const secret = "commission-secret", store = createStore({ persistent: false });
  await store.transaction((s) => {
    for (const [id, role] of [["u-owner", "owner"], ["u-operator", "operator"]]) {
      s.adminUsers.push({ id, username: id, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: id, role, tokenHash: hashSecret(`${id}-token`, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    s.adminUsers.push({ id: "r-kiosk", username: "kiosk", displayName: "Market kiosk", role: "reseller", active: true, passkeys: [], commissionPercent: 10 },
      { id: "r-canteen", username: "canteen", displayName: "School canteen", role: "reseller", active: true, passkeys: [], commissionPercent: 12 },
      { id: "r-new", username: "church", displayName: "Church shop", role: "reseller", active: true, passkeys: [] });
    const code = (id, reseller, rate, extra = {}) => ({ id, code: `NC-${id.toUpperCase()}`, planId: "weekly", status: "available", assignedResellerId: reseller, generatedByAdmin: true,
      resale: true, saleType: "sold", saleAmount: 1000, faceValue: 1000, quotaBytes: 5e9, usedBytes: 0, deviceLimit: 1, createdAt: "2026-11-20T10:00:00Z",
      ...(rate == null ? {} : { commissionPercent: rate }), ...extra });
    s.vouchers.push(code("k-unsold", "r-kiosk", 10), code("k-sold", "r-kiosk", 10, { status: "active", activatedAt: "2026-11-21T10:00:00Z" }),
      code("c-legacy", "r-canteen", null), code("c-sold", "r-canteen", null, { status: "active", activatedAt: "2026-11-22T10:00:00Z" }));
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret,
    CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (user, path, body) => fetch(base + path, { method: "POST", headers: { cookie: `admin_session=${user}-token`, "content-type": "application/json", "x-csrf-token": "csrf" }, body: JSON.stringify(body) });

  assert.equal((await post("u-operator", "/api/admin/resellers/commission", { commissionPercent: 20 })).status, 403, "only the owner");
  assert.equal((await post("u-owner", "/api/admin/resellers/commission", { commissionPercent: 120 })).status, 400);
  const changed = await post("u-owner", "/api/admin/resellers/commission", { commissionPercent: 15 });
  assert.equal(changed.status, 200);
  const body = await changed.json();
  assert.equal(body.commissionPercent, 15);
  assert.equal(body.resellerLedger.commissionPercent, 15, "the ledger shows the shared rate");
  const s = await store.snapshot();
  assert.equal(s.resellerSettings.commissionPercent, 15);
  assert.deepEqual(s.adminUsers.filter((u) => u.role === "reseller").map((u) => [u.id, u.commissionPercent, u.commissionHistory.at(-1).previousCommissionPercent]),
    [["r-kiosk", 15, 10], ["r-canteen", 15, 12], ["r-new", 15, 10]]);
  // Codes keep the rate recorded on them, sold or not; codes without one get the rate they had.
  assert.deepEqual(Object.fromEntries(s.vouchers.map((v) => [v.id, v.commissionPercent])), { "k-unsold": 10, "k-sold": 10, "c-legacy": 12, "c-sold": 12 });
  assert.ok(s.auditLogs.some((entry) => entry.action === "reseller.commission_split_updated" && entry.meta.commissionPercent === 15 && entry.meta.resellerCount === 3));
  // A code issued for a reseller now carries the new rate.
  const issued = await post("u-owner", "/api/admin/vouchers/generate", { purpose: "resale", planId: "weekly", quantity: 1, saleType: "sold", assignedResellerId: "r-kiosk" });
  assert.equal(issued.status, 201, await issued.clone().text());
  const fresh = (await store.snapshot()).vouchers.find((v) => !["k-unsold", "k-sold", "c-legacy", "c-sold"].includes(v.id));
  assert.equal(fresh.commissionPercent, 15);
});

const url = process.env.TEST_DATABASE_URL;
test("the shared rate is kept in PostgreSQL", { skip: url ? false : "TEST_DATABASE_URL is not set" }, async () => {
  const schema = `ndahi_commission_${process.pid}`, admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => /^\d+_.+\.sql$/.test(f)).sort())
      await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    const store = createPostgresStore({ pool, initialState: blank });
    await store.transaction((s) => { s.resellerSettings = { commissionPercent: 12.5, updatedAt: "2026-11-25T10:00:00Z", updatedBy: "owner" }; });
    const reopened = createPostgresStore({ pool, initialState: blank });
    assert.deepEqual((await reopened.snapshot()).resellerSettings, { commissionPercent: 12.5, updatedAt: "2026-11-25T10:00:00Z", updatedBy: "owner" });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
