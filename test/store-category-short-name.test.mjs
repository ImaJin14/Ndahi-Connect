import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { storeState } from "../lib/device-store.mjs";
import { hashSecret } from "../lib/security.mjs";

// A category's short name (PhoneShop, #414; owner 26 Nov): the phone Shop's
// chip reads "Travel" for "Travel routers". It is optional, saved in English
// and French, published in the catalogue, and kept when a form without the
// field (the frozen v1 admin) saves the category.
const secret = "store-category-short-name";
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

test("a category's short name is saved in both languages, published, and optional", async (t) => {
  const f = await fixture(t);
  const saved = await f.call("/api/admin/store/categories/save", { name: { en: "Travel routers", fr: "Routeurs de voyage" }, shortName: { en: "Travel", fr: "Voyage" }, position: 0, hidden: false });
  assert.equal(saved.status, 200);
  const [category] = (await f.store.snapshot()).storeCategories;
  assert.deepEqual(category.shortName, { en: "Travel", fr: "Voyage" });
  const published = (await f.call("/api/store/catalogue")).body.categories[0];
  assert.deepEqual(published.shortName, { en: "Travel", fr: "Voyage" });
  // Blank is allowed: the chip shows the full name.
  assert.equal((await f.call("/api/admin/store/categories/save", { name: { en: "Wi-Fi devices", fr: "Appareils Wi-Fi" }, position: 1, hidden: false })).status, 200);
  assert.deepEqual((await f.store.snapshot()).storeCategories[1].shortName, { en: "", fr: "" });
  // Longer than a chip allows is refused.
  assert.equal((await f.call("/api/admin/store/categories/save", { name: { en: "Long", fr: "Long" }, shortName: { en: "x".repeat(31), fr: "" }, position: 2, hidden: false })).status, 400);
});

test("saving a category without the field keeps its short name", async (t) => {
  const f = await fixture(t);
  await f.call("/api/admin/store/categories/save", { name: { en: "Outdoor networking", fr: "Réseaux extérieurs" }, shortName: { en: "Outdoor", fr: "Extérieur" }, position: 0, hidden: false });
  const [category] = (await f.store.snapshot()).storeCategories;
  const v1 = await f.call("/api/admin/store/categories/save", { id: category.id, version: category.version, name: { en: "Outdoor networking", fr: "Réseaux extérieurs" }, position: 3, hidden: false });
  assert.equal(v1.status, 200);
  const after = (await f.store.snapshot()).storeCategories[0];
  assert.equal(after.position, 3);
  assert.deepEqual(after.shortName, { en: "Outdoor", fr: "Extérieur" });
});
