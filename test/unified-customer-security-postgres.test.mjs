import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import argon2 from "argon2";
import { createHandler, blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
const url = process.env.TEST_DATABASE_URL;

test("PostgreSQL unified security commits PIN/session/receipt atomically, rejects a concurrent stale change and reopens accurately", { skip: url ? false : "TEST_DATABASE_URL is not set" }, async () => {
  const schema = `ndahi_security129_${process.pid}`, admin = new pg.Client({ connectionString: url });
  await admin.connect(); let pool, server;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(directory)).filter(x => /^\d+_.+\.sql$/.test(x)).sort()) await pool.query(await readFile(new URL(file, directory), "utf8"));
    const store = createPostgresStore({ pool, initialState: blank }), f = await pairingFixture();
    try { await store.transaction(async s => Object.assign(s, await f.store.snapshot())); } finally { await f.close(); }
    const handler = createHandler({ store, now: () => new Date("2030-01-01T12:00:00Z"), validateConfig: false, env: {
      NODE_ENV: "production", CUSTOMER_SESSION_SECRET: "pairing-tests", SECRET_PEPPER: "pairing-tests", SESSION_COOKIE_SECURE: "false",
      CUSTOMER_APP_URL: "http://customer.test", LOG_LEVEL: "warn", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
    } });
    server = http.createServer(handler); await new Promise(r => server.listen(0, "127.0.0.1", r));
    const api = `http://127.0.0.1:${server.address().port}`, operationId = "b".repeat(32);
    const call = async (path, body, session = "main") => {
      const response = await fetch(api + path, { method: body ? "POST" : "GET", headers: { origin: "http://customer.test", "content-type": "application/json", "x-csrf-token": "csrf", cookie: `customer_session=${session}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { response, status: response.status, body: await response.json() };
    };
    const original = store.transaction.bind(store);
    store.transaction = (fn, options) => original(async s => { const result = await fn(s); if (s.customers[0].accountBackupCodes?.length) throw Error("Synthetic security commit rollback"); return result; }, options);
    const rollback = await call("/api/account/security/account-backup/generate", { currentPin: "2468", operationId }); assert.notEqual(rollback.status, 200);
    assert.equal((await store.snapshot()).customers[0].accountBackupCodes, undefined);
    assert.equal((await call("/api/account/security/actions/" + operationId)).status, 404);
    store.transaction = original;
    const input = { currentPin: "2468", newPin: "5830", confirmPin: "5830", operationId };
    const results = await Promise.all([call("/api/account/security/pin", input), call("/api/account/security/pin", input)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200,401]);
    const success = results.find(r => r.status === 200), session = success.response.headers.get("set-cookie").match(/customer_session=([^;]+)/)[1];
    assert.equal((await call("/api/account/security/actions/" + operationId, undefined, session)).body.action, "pin_change");
    const reopened = createPostgresStore({ pool, initialState: blank }), s = await reopened.snapshot();
    assert.equal(await argon2.verify(s.customers[0].pinHash, "5830"), true);
    assert.equal(s.dashboardSessions.filter(x => x.customerId === "c1").length, 1);
    assert.equal(s.dashboardSessions.find(x => x.customerId === "c1").securityActions[0].id, operationId);
    assert.equal(s.securityEvents.filter(x => x.type === "customer.pin_changed").length, 1);
  } finally {
    if (server) await new Promise(r => { server.close(r); server.closeAllConnections(); });
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
});
