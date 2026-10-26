import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { pairingFixture, guestMac, ownerRoot } from "./helpers/wifi-pairing-fixture.mjs";
const url = process.env.TEST_DATABASE_URL;
test("PostgreSQL matching approvals roll back, compete for one slot and survive store reopen without duplicate router writes", { skip: url ? false : "TEST_DATABASE_URL is not set", timeout: 60000 }, async () => {
  const schema = `ndahi_matching161_${process.pid}`, admin = new pg.Client({ connectionString: url });
  await admin.connect(); let pool; const fixtures = [];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) await pool.query(await readFile(new URL(file, dir), "utf8"));
    const store = createPostgresStore({ pool, initialState: blank });
    const f = await pairingFixture({ store }); fixtures.push(f);
    const g = await pairingFixture({ store: createPostgresStore({ pool, initialState: blank }), seed: false }); fixtures.push(g);
    const start = async (client, key, mac, address) => {
      const r = await client.call(ownerRoot + "/request", { key, mac, address }, { session: "secondary", controller: "" });
      assert.equal(r.status, 201); return r.body.request;
    };
    const confirm = (client, r) => client.call(ownerRoot + "/approve", { id: r.id, confirmMatch: true, comparisonCode: r.comparisonCode });
    const a = await start(f, "a".repeat(32), guestMac, "10.20.0.30"), b = await start(g, "b".repeat(32), "AA:BB:CC:DD:EE:04", "10.20.0.40");
    const transaction = store.transaction.bind(store);
    store.transaction = (fn, options) => transaction(async s => { const result = await fn(s); if (s.wifiPairingRequests.some(p => p.status === "connecting")) throw Error("Synthetic PostgreSQL matching rollback"); return result; }, options);
    assert.ok((await confirm(f, a)).status >= 400);
    assert.equal((await g.store.snapshot()).wifiPairingRequests.find(p => p.id === a.id).status, "awaiting_confirmation");
    assert.equal((await g.store.snapshot()).routerCommands.filter(p => p.action === "connect_wifi_device").length, 0);
    store.transaction = transaction;
    const results = await Promise.all([confirm(f, a), confirm(g, b)]);
    assert.deepEqual(results.map(r => r.status).sort(), [202, 409]);
    const snapshot = await store.snapshot(), jobs = snapshot.routerCommands.filter(c => c.action === "connect_wifi_device");
    assert.equal(jobs.length, 1); assert.equal(f.calls.length + g.calls.length, 0);
    const winner = snapshot.wifiPairingRequests.find(p => p.commandId === jobs[0].id);
    const repeated = await confirm(g, winner.id === a.id ? a : b); assert.equal(repeated.status, 200);
    const reopened = createPostgresStore({ pool, initialState: blank });
    assert.equal((await reopened.snapshot()).wifiPairingRequests.find(p => p.id === winner.id).status, "connecting");
    const h = await pairingFixture({ store: reopened, seed: false }); fixtures.push(h);
    await Promise.all([f.process(jobs[0].id), h.process(jobs[0].id)]);
    assert.equal(f.calls.length + g.calls.length + h.calls.length, 1);
    const final = await reopened.snapshot(); assert.equal(final.wifiPairingRequests.find(p => p.id === winner.id).status, "connected");
    assert.equal(final.vouchers[0].wifiDevices.filter(d => d.mac === winner.mac).length, 1);
    assert.equal(final.wifiPairingRequests.find(p => p.id !== winner.id).status, "awaiting_confirmation");
  } finally {
    for (const f of fixtures) await f.close();
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
});
