// The Unlimited catalogue on PostgreSQL (#332): the catalogue switch is a
// stored setting, and the customer catalogue (a targeted read of the bundle
// rows and that setting) follows it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHandler, blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";

const url = process.env.TEST_DATABASE_URL;

test("PostgreSQL: the seed is stored once and the targeted catalogue read follows the switch", { skip: url ? false : "TEST_DATABASE_URL is not set", timeout: 60000 }, async (t) => {
  const schema = `ndahi_catalogue332_${process.pid}`, admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) await pool.query(await readFile(new URL(file, dir), "utf8"));
  const store = createPostgresStore({ pool, initialState: blank });
  assert.equal((await store.transaction((s) => seedCatalogue(s))).length, 20);
  assert.deepEqual(await store.transaction((s) => seedCatalogue(s)), [], "stored marker: never again");
  const handler = createHandler({ store, validateConfig: false, env: { NODE_ENV: "test", STORE_TARGETED_READS: "true", LOG_LEVEL: "silent",
    NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false" } });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const plans = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/plans`)).json()).plans;
  assert.equal((await plans()).some((p) => p.catalogue === "unlimited"), false, "legacy by default");
  await store.transaction((s) => { s.catalogue = { ...s.catalogue, mode: "unlimited" }; });
  const live = await plans();
  assert.equal(live.length, 20);
  assert.deepEqual([live[0].id, live[0].price, live.at(-1).id, live.at(-1).price], ["unlimited-5h-1", 250, "home-wisp-30d", 50000]);
  const fresh = createPostgresStore({ pool, initialState: blank });
  assert.equal((await fresh.snapshot()).catalogue.mode, "unlimited", "the switch is stored");
});
