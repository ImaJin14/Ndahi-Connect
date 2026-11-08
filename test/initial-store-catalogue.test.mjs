import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import {
  publishInitialStoreCatalogue,
  initialStoreCatalogue,
} from "../lib/initial-store-catalogue.mjs";
const now = () => new Date("2026-11-08T19:00:00Z");
test("owner-approved batch publishes exactly four unpriced products and 22 audited units without opening checkout", async () => {
  const store = createStore({ persistent: false });
  await publishInitialStoreCatalogue({ store, now });
  const s = await store.snapshot();
  assert.equal(s.storeProducts.length, 4);
  assert.equal(
    s.storeProducts.reduce((n, p) => n + p.stock, 0),
    22,
  );
  assert.ok(
    s.storeProducts.every((p) => p.status === "published" && p.price === null),
  );
  assert.deepEqual(
    s.storeProducts.map((p) => p.stock),
    [10, 6, 2, 4],
  );
  assert.equal(s.storeMovements.length, 4);
  assert.equal(s.storeSettings.open, false);
  assert.equal(s.auditLogs[0].action, "store.catalogue.published");
});
test("restarts/concurrent calls never replenish stock, undo edits or recreate deleted products", async () => {
  const store = createStore({ persistent: false });
  await Promise.all([
    publishInitialStoreCatalogue({ store, now }),
    publishInitialStoreCatalogue({ store, now }),
  ]);
  await store.transaction((s) => {
    s.storeProducts[0].stock = 3;
    s.storeProducts[0].price = 25000;
    s.storeProducts[0].description.en = "Owner edit";
    s.storeProducts.pop();
  });
  const before = await store.snapshot();
  assert.equal(
    (await publishInitialStoreCatalogue({ store, now })).applied,
    false,
  );
  assert.deepEqual(await store.snapshot(), before);
});
test("an existing SKU fails atomically instead of duplicating products or overwriting stock", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.storeProducts = [
      { id: "existing", sku: initialStoreCatalogue[2].sku, stock: 99 },
    ];
  });
  const before = await store.snapshot();
  await assert.rejects(
    publishInitialStoreCatalogue({ store, now }),
    /already exists/,
  );
  assert.deepEqual(await store.snapshot(), before);
});

test(
  "PostgreSQL concurrent publication persists a single stock receipt and preserves later price edits",
  { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not set" },
  async () => {
    const { default: pg } = await import("pg"),
      { createPostgresStore } = await import("../lib/postgres-store.mjs"),
      { blank } = await import("../lib/api/state.mjs"),
      { applySchemaMigrations } = await import(
        "../scripts/migrate-postgres.mjs"
      );
    const schema = "initial_catalogue_" + process.pid,
      admin = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 5,
    });
    try {
      const client = await pool.connect();
      try {
        await applySchemaMigrations(client);
      } finally {
        client.release();
      }
      const first = createPostgresStore({ pool, initialState: blank }),
        second = createPostgresStore({ pool, initialState: blank });
      const result = await Promise.all([
        publishInitialStoreCatalogue({ store: first, now }),
        publishInitialStoreCatalogue({ store: second, now }),
      ]);
      assert.equal(result.filter((r) => r.applied).length, 1);
      assert.equal((await second.snapshot()).storeMovements.length, 4);
      await first.transaction((s) => {
        s.storeProducts[0].price = 25000;
        s.storeProducts[0].stock = 7;
      });
      const reopened = createPostgresStore({ pool, initialState: blank });
      await publishInitialStoreCatalogue({ store: reopened, now });
      const s = await reopened.snapshot();
      assert.equal(s.storeProducts[0].price, 25000);
      assert.equal(s.storeProducts[0].stock, 7);
      assert.equal(s.storeMovements.length, 4);
      assert.equal(s.storeSettings.open, false);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
