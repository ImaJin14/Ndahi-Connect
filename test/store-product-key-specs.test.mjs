import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { storeState } from "../lib/device-store.mjs";
import { hashSecret } from "../lib/security.mjs";

// A product's key specs (ProductDesktop, #415; owner 26 Nov): up to 12 short
// label/value rows that fill the product page's spec table ("Band — 2.4 GHz").
// English is required for each row, French optional; blank rows are dropped.
// They are published in the catalogue and kept when a form without the field
// (the frozen v1 admin) saves the product.
const secret = "store-product-key-specs", words = { en: "Router", fr: "Routeur" };
const product = (overrides) => ({ sku: randomUUID(), name: words, description: words, specifications: words, compatibility: words, contents: words, warranty: words, setup: words,
  images: [], price: 10000, cost: 1, status: "published", featured: false, categoryId: "", ...overrides });
async function fixture(t) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    storeState(s);
    s.adminUsers.push({ id: "owner", role: "owner", username: "owner", active: true });
    s.adminSessions.push({ id: "owner", userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "csrf-owner", expiresAt: "2099-01-01T00:00:00Z" });
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, input) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { cookie: "admin_session=owner", "x-csrf-token": "csrf-owner", ...(input ? { "content-type": "application/json" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { store, call };
}

const spec = (label, value, fr = {}) => ({ label: { en: label, fr: fr.label || "" }, value: { en: value, fr: fr.value || "" } });
test("a product's key specs are saved, published, trimmed of blank rows, and checked", async (t) => {
  const f = await fixture(t);
  const rows = [spec("Band", "2.4 GHz", { label: "Bande" }), spec("Antenna", "9 dBi directional"), spec("", ""), spec("Power", "Passive PoE")];
  assert.equal((await f.call("/api/admin/store/products/save", product({ sku: "CPE210", keySpecs: rows }))).status, 200);
  const products = (await f.call("/api/store/catalogue")).body.products;
  assert.deepEqual(products.find((p) => p.sku === "CPE210").keySpecs, [spec("Band", "2.4 GHz", { label: "Bande" }), spec("Antenna", "9 dBi directional"), spec("Power", "Passive PoE")]);
  // None: the page shows the product's texts as rows instead.
  assert.equal((await f.call("/api/admin/store/products/save", product({ sku: "MINI" }))).status, 200);
  assert.deepEqual((await f.call("/api/store/catalogue")).body.products.find((p) => p.sku === "MINI").keySpecs, []);
  // A row needs its English label and value; at most 12 rows; short lines only.
  for (const keySpecs of [[spec("Band", "")], [spec("", "2.4 GHz")], Array.from({ length: 13 }, (_, i) => spec("Row " + i, "x")), [spec("x".repeat(41), "x")], [spec("Band", "x".repeat(121))], "Band: 2.4 GHz"])
    assert.equal((await f.call("/api/admin/store/products/save", product({ keySpecs }))).status, 400, JSON.stringify(keySpecs).slice(0, 60));
});

test("saving a product without the field keeps its key specs", async (t) => {
  const f = await fixture(t);
  await f.call("/api/admin/store/products/save", product({ sku: "CPE210", keySpecs: [spec("Band", "2.4 GHz")] }));
  const [saved] = (await f.store.snapshot()).storeProducts;
  const { keySpecs: _rows, ...v1 } = saved;
  assert.equal((await f.call("/api/admin/store/products/save", { ...v1, price: 12000 })).status, 200);
  const [after] = (await f.store.snapshot()).storeProducts;
  assert.equal(after.price, 12000);
  assert.deepEqual(after.keySpecs, [spec("Band", "2.4 GHz")]);
});
