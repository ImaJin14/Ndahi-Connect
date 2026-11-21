import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

// Product photos, up to 30 a product (taken over from Codex's draft). Each is
// uploaded on its own and stored beside the state, named by the SHA-256 of its
// bytes; products keep references, the catalogue sends URLs, and the API serves
// each photo with a year's caching. Real API, memory store.

// A photo close to the 175,000-byte limit, with a PNG signature. Each one
// differs (its last bytes), so each has its own id.
const png = (n) => {
  const bytes = Buffer.alloc(174990);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(n, bytes.length - 4);
  return bytes;
};
const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString("base64")}`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = { en: "Router", fr: "Routeur" };
const product = (images, extra = {}) => ({ sku: "photos-30", name: text, description: text, specifications: text,
  compatibility: text, contents: text, warranty: text, setup: text, price: 100000, cost: 0,
  status: "published", featured: false, categoryId: "", images, ...extra });
const secret = "product-photos-test-secret";

test("product photos: upload one at a time, up to 30, served by URL outside the state", { timeout: 120000 }, async (t) => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    for (const role of ["owner", "operator", "reseller"]) {
      s.adminUsers.push({ id: role, role, username: role, active: true });
      s.adminSessions.push({ id: role, userId: role, role, tokenHash: hashSecret(role, secret),
        csrfToken: `csrf-${role}`, expiresAt: "2099-01-01T00:00:00Z" });
    }
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "production", PAYMENT_MODE: "mesomb",
    ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    ALLOWED_ADMIN_ORIGINS: "http://localhost:8081", LOG_LEVEL: "silent",
    NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", BOOTSTRAP_MODE: "false" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(path, payload, role = "owner", csrf = `csrf-${role}`) {
    const headers = { "content-type": "application/json", origin: "http://localhost:8081" };
    if (role) headers.cookie = `admin_session=${role}`;
    if (csrf) headers["x-csrf-token"] = csrf;
    const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(payload) });
    return { status: res.status, data: await res.json() };
  }
  const upload = (bytes, role) => post("/api/admin/store/photos", { data: dataUrl(bytes) }, role);
  const save = (payload) => post("/api/admin/store/products/save", payload);
  const saved = async (sku = "photos-30") => (await store.snapshot()).storeProducts.find((p) => p.sku === sku);
  const photos = Array.from({ length: 31 }, (_, n) => png(n));
  let ids;

  await t.test("an owner or operator uploads a photo; it is stored by the SHA-256 of its bytes", async () => {
    const first = await upload(photos[0]);
    assert.equal(first.status, 200, first.data.error);
    assert.deepEqual(first.data.photo, { id: sha(photos[0]), mime: "image/png", bytes: photos[0].length, src: `/api/store/photos/${sha(photos[0])}` });
    const operator = await upload(photos[1], "operator");
    assert.equal(operator.status, 200, operator.data.error);
    ids = [first.data.photo.id, operator.data.photo.id];
    for (const bytes of photos.slice(2)) {
      const response = await upload(bytes);
      assert.equal(response.status, 200, response.data.error);
      ids.push(response.data.photo.id);
    }
    assert.equal(new Set(ids).size, 31);
    // Uploading the same photo again is harmless: same id.
    assert.equal((await upload(photos[0])).data.photo.id, ids[0]);
  });

  await t.test("uploads are checked, and only store staff may upload", async () => {
    const svg = await post("/api/admin/store/photos", { data: "data:image/svg+xml;base64,PHN2Zz4=" });
    assert.equal(svg.status, 400);
    const fake = await post("/api/admin/store/photos", { data: `data:image/png;base64,${Buffer.from("not a png").toString("base64")}` });
    assert.equal(fake.status, 400);
    const tooBig = Buffer.concat([png(99), Buffer.alloc(20)]);
    assert.equal((await upload(tooBig)).status, 400);
    assert.equal((await upload(photos[0], "reseller")).status, 403);
    assert.equal((await post("/api/admin/store/photos", { data: dataUrl(photos[0]) }, null, null)).status, 401);
    assert.equal((await post("/api/admin/store/photos", { data: dataUrl(photos[0]) }, "owner", "wrong")).status, 403);
    // Every admin request keeps the 1 MB limit; a photo is far under it.
    const huge = await post("/api/admin/store/photos", { data: "x".repeat(1_000_001) });
    assert.equal(huge.status, 413);
  });

  await t.test("a product saves with 30 photos, kept as references with their alternative text", async () => {
    const images = ids.slice(0, 30).map((id, n) => ({ id, alt: { en: `View ${n + 1}`, fr: `Vue ${n + 1}` } }));
    const response = await save(product(images));
    assert.equal(response.status, 200, response.data.error);
    const p = await saved();
    assert.equal(p.images.length, 30);
    assert.deepEqual(p.images[0], { id: ids[0], mime: "image/png", bytes: photos[0].length, alt: { en: "View 1", fr: "Vue 1" } });
    assert.ok(p.images.every((image) => !("data" in image)));
    // The state stays small: no image data in it.
    const state = JSON.stringify(await store.snapshot());
    assert.ok(!state.includes(photos[5].toString("base64").slice(0, 200)), "no photo bytes in the state");
    assert.ok(state.length < 200_000, `state is ${state.length} bytes`);
    // The admin sees each photo's id and address.
    const admin = await fetch(base + "/api/admin/store", { headers: { cookie: "admin_session=owner", origin: "http://localhost:8081" } }).then((r) => r.json());
    assert.deepEqual(admin.products.find((x) => x.sku === "photos-30").images[29], { id: ids[29], src: `/api/store/photos/${ids[29]}`, alt: { en: "View 30", fr: "Vue 30" } });
  });

  await t.test("31 photos, an unknown photo, or a new inline photo are refused", async () => {
    const p = await saved();
    const thirtyOne = await save(product(ids.map((id) => ({ id })), { id: p.id, version: p.version }));
    assert.equal(thirtyOne.status, 400);
    assert.match(thirtyOne.data.error, /at most 30/);
    const unknown = await save(product([{ id: "0".repeat(64) }], { id: p.id, version: p.version }));
    assert.equal(unknown.status, 400);
    assert.match(unknown.data.error, /could not be found/);
    const inline = await save(product([{ data: dataUrl(photos[0]) }], { sku: "inline-new" }));
    assert.equal(inline.status, 400);
    assert.match(inline.data.error, /Upload each photo/);
    assert.equal((await saved()).version, p.version, "nothing changed");
  });

  await t.test("the catalogue sends addresses, never image data", async () => {
    const response = await fetch(base + "/api/store/catalogue");
    const raw = await response.text(), catalogue = JSON.parse(raw);
    const p = catalogue.products.find((x) => x.sku === "photos-30");
    assert.equal(p.images.length, 30);
    assert.deepEqual(p.images[3], { src: `/api/store/photos/${ids[3]}`, alt: { en: "View 4", fr: "Vue 4" } });
    assert.ok(raw.length < 60_000, `catalogue is ${raw.length} bytes`);
  });

  await t.test("the API serves a photo by its address, cached for a year", async () => {
    const response = await fetch(`${base}/api/store/photos/${ids[7]}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("etag"), `"${ids[7]}"`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), photos[7]);
    const again = await fetch(`${base}/api/store/photos/${ids[7]}`, { headers: { "if-none-match": `"${ids[7]}"` } });
    assert.equal(again.status, 304);
    const head = await fetch(`${base}/api/store/photos/${ids[7]}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(photos[7].length));
    assert.equal((await fetch(`${base}/api/store/photos/${"f".repeat(64)}`)).status, 404);
    assert.equal((await fetch(`${base}/api/store/photos/not-an-id`)).status, 404);
  });

  await t.test("a photo saved inside a product before stays, and can be removed, but not added", async () => {
    const old = { data: dataUrl(photos[30]), alt: { en: "Old", fr: "Ancienne" } };
    await store.transaction((s) => { s.storeProducts.push({ id: "legacy", version: 1, ...product([old], { sku: "legacy" }), stock: 0 }); });
    const catalogue = await fetch(base + "/api/store/catalogue").then((r) => r.json());
    assert.deepEqual(catalogue.products.find((x) => x.id === "legacy").images, [{ src: old.data, alt: old.alt }]);
    const kept = await save(product([{ data: old.data, alt: { en: "Old photo", fr: "Ancienne photo" } }, { id: ids[0] }], { sku: "legacy", id: "legacy", version: 1 }));
    assert.equal(kept.status, 200, kept.data.error);
    const p = await saved("legacy");
    assert.deepEqual(p.images.map((image) => image.data ? "inline" : image.id), ["inline", ids[0]]);
    assert.equal(p.images[0].alt.en, "Old photo");
    const removed = await save(product([{ id: ids[0] }], { sku: "legacy", id: "legacy", version: 2 }));
    assert.equal(removed.status, 200, removed.data.error);
    assert.equal((await saved("legacy")).images.length, 1);
  });
});
