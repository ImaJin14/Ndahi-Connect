import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { storeState, reserveOrder, orderLinkToken, trackedOrder, trackingToken, storeOrderLink } from "../lib/device-store.mjs";
import { createStoreCommerce } from "../lib/store-commerce.mjs";
import { storeOrderEmail } from "../lib/store-receipt.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createStaticServer } from "../static-server.mjs";

// The short private link (PhoneGuestOrder, #401; owner 26 Nov):
// store.ndahiconnect.net/o/<token> opens the order with the same private token,
// without the order id. New orders' tokens can be rebuilt by the server, so a
// guest's order emails carry the link; older orders keep the link they were
// given, and long #order/<id>/<token> links keep working.
const secret = "store-short-link", words = { en: "Router", fr: "Routeur" }, storeUrl = "https://store.example.test";
async function fixture(t) {
  const store = createStore({ persistent: false }), sent = [];
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Office", contact: "670000001", warranty: words, returns: words };
    s.storeProducts.push({ id: "p1", version: 1, stock: 5, sku: "P1", name: words, description: words, specifications: words, compatibility: words, contents: words, warranty: words, setup: words,
      images: [], price: 10000, cost: 1, status: "published", featured: false, categoryId: "" });
    s.customers.push({ id: "amina", name: "Amina", phone: "670000002" });
    s.dashboardSessions.push({ id: "amina", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf-amina", expiresAt: "2099-01-01T00:00:00Z" });
  });
  const email = { configured: () => true, sendStoreOrder: async (input) => { sent.push(input); return { messageId: String(sent.length) }; } };
  const server = createServer({ store, email, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", STORE_APP_URL: storeUrl, CUSTOMER_APP_URL: "http://localhost:8080",
    CUSTOMER_SESSION_SECRET: secret, ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, input, who) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(who ? { cookie: `customer_session=${who}`, "x-csrf-token": `csrf-${who}` } : {}) }, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json() };
  };
  const buy = (extra = {}, who) => post(who ? "/api/account/store/checkout" : "/api/store/checkout", { checkoutKey: randomUUID(), productId: "p1", quantity: 1, expectedPrice: 10000,
    name: "Paul", phone: "670000009", payerPhone: "670000009", email: "paul@example.test", network: "mtn", ...extra }, who);
  return { store, post, buy, sent };
}

test("a short link opens its order from the token alone, and a wrong one opens nothing", async (t) => {
  const f = await fixture(t);
  const bought = await f.buy();
  assert.equal(bought.status, 200);
  const opened = await f.post("/api/store/order", { token: bought.body.token });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.order.id, bought.body.order.id);
  assert.equal((await f.post("/api/store/order", { token: "x".repeat(43) })).status, 404);
  assert.equal((await f.post("/api/store/order", { token: "short" })).status, 404);
  // The long link keeps working.
  assert.equal((await f.post("/api/store/order", { orderId: bought.body.order.id, token: bought.body.token })).status, 200);
  // Check payment and the receipt work from the short link too.
  assert.equal((await f.post("/api/store/verify", { token: bought.body.token })).status, 200);
});

test("new orders' links can be rebuilt by the server; a retried checkout gets the same link", async (t) => {
  const f = await fixture(t);
  const key = randomUUID(), first = await f.buy({ checkoutKey: key }), again = await f.buy({ checkoutKey: key });
  assert.equal(again.body.token, first.body.token);
  const [order] = (await f.store.snapshot()).storeOrders;
  assert.equal(orderLinkToken(order, secret), first.body.token);
  assert.equal(trackedOrder([order], first.body.token, secret)?.id, order.id);
});

test("an older order keeps the link it was given; the server can't rebuild it, so its email keeps the old line", async () => {
  const s = storeState({});
  s.storeSettings = { ...s.storeSettings, open: true, pickup: "Office", contact: "670000001", warranty: words, returns: words };
  s.storeProducts.push({ id: "p1", version: 1, stock: 5, sku: "P1", name: words, description: words, specifications: words, compatibility: words, contents: words, warranty: words, setup: words,
    images: [], price: 10000, cost: 1, status: "published", featured: false, categoryId: "" });
  const key = randomUUID(), { order } = reserveOrder(s, { checkoutKey: key, productId: "p1", quantity: 1, expectedPrice: 10000, name: "Paul", phone: "670000009", payerPhone: "670000009", network: "mtn" },
    { now: new Date(), secret, provider: "mock" });
  // Before #401 the token came from the checkout key, which only the buyer holds.
  const old = trackingToken(order.id, key, secret);
  order.trackingHash = hashSecret(old, secret);
  assert.equal(orderLinkToken(order, secret), null);
  assert.equal(trackedOrder(s.storeOrders, old, secret)?.id, order.id, "its token still opens it, long or short");
  // A retried checkout returns the token it was given.
  assert.equal(reserveOrder(s, { checkoutKey: key, productId: "p1", quantity: 1, expectedPrice: 10000, name: "Paul", phone: "670000009", payerPhone: "670000009", network: "mtn" },
    { now: new Date(), secret, provider: "mock" }).token, old);
});

test("a guest's order emails carry the short link; an account's don't", async (t) => {
  const f = await fixture(t);
  const guest = await f.buy();
  const mine = await f.buy({ phone: "670000002", payerPhone: "670000002" }, "amina");
  assert.equal(mine.status, 200);
  const orders = (await f.store.snapshot()).storeOrders, byId = (id) => orders.find((o) => o.id === id);
  assert.equal(storeOrderLink(byId(guest.body.order.id), secret, `${storeUrl}/`), `${storeUrl}/o/${guest.body.token}`);
  assert.equal(storeOrderLink(byId(mine.body.order.id), secret, storeUrl), null, "an account's order is in Activity");
  // The worker passes each order's link to the email.
  const sent = [];
  const commerce = createStoreCommerce({ store: f.store, pays: {}, clock: () => new Date(), orderLink: (o) => storeOrderLink(o, secret, storeUrl),
    email: { configured: () => true, sendStoreOrder: async (input) => sent.push(input) } });
  await commerce.run();
  const toGuest = sent.find((m) => m.order.id === guest.body.order.id), toAmina = sent.find((m) => m.order.id === mine.body.order.id);
  assert.equal(toGuest.link, `${storeUrl}/o/${guest.body.token}`);
  assert.equal(toAmina.link, null);
  // The message itself.
  const message = storeOrderEmail(toGuest.order, { link: toGuest.link });
  assert.match(message.text, new RegExp(`Track your order with your private link: ${storeUrl}/o/${guest.body.token}\\nAnyone with the link can see this order\\. Do not post it publicly\\.`));
  assert.match(message.html, new RegExp(`href="${storeUrl}/o/${guest.body.token}"[^>]*>Track my order</a>`));
  assert.match(storeOrderEmail(toGuest.order).text, /Keep the private tracking link saved at checkout\.\nDo not post it publicly\./);
});

test("the store serves its page for a short link, and only for one", async (t) => {
  const server = createStaticServer("store", { apiUrl: "http://127.0.0.1:9", env: { NODE_ENV: "test" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/o/${"a".repeat(43)}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="view">/);
  assert.equal((await fetch(`${base}/o/short`)).status, 404);
  assert.equal((await fetch(`${base}/o/${"a".repeat(43)}/more`)).status, 404);
});
