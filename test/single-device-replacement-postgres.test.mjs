import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { pairingFixture, guestMac } from "./helpers/wifi-pairing-fixture.mjs";
const url = process.env.TEST_DATABASE_URL, root = "/api/account/device-management/connect";
test("PostgreSQL single-device switches roll back, serialize independent owners and survive reopen with one disconnect/connect", { skip: url ? false : "TEST_DATABASE_URL is not set", timeout: 60000 }, async () => {
  const schema = "ndahi_switch166_" + randomUUID().replaceAll("-", ""), admin = new pg.Client({ connectionString: url });
  await admin.connect(); let pool; const fixtures = [], disconnects = [];
  const router = { async disconnectWifiDevice(device) { disconnects.push(device); return { confirmed: true, outcome: "absent" }; } };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) await pool.query(await readFile(new URL(file, dir), "utf8"));
    const makeStore = () => createPostgresStore({ pool, initialState: blank }), store = makeStore();
    const f = await pairingFixture({ store, router }); fixtures.push(f);
    const g = await pairingFixture({ store: makeStore(), seed: false, router }); fixtures.push(g);
    await store.transaction(s => { s.vouchers[0].deviceLimit = 1; s.vouchers[0].wifiDevices.length = 1; s.customers[0].wifiFirstConnectedAt = f.now().toISOString(); });
    const initial = { key: "a".repeat(32), mac: guestMac, address: "10.20.0.30" };
    const occupied = (await f.call(root, initial)).body.replacement;
    const input = { ...initial, replace: true, replacement: occupied, pin: "2468" };
    const transaction = store.transaction.bind(store);
    store.transaction = (fn, options) => transaction(async s => {
      const result = await fn(s);
      if (s.wifiPairingRequests.some(p => p.kind === "single_switch")) throw Error("Synthetic switch rollback");
      return result;
    }, options);
    assert.ok((await f.call(root, input)).status >= 400);
    assert.equal((await g.store.snapshot()).wifiPairingRequests.length, 0);
    assert.equal((await g.store.snapshot()).routerCommands.filter(c => c.singleSwitchId).length, 0);
    store.transaction = transaction;
    const results = await Promise.all([f.call(root, input), g.call(root, { ...input, key: "b".repeat(32), mac: "AA:BB:CC:DD:EE:04", address: "10.20.0.40" })]);
    assert.deepEqual(results.map(r => r.status).sort(), [202, 409]);
    const reopened = makeStore(), snapshot = await reopened.snapshot(), p = snapshot.wifiPairingRequests[0];
    assert.equal(p.kind, "single_switch"); assert.equal(snapshot.vouchers[0].wifiDevices.length, 1);
    const h = await pairingFixture({ store: reopened, seed: false, router }); fixtures.push(h);
    await Promise.all([f.process(p.disconnectCommandId), h.process(p.disconnectCommandId)]);
    assert.equal(disconnects.length, 1);
    await Promise.all([f.process(p.commandId), h.process(p.commandId)]);
    const final = await reopened.snapshot();
    assert.equal(fixtures.reduce((count, f) => count + f.calls.length, 0), 1);
    assert.equal(final.wifiPairingRequests[0].status, "connected");
    assert.deepEqual(final.vouchers[0].wifiDevices.map(d => d.mac), [p.mac]);
    assert.equal(final.vouchers[0].quotaBytes, snapshot.vouchers[0].quotaBytes);
    assert.equal(final.vouchers[0].expiresAt, snapshot.vouchers[0].expiresAt);
  } finally {
    for (const f of fixtures) await f.close();
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
});
