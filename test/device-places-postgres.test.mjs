// The device place worker on PostgreSQL (#344, #341): it reads only the saved
// controller connection and the active vouchers and approved device slots, and
// writes the places back without loading the whole state.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { blank } from "../lib/api/state.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { createDevicePlaces } from "../lib/device-places.mjs";

const url = process.env.TEST_DATABASE_URL, skip = url ? false : "TEST_DATABASE_URL is not set";
const schema = `ndahi_device_places_${process.pid}`, now = new Date("2030-01-01T09:00:00Z");
let admin, pool, store;
test.before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter((f) => /^\d+_.+\.sql$/.test(f)).sort())
    await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  store = createPostgresStore({ pool, initialState: blank });
});
test.after(async () => {
  if (skip) return;
  await pool?.end();
  await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin?.end();
});

test("places are recorded on active vouchers and approved slots through a targeted transaction", { skip }, async () => {
  await store.transaction((s) => {
    s.customers.push({ id: "c1", phone: "670004019", name: "J. Fon" });
    s.vouchers.push({ id: "v1", customerId: "c1", planId: "weekly", code: "NC-K7PM-42XQ", status: "active", activatedAt: new Date(+now - 600e3).toISOString(),
      expiresAt: "2030-01-08T09:00:00Z", quotaBytes: null, usedBytes: 0, deviceLimit: 2, wifiDevices: [{ mac: "AA:BB:CC:4F:A2:10" }] },
    { id: "v2", customerId: "c1", planId: "weekly", code: "NC-S7CK-4ABC", status: "available", quotaBytes: null, usedBytes: 0, deviceLimit: 2 });
    s.wifiDeviceGrants = [{ id: "g1", customerId: "c1", voucherId: "v1", mac: "AA:BB:CC:4F:A2:10", status: "approved", routerRevision: "" },
      { id: "g2", customerId: "c1", voucherId: "v1", mac: "AA:BB:CC:19:C7:5E", status: "revoked", routerRevision: "" }];
  });
  const worker = createDevicePlaces({ store, now: () => now,
    networkSetup: { omadaClients: async () => [{ mac: "AA:BB:CC:4F:A2:10", ap: "AP-Market" }, { mac: "AA:BB:CC:19:C7:5E", ap: "AP-Junction" }] } });
  assert.deepEqual(await worker.run(), { redeemed: 1, slots: 1 });
  const s = await store.snapshot();
  assert.equal(s.vouchers.find((v) => v.id === "v1").redeemedPlace, "AP-Market");
  assert.equal(s.vouchers.find((v) => v.id === "v2").redeemedPlace, undefined);
  assert.deepEqual(s.wifiDeviceGrants.map((g) => g.place), ["AP-Market", undefined]);
  // A second pass with nothing new writes nothing.
  assert.deepEqual(await worker.run(), { redeemed: 0, slots: 0 });
});

test("the saved controller connection is read on its own", { skip }, async () => {
  await store.transaction((s) => { s.networkSetup = { connections: { omada: { kind: "omada", mode: "simulation" } } }; });
  const s = await store.read([{ settings: ["networkSetup"] }]);
  assert.equal(s.networkSetup.connections.omada.mode, "simulation");
  assert.deepEqual(s.vouchers, [], "nothing else is loaded");
});
