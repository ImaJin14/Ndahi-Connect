import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { storeState } from "../lib/device-store.mjs";
import { hashSecret } from "../lib/security.mjs";

// A product's "Needs" line (PhoneProduct, #410; owner 26 Nov): the phone
// product page's tile, e.g. "Installation + alignment". It is optional, saved
// in English and French, published in the catalogue, and kept when a form
// without the field (the frozen v1 admin) saves the product.
const secret = "store-product-needs", words = { en: "Router", fr: "Routeur" };
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

test("a product's Needs line is saved in both languages, published, and optional", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/admin/store/products/save", product({ sku: "CPE210", needs: { en: "Installation + alignment", fr: "Installation + orientation" } }))).status, 200);
  assert.equal((await f.call("/api/admin/store/products/save", product({ sku: "MINI" }))).status, 200);
  const products = (await f.call("/api/store/catalogue")).body.products;
  assert.deepEqual(products.find((p) => p.sku === "CPE210").needs, { en: "Installation + alignment", fr: "Installation + orientation" });
  // Blank: the page shows no Needs tile.
  assert.deepEqual(products.find((p) => p.sku === "MINI").needs, { en: "", fr: "" });
  // Longer than one tile line is refused.
  assert.equal((await f.call("/api/admin/store/products/save", product({ needs: { en: "x".repeat(61), fr: "" } }))).status, 400);
});

test("saving a product without the field keeps its Needs line", async (t) => {
  const f = await fixture(t);
  await f.call("/api/admin/store/products/save", product({ sku: "CPE210", needs: { en: "Installation + alignment", fr: "Installation + orientation" } }));
  const [saved] = (await f.store.snapshot()).storeProducts;
  const { needs: _needs, ...v1 } = saved;
  assert.equal((await f.call("/api/admin/store/products/save", { ...v1, price: 12000 })).status, 200);
  const [after] = (await f.store.snapshot()).storeProducts;
  assert.equal(after.price, 12000);
  assert.deepEqual(after.needs, { en: "Installation + alignment", fr: "Installation + orientation" });
});
