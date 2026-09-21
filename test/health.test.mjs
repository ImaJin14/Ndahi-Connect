import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";

async function fixture(t, healthCheck, bootstrap = false) {
  const server = createServer({ validateConfig: false,
    store: { healthCheck,
      snapshot: () => assert.fail("Readiness must not load application state"),
      transaction: () => assert.fail("Readiness must not enter the write queue") },
    env: { BOOTSTRAP_MODE: String(bootstrap), PAYMENT_MODE: "mock",
      PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", PAYMENT_RECONCILIATION_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false", NETWORK_RECONCILIATION_ENABLED: "false" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return () => fetch(`http://127.0.0.1:${server.address().port}/api/health`);
}

for (const bootstrap of [false, true]) {
  test(`health bypasses application writes and state loading (bootstrap=${bootstrap})`, async (t) => {
    const request = await fixture(t, async () => {}, bootstrap);
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, bootstrap ? "bootstrap" : "ready");
  });
  test(`database failure reports unavailable without disclosing credentials (bootstrap=${bootstrap})`, async (t) => {
    const request = await fixture(t, async () => { throw Error("postgres://secret@host/db"); }, bootstrap);
    const response = await request();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unhealthy", database: "unavailable" });
  });
}

test("hung database probe is bounded and concurrent requests share one probe", async (t) => {
  let calls = 0;
  const request = await fixture(t, () => { calls++; return new Promise(() => {}); });
  const start = Date.now();
  const responses = await Promise.all([request(), request()]);
  assert.ok(responses.every((r) => r.status === 503));
  assert.equal(calls, 1);
  assert.ok(Date.now() - start < 4900, "health must fail before Render's five-second deadline");
});

test("PostgreSQL health resolves schema without state reads or advisory locks", async () => {
  const queries = [];
  const store = createPostgresStore({ pool: { query: async (sql) => { queries.push(sql); }, end: async () => {} } });
  await store.healthCheck();
  assert.equal(queries.length, 1);
  assert.match(queries[0], /FROM payments WHERE false/);
  assert.match(queries[0], /FROM app_settings WHERE false/);
  assert.doesNotMatch(queries[0], /payload|advisory|DELETE|INSERT|UPDATE|BEGIN/);
  await store.close();
});
