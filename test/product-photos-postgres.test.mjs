// Product photos on PostgreSQL: stored beside the state as events rows of
// kind store_photo, never read by a full-state read; uploaded and saved
// through the real API; and removed by retention only when no product uses
// them and they are older than two days.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { createServer } from "../server.mjs";
import { blank } from "../lib/api/state.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { runRetention } from "../lib/retention.mjs";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL is not set";
const schema = `ndahi_photos_${process.pid}`;
const secret = "photos-postgres-secret", adminOrigin = "http://admin.test";
let admin, pool, store;

const png = (n) => {
  const bytes = Buffer.alloc(120000);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(n, bytes.length - 4);
  return bytes;
};
const photo = (bytes) => ({ id: createHash("sha256").update(bytes).digest("hex"), mime: "image/png", bytes: bytes.length, data: bytes.toString("base64") });
const words = { en: "Router", fr: "Routeur" };

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
  });
});

test.after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test("photos are stored beside the state and never read with it", { skip }, async () => {
  const a = photo(png(1)), b = photo(png(2));
  await store.photos.put(a);
  await store.photos.put(b);
  assert.deepEqual(await store.photos.get(a.id), { mime: "image/png", data: a.data });
  assert.equal(await store.photos.get("0".repeat(64)), null);
  assert.deepEqual((await store.photos.info([a.id, b.id, "f".repeat(64)])).sort((x, y) => x.id.localeCompare(y.id)),
    [a, b].map(({ id, mime, bytes }) => ({ id, mime, bytes })).sort((x, y) => x.id.localeCompare(y.id)));
  const state = JSON.stringify(await store.snapshot());
  assert.ok(!state.includes(a.data.slice(0, 200)), "a full read carries no photo");
  // A full transaction leaves the photos alone.
  await store.transaction((s) => { s.events.push({ id: "e1", type: "test", at: new Date().toISOString() }); });
  assert.ok(await store.photos.get(b.id));
});

test("upload, save and serve through the API on PostgreSQL", { skip }, async (t) => {
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", LOG_LEVEL: "silent",
    ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, ALLOWED_ADMIN_ORIGINS: adminOrigin,
    NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: adminOrigin, cookie: "admin_session=owner-token", "x-csrf-token": "csrf" }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const ids = [];
  for (let n = 10; n < 40; n++) {
    const response = await post("/api/admin/store/photos", { data: `data:image/png;base64,${png(n).toString("base64")}` });
    assert.equal(response.status, 200, response.data.error);
    ids.push(response.data.photo.id);
  }
  const saved = await post("/api/admin/store/products/save", { sku: "pg-photos", name: words, description: words, specifications: words, compatibility: words,
    contents: words, warranty: words, setup: words, price: 90000, cost: 0, status: "published", featured: false, categoryId: "", images: ids.map((id) => ({ id })) });
  assert.equal(saved.status, 200, saved.data.error);
  const row = (await pool.query("SELECT payload FROM events WHERE kind = 'store_product' AND payload->>'sku' = 'pg-photos'")).rows[0].payload;
  assert.equal(row.images.length, 30);
  assert.ok(JSON.stringify(row).length < 20000, "the product row holds references only");
  const catalogue = await fetch(base + "/api/store/catalogue").then((r) => r.json());
  assert.equal(catalogue.products.find((p) => p.sku === "pg-photos").images[29].src, `/api/store/photos/${ids[29]}`);
  const served = await fetch(`${base}/api/store/photos/${ids[29]}`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png(39));
});

test("retention removes photos no product uses after two days, and keeps the rest", { skip }, async () => {
  const now = new Date("2026-12-01T02:17:00Z"), daysAgo = (d) => new Date(now.getTime() - d * 86400_000);
  const used = photo(png(100)), unused = photo(png(101)), recent = photo(png(102)), refreshed = photo(png(103));
  await store.photos.put(used, daysAgo(10));
  await store.photos.put(unused, daysAgo(3));
  await store.photos.put(recent, daysAgo(1));
  await store.photos.put(refreshed, daysAgo(5));
  await store.photos.put(refreshed, daysAgo(1)); // uploaded again: the grace starts again
  await store.transaction((s) => {
    s.storeProducts.push({ id: "retained", sku: "retained", version: 1, name: words, status: "draft", stock: 0, price: 1, images: [{ id: used.id, mime: "image/png", bytes: used.bytes, alt: words }] });
  });
  const client = await pool.connect();
  let counts;
  try { counts = await runRetention(client, now); } finally { client.release(); }
  assert.ok(counts.unusedStorePhotos >= 1);
  assert.ok(await store.photos.get(used.id), "a photo a product uses stays");
  assert.equal(await store.photos.get(unused.id), null, "an unused photo older than two days goes");
  assert.ok(await store.photos.get(recent.id), "a recent upload stays");
  assert.ok(await store.photos.get(refreshed.id), "uploading again restarts the grace");
});
