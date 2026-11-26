import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { storeState } from "../lib/device-store.mjs";
import { hashSecret } from "../lib/security.mjs";

// Change payment (PhoneCheckout, #397; owner 26 Nov): a signed-in customer
// cancels their own unpaid order, its device goes back into stock, and they
// can send a fresh request. The provider is asked first, so a payment just
// approved is settled instead of cancelled; one approved after cancelling goes
// to review for a refund, as a late payment on an expired order does.
const secret = "store-change-payment", words = { en: "Router", fr: "Routeur" };
async function fixture(t) {
  const store = createStore({ persistent: false });
  let providerStatus = "pending", clock = new Date("2030-01-01T10:00:00Z");
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Office", contact: "670000001", warranty: words, returns: words };
    s.storeProducts.push({ id: "p1", version: 1, stock: 1, sku: "P1", name: words, description: words, specifications: words, compatibility: words, contents: words, warranty: words, setup: words,
      images: [], price: 10000, cost: 1, status: "published", featured: false, categoryId: "" });
    for (const id of ["amina", "other"]) {
      s.customers.push({ id, name: id, phone: id === "amina" ? "670000001" : "670000002" });
      s.dashboardSessions.push({ id, customerId: id, tokenHash: hashSecret(id, secret), csrfToken: `csrf-${id}`, expiresAt: "2099-01-01T00:00:00Z" });
    }
  });
  const adapter = {
    configured: () => true,
    createPayment: async (p) => ({ status: "pending", providerReference: `ref-${p.id}` }),
    verifyPayment: async (p) => ({ status: providerStatus, amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }),
    handleWebhook: async (raw) => JSON.parse(raw),
    refundPayment: async () => ({ status: "completed", providerReference: "refund" }),
  };
  const server = createServer({ store, now: () => clock, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", PAYMENT_MODE: "mesomb",
    CUSTOMER_APP_URL: "http://localhost:8080", CUSTOMER_SESSION_SECRET: secret, ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, NETWORK_QUEUE_ENABLED: "false",
    BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, input, who = "amina") => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie: `customer_session=${who}`, "x-csrf-token": `csrf-${who}` }, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json() };
  };
  const checkout = () => call("/api/account/store/checkout", { checkoutKey: randomUUID(), productId: "p1", quantity: 1, expectedPrice: 10000, name: "Amina", phone: "670000001", payerPhone: "670000001", network: "mtn" });
  const available = async () => (await (await fetch(`${base}/api/store/catalogue`)).json()).products[0].available;
  return { store, base, call, checkout, available, setProvider: (status) => { providerStatus = status; }, advance: (ms) => { clock = new Date(+clock + ms); } };
}

test("Change payment cancels the customer's unpaid order and frees its device for a fresh request", async (t) => {
  const f = await fixture(t);
  const first = await f.checkout();
  assert.equal(first.status, 200);
  assert.equal(await f.available(), 0, "the only unit is held while the customer approves");
  // A second request can't be sent while the first holds the device.
  assert.equal((await f.checkout()).status, 409);
  const cancelled = await f.call("/api/account/store/cancel", { orderId: first.body.order.id });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.order.status, "cancelled");
  assert.equal(await f.available(), 1, "the device goes back into stock");
  const saved = (await f.store.snapshot()).storeOrders.find((o) => o.id === first.body.order.id);
  assert.equal(saved.stockState, "released");
  assert.deepEqual(saved.history.map((h) => [h.action, h.actor]), [["payment_changed", "customer"]]);
  // Cancelling again changes nothing.
  const again = await f.call("/api/account/store/cancel", { orderId: first.body.order.id });
  assert.equal(again.status, 200);
  assert.equal((await f.store.snapshot()).storeOrders.find((o) => o.id === first.body.order.id).version, saved.version);
  // The fresh request goes through.
  const second = await f.checkout();
  assert.equal(second.status, 200);
  assert.notEqual(second.body.order.id, first.body.order.id);
});

test("a payment approved anyway after Change payment goes to review for a refund", async (t) => {
  const f = await fixture(t);
  const first = await f.checkout();
  await f.call("/api/account/store/cancel", { orderId: first.body.order.id });
  f.setProvider("paid");
  // The provider is checked again on its usual schedule.
  f.advance(31000);
  const late = await f.call("/api/account/store/verify", { orderId: first.body.order.id });
  assert.equal(late.status, 200);
  assert.equal(late.body.order.status, "review");
  assert.equal(late.body.order.paymentReview, "late_payment");
  assert.equal(await f.available(), 1, "a late payment never takes the device back");
});

test("Change payment asks the provider first: a payment just approved is settled, not cancelled", async (t) => {
  const f = await fixture(t);
  const first = await f.checkout();
  f.setProvider("paid");
  const result = await f.call("/api/account/store/cancel", { orderId: first.body.order.id });
  assert.equal(result.status, 200);
  assert.equal(result.body.order.paymentStatus, "paid");
  assert.equal(result.body.order.status, "preparing");
});

test("only the account's own unpaid orders can be changed", async (t) => {
  const f = await fixture(t);
  const first = await f.checkout();
  // Another account can't see or cancel it.
  assert.equal((await f.call("/api/account/store/cancel", { orderId: first.body.order.id }, "other")).status, 404);
  assert.equal((await f.store.snapshot()).storeOrders[0].status, "awaiting_payment");
  // An account's order can't be changed from the public store, even with its link.
  const guest = await fetch(`${f.base}/api/store/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: first.body.order.id, token: first.body.token }) });
  assert.equal(guest.status, 404);
  assert.equal((await f.store.snapshot()).storeOrders[0].status, "awaiting_payment");
  // A paid order stays as it is.
  f.setProvider("paid");
  f.advance(31000);
  await f.call("/api/account/store/verify", { orderId: first.body.order.id });
  const paid = await f.call("/api/account/store/cancel", { orderId: first.body.order.id });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.order.status, "preparing");
});

// Guest checkout (PhoneGuestCheckout, #400; owner 26 Nov): Change payment on a
// guest order works with the order's private link only, and asks the provider
// first, as the account route does.
test("a guest changes payment on their own order with its private link", async (t) => {
  const f = await fixture(t);
  const post = async (path, input) => { const r = await fetch(f.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); return { status: r.status, body: await r.json() }; };
  const guest = () => post("/api/store/checkout", { checkoutKey: randomUUID(), productId: "p1", quantity: 1, expectedPrice: 10000, name: "Paul", phone: "670000009", payerPhone: "670000009", network: "mtn" });
  const first = await guest();
  assert.equal(first.status, 200);
  assert.equal(await f.available(), 0, "the unpaid order holds the device");
  // Without the link, or with another one, nothing changes.
  assert.equal((await post("/api/store/cancel", { orderId: first.body.order.id })).status, 404);
  assert.equal((await post("/api/store/cancel", { orderId: first.body.order.id, token: "not-the-link" })).status, 404);
  assert.equal((await f.store.snapshot()).storeOrders[0].status, "awaiting_payment");
  // With it, the request is cancelled and the device is back for a fresh one.
  const cancelled = await post("/api/store/cancel", { orderId: first.body.order.id, token: first.body.token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.order.status, "cancelled");
  assert.equal(await f.available(), 1);
  const again = await guest();
  assert.equal(again.status, 200);
  // Approved a moment ago: the provider is asked first, so it is settled, not cancelled.
  f.setProvider("paid");
  const paid = await post("/api/store/cancel", { orderId: again.body.order.id, token: again.body.token });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.order.paymentStatus, "paid");
  assert.equal(paid.body.order.status, "preparing");
});
