import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { storeState, newCollectionCode } from "../lib/device-store.mjs";
import { hashSecret } from "../lib/security.mjs";

// Order tracking (PhoneOrder, #406; owner 26 Nov): new orders get a 6-digit
// collection code; the order shows when it was paid, made ready and collected,
// and a ready order "Held for you until <date>", from a hold period the owner
// sets in the store settings (14 days unless changed).
const secret = "store-order-tracking", words = { en: "Router", fr: "Routeur" };
async function fixture(t) {
  const store = createStore({ persistent: false });
  let clock = new Date("2030-01-01T10:00:00Z");
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Office", contact: "670000001", warranty: words, returns: words };
    s.storeProducts.push({ id: "p1", version: 1, stock: 3, sku: "P1", name: words, description: words, specifications: words, compatibility: words, contents: words, warranty: words, setup: words,
      images: [], price: 10000, cost: 1, status: "published", featured: false, categoryId: "" });
    s.customers.push({ id: "amina", name: "Amina", phone: "670000001" });
    s.dashboardSessions.push({ id: "amina", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf-amina", expiresAt: "2099-01-01T00:00:00Z" });
    s.adminUsers.push({ id: "owner", role: "owner", username: "owner", active: true });
    s.adminSessions.push({ id: "owner", userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "csrf-owner", expiresAt: "2099-01-01T00:00:00Z" });
  });
  const adapter = { configured: () => true, createPayment: async (p) => ({ status: "pending", providerReference: `ref-${p.id}` }),
    verifyPayment: async (p) => ({ status: "paid", amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }),
    handleWebhook: async (raw) => JSON.parse(raw), refundPayment: async () => ({ status: "completed", providerReference: "r" }) };
  const server = createServer({ store, now: () => clock, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", PAYMENT_MODE: "mesomb",
    CUSTOMER_APP_URL: "http://localhost:8080", CUSTOMER_SESSION_SECRET: secret, ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, NETWORK_QUEUE_ENABLED: "false",
    BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, input, cookie) => {
    const [name, csrf] = cookie === "owner" ? ["admin_session=owner", "csrf-owner"] : ["customer_session=amina", "csrf-amina"];
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie: name, "x-csrf-token": csrf }, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json() };
  };
  return { store, post, advance: (ms) => { clock = new Date(+clock + ms); } };
}
const buy = (f) => f.post("/api/account/store/checkout", { checkoutKey: randomUUID(), productId: "p1", quantity: 1, expectedPrice: 10000, name: "Amina", phone: "670000001", payerPhone: "670000001", network: "mtn" });

test("a new order gets a 6-digit collection code, and staff collect with it", async (t) => {
  const f = await fixture(t);
  const { body } = await buy(f);
  await f.post("/api/account/store/verify", { orderId: body.order.id });
  const order = (await f.store.snapshot()).storeOrders[0];
  assert.match(order.collectionCode, /^\d{6}$/);
  const ready = await f.post("/api/admin/store/orders/update", { id: order.id, version: order.version, action: "ready" }, "owner");
  assert.equal(ready.status, 200);
  const latest = (await f.store.snapshot()).storeOrders[0];
  // A wrong code is refused.
  const wrong = order.collectionCode.slice(0, 5) + ((Number(order.collectionCode[5]) + 1) % 10);
  assert.ok((await f.post("/api/admin/store/orders/update", { id: order.id, version: latest.version, action: "collect", collectionCode: wrong }, "owner")).status >= 400);
  const collected = await f.post("/api/admin/store/orders/update", { id: order.id, version: (await f.store.snapshot()).storeOrders[0].version, action: "collect", collectionCode: order.collectionCode }, "owner");
  assert.equal(collected.status, 200);
});

test("a code is never one an open order already has", () => {
  // Half of all codes are held by open orders: every new code is from the other half.
  const s = storeState({});
  for (let n = 0; n < 500000; n++) s.storeOrders.push({ status: "ready", collectionCode: String(n).padStart(6, "0") });
  for (let n = 0; n < 20; n++) {
    const code = newCollectionCode(s);
    assert.match(code, /^\d{6}$/);
    assert.ok(Number(code) >= 500000, "a free code, not an open order's");
  }
  // A collected or cancelled order's code can be given again.
  assert.match(newCollectionCode({ storeOrders: [{ status: "collected", collectionCode: "123456" }] }), /^\d{6}$/);
});

test("the order shows when each step happened and how long a ready order is held", async (t) => {
  const f = await fixture(t);
  const { body } = await buy(f);
  const paid = await f.post("/api/account/store/verify", { orderId: body.order.id });
  assert.equal(paid.body.order.progress.paidAt, "2030-01-01T10:00:00.000Z");
  assert.equal(paid.body.order.progress.readyAt, null);
  assert.equal(paid.body.order.holdUntil, null);
  f.advance(86400000);
  let order = (await f.store.snapshot()).storeOrders[0];
  await f.post("/api/admin/store/orders/update", { id: order.id, version: order.version, action: "ready" }, "owner");
  let view = (await f.post("/api/account/store/order", { orderId: order.id })).body.order;
  assert.equal(view.progress.readyAt, "2030-01-02T10:00:00.000Z");
  assert.equal(view.holdUntil, "2030-01-16T10:00:00.000Z", "14 days by default");
  // The owner holds ready orders 10 days instead.
  const settings = (await f.store.snapshot()).storeSettings;
  assert.equal((await f.post("/api/admin/store/settings/save", { ...settings, readyHoldDays: 10 }, "owner")).status, 200);
  view = (await f.post("/api/account/store/order", { orderId: order.id })).body.order;
  assert.equal(view.holdUntil, "2030-01-12T10:00:00.000Z");
  // Collected: no hold date, and the time it was collected.
  f.advance(3600000);
  order = (await f.store.snapshot()).storeOrders[0];
  await f.post("/api/admin/store/orders/update", { id: order.id, version: order.version, action: "collect", collectionCode: order.collectionCode }, "owner");
  view = (await f.post("/api/account/store/order", { orderId: order.id })).body.order;
  assert.equal(view.progress.collectedAt, "2030-01-02T11:00:00.000Z");
  assert.equal(view.holdUntil, null);
});

test("the hold period is 1 to 90 days, and a save without it keeps it", async (t) => {
  const f = await fixture(t);
  const save = async (extra) => f.post("/api/admin/store/settings/save", { ...(await f.store.snapshot()).storeSettings, ...extra }, "owner");
  assert.equal((await save({ readyHoldDays: 0 })).status, 400);
  assert.equal((await save({ readyHoldDays: 91 })).status, 400);
  assert.equal((await save({ readyHoldDays: 21 })).status, 200);
  const { readyHoldDays: _days, ...v1 } = (await f.store.snapshot()).storeSettings;
  assert.equal((await f.post("/api/admin/store/settings/save", v1, "owner")).status, 200);
  assert.equal((await f.store.snapshot()).storeSettings.readyHoldDays, 21);
});
