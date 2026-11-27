import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { storeState, reserveOrder, settleOrder, available, catalogue } from "../lib/device-store.mjs";
import { kitInput, kitFigures, publicKits, kitsSoldThisMonth, kitStatusChange } from "../lib/store-kits.mjs";
import { seedCatalogue, bundleInUse } from "../lib/catalogue.mjs";
import { hashSecret } from "../lib/security.mjs";

// Kits (#424): the catalogue and admin API, kit checkout priced by the server
// with an immutable copy, stock from every product, the Set up step, and the
// first bundle given at collection, unstarted.

const time = new Date("2030-01-10T10:00:00Z"), secret = "store-kits-tests";
const text = { en: "Router", fr: "Routeur" };
const product = (id, price, stock, overrides = {}) => ({ id, version: 1, sku: id.toUpperCase(), name: { en: id, fr: id }, description: text, specifications: text,
  compatibility: text, contents: text, warranty: text, setup: text, images: [], price, cost: 1, stock, status: "published", featured: false, categoryId: "", ...overrides });
const kitFields = (overrides = {}) => ({ name: { en: "Home kit", fr: "Kit maison" }, description: { en: "Wi-Fi for the whole house", fr: "Wi-Fi pour toute la maison" },
  items: [{ productId: "router", quantity: 1 }, { productId: "cable", quantity: 2 }], firstBundleId: "home-wisp-30d", price: 70000, setUp: true, ...overrides });
function state() {
  const s = storeState({ bundles: [], vouchers: [], payments: [], customers: [] });
  seedCatalogue(s, time);
  Object.assign(s.storeSettings, { open: true, pickup: "Akwa office", hours: "9–17", warranty: text, returns: text });
  s.storeProducts.push(product("router", 30000, 3), product("cable", 2000, 10));
  return s;
}

test("a kit is checked: catalogue products and bundle, each product once, Set up needs Home WISP", () => {
  const s = state();
  assert.deepEqual(kitInput(s, kitFields()).items, [{ productId: "router", quantity: 1 }, { productId: "cable", quantity: 2 }]);
  assert.throws(() => kitInput(s, kitFields({ items: [{ productId: "nope", quantity: 1 }] })), /Choose products from the store/);
  assert.throws(() => kitInput(s, kitFields({ items: [{ productId: "router", quantity: 1 }, { productId: "router", quantity: 1 }] })), /List each product once/);
  assert.throws(() => kitInput(s, kitFields({ firstBundleId: "weekly" })), /first bundle from the catalogue/);
  assert.throws(() => kitInput(s, kitFields({ firstBundleId: "unlimited-7d-2" })), /needs a Home WISP Unlimited first bundle/);
  assert.equal(kitInput(s, kitFields({ firstBundleId: "unlimited-7d-2", setUp: false })).setUp, false);
  assert.throws(() => kitInput(s, kitFields({ price: 70000.5 })));
  s.bundles.find((b) => b.id === "home-wisp-30d").status = "archived";
  assert.throws(() => kitInput(s, kitFields()), /first bundle from the catalogue/);
});

test("Bought separately and the saving come from current prices; the saving shows only when real", () => {
  const s = state(), k = { id: "kit-1", status: "on_sale", version: 1, ...kitInput(s, kitFields()) };
  s.storeKits.push(k);
  // 30,000 + 2 × 2,000 + 50,000 = 84,000 bought separately; the kit is 70,000.
  assert.deepEqual(kitFigures(s, k, time), { boughtSeparately: 84000, saving: 14000, available: 3 });
  const shop = publicKits(s, time);
  assert.equal(shop.length, 1);
  assert.deepEqual([shop[0].boughtSeparately, shop[0].saving, shop[0].price, shop[0].firstBundle.accessType], [84000, 14000, 70000, "home_wisp_unlimited"]);
  assert.deepEqual(Object.keys(shop[0].paymentQuotes).sort(), ["mtn", "orange"]);
  assert.equal(shop[0].paymentQuotes.mtn.price, 70000);
  // Not cheaper: no saving, and no "bought separately" in the shop.
  k.price = 90000;
  assert.equal(kitFigures(s, k, time).saving, null);
  assert.equal("saving" in publicKits(s, time)[0], false);
  // Draft, or a product unpublished: not in the shop.
  s.storeProducts[1].status = "draft";
  assert.deepEqual(publicKits(s, time), []);
  assert.deepEqual(catalogue(s, time).kits, []);
  assert.throws(() => kitStatusChange(s, k, "on_sale"), /once its products are published/);
  assert.equal(bundleInUse(s, "home-wisp-30d"), true, "a bundle in a kit is archived, never removed");
});

test("kit checkout: an account, the server's price, stock from every product, an immutable copy", () => {
  const s = state(), k = { id: "kit-1", status: "on_sale", version: 1, ...kitInput(s, kitFields()) };
  s.storeKits.push(k);
  const input = (overrides = {}) => ({ kitId: "kit-1", expectedPrice: 70000, name: "Amina", phone: "670000001", payerPhone: "690000002", network: "mtn", checkoutKey: randomUUID(), ...overrides });
  const reserve = (i, customerId = "c1") => reserveOrder(s, i, { now: time, secret, customerId, provider: "mesomb" });
  assert.throws(() => reserve(input(), null), /Sign in to buy a kit/);
  assert.throws(() => reserve(input({ expectedPrice: 1 })), /price changed/, "a tampered price is refused");
  // Installation and Pay in 3 only where the kit offers them (#427).
  assert.throws(() => reserve(input({ setup: "install" })), /isn't offered with installation/);
  assert.throws(() => reserve(input({ pay: "plan" })), /Pay in 3 isn't offered/);
  assert.throws(() => reserve(input({ quantity: 2 })), /one at a time/);
  const i = input(), { order } = reserve(i);
  assert.deepEqual([order.kitId, order.productId, order.quantity, order.unitPrice, order.payment.amount], ["kit-1", null, 1, 70000, 70000]);
  assert.deepEqual(order.lines, [{ productId: "router", quantity: 1 }, { productId: "cable", quantity: 2 }]);
  assert.deepEqual([order.kit.firstBundle.id, order.kit.firstBundle.price, order.kit.items[0].unitPrice, order.setup.status], ["home-wisp-30d", 50000, 30000, "pending"]);
  assert.equal(available(s, s.storeProducts[0], time), 2, "each product is reserved");
  assert.equal(available(s, s.storeProducts[1], time), 8);
  // The same checkout key replays the order; another purchase with it is refused.
  assert.equal(reserve(i).order.id, order.id);
  assert.throws(() => reserve({ ...i, network: "orange" }), /already used for another purchase/);
  // Later price and catalogue changes never change what was sold.
  k.price = 60000; s.bundles.find((b) => b.id === "home-wisp-30d").price = 55000;
  assert.deepEqual([order.unitPrice, order.kit.firstBundle.price], [70000, 50000]);
  // Stock can't oversell: three routers, one per kit.
  k.price = 70000;
  reserve(input()); reserve(input());
  assert.throws(() => reserve(input()), /Not enough stock/);
  // A kit whose first bundle is archived can't be bought.
  s.bundles.find((b) => b.id === "home-wisp-30d").status = "archived";
  assert.throws(() => reserve(input()), /Kit unavailable/);
  // Paid: every product's stock moves.
  settleOrder(s, order, { status: "paid", transactionReference: order.payment.id, providerReference: "ref-1", amount: 70000, currency: "XAF" }, time);
  assert.deepEqual([order.status, order.stockState, s.storeProducts[0].stock, s.storeProducts[1].stock], ["preparing", "consumed", 2, 8]);
  assert.equal(kitsSoldThisMonth(s, k, time), 1);
});

async function server(t) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    storeState(s); seedCatalogue(s, time);
    Object.assign(s.storeSettings, { open: true, pickup: "Akwa office", contact: "670000001", warranty: text, returns: text });
    s.storeProducts.push(product("router", 30000, 3), product("cable", 2000, 10));
    for (const role of ["owner", "operator"]) {
      s.adminUsers.push({ id: role, role, username: role, active: true });
      s.adminSessions.push({ id: role, userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: "csrf-" + role, expiresAt: "2031-01-01T00:00:00Z" });
    }
    s.customers.push({ id: "c1", name: "Amina Ndi", phone: "670000001" });
    s.dashboardSessions.push({ id: "c-session", customerId: "c1", tokenHash: hashSecret("customer", secret), csrfToken: "customer-csrf", expiresAt: "2031-01-01T00:00:00Z" });
  });
  const adapter = { configured: () => true, createPayment: async (p) => ({ status: "pending", providerReference: "ref-" + p.id }),
    verifyPayment: async (p) => ({ status: "paid", amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }),
    handleWebhook: async () => { throw Error(); }, refundPayment: async () => ({ status: "completed", providerReference: "refund-ref" }) };
  const app = createServer({ store, now: () => time, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", PAYMENT_MODE: "mesomb",
    STORE_APP_URL: "http://localhost:8083", CUSTOMER_APP_URL: "http://localhost:8080", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false" } });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { app.closeAllConnections(); app.close(r); }));
  const base = "http://127.0.0.1:" + app.address().port;
  const call = async (path, input, { role, customer } = {}) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { ...(input ? { "content-type": "application/json" } : {}),
      ...(role ? { cookie: "admin_session=" + role } : customer ? { cookie: "customer_session=customer", "x-csrf-token": "customer-csrf" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { store, call };
}

test("admin kits: saved as drafts, on sale when buyable, audited; Set up before ready; the first bundle at collection", async (t) => {
  const { store, call } = await server(t);
  const saved = await call("/api/admin/store/kits/save", kitFields(), { role: "operator" });
  assert.equal(saved.status, 200);
  let kit = saved.body.kits[0];
  assert.deepEqual([kit.status, kit.boughtSeparately, kit.saving, kit.available, kit.soldThisMonth, kit.firstBundle.name], ["draft", 84000, 14000, 3, 0, "Home WISP Unlimited"]);
  assert.deepEqual((await call("/api/store/catalogue")).body.kits, [], "a draft isn't in the shop");
  const onSale = await call("/api/admin/store/kits/status", { id: kit.id, version: kit.version, status: "on_sale" }, { role: "owner" });
  assert.equal(onSale.status, 200);
  kit = onSale.body.kits[0];
  assert.equal((await call("/api/store/catalogue")).body.kits[0].saving, 14000);
  assert.equal((await call("/api/admin/store/kits/save", { ...kitFields({ price: 65000 }), id: kit.id, version: 1 }, { role: "owner" })).status, 409, "a stale edit is refused");
  const audits = (await store.snapshot()).auditLogs.filter((a) => a.action.startsWith("store.kits"));
  assert.deepEqual(audits.map((a) => a.action).sort(), ["store.kits.save", "store.kits.status"]);
  // A product in a kit can't be deleted.
  const router = (await store.snapshot()).storeProducts.find((p) => p.id === "router");
  assert.equal((await call("/api/admin/store/products/delete", { id: "router", version: router.version }, { role: "owner" })).status, 409);

  // A guest can't buy it; a signed-in customer can, at the server's price.
  const checkout = { kitId: kit.id, expectedPrice: 70000, name: "Amina", phone: "670000001", payerPhone: "690000002", network: "mtn", checkoutKey: randomUUID() };
  assert.equal((await call("/api/store/checkout", checkout)).status, 401);
  const bought = await call("/api/account/store/checkout", checkout, { customer: true });
  assert.equal(bought.status, 200);
  const id = bought.body.order.id;
  assert.deepEqual([bought.body.order.kit.firstBundle.accessType, bought.body.order.setup.status], ["home_wisp_unlimited", "pending"]);
  await call("/api/account/store/verify", { orderId: id }, { customer: true });
  let o = (await store.snapshot()).storeOrders[0];
  assert.equal(o.status, "preparing");
  // Set up comes before ready.
  assert.equal((await call("/api/admin/store/orders/update", { id, version: o.version, action: "ready" }, { role: "owner" })).status, 409);
  assert.equal((await call("/api/admin/store/orders/update", { id, version: o.version, action: "setup" }, { role: "operator" })).status, 200);
  o = (await store.snapshot()).storeOrders[0];
  assert.equal((await call("/api/admin/store/orders/update", { id, version: o.version, action: "ready" }, { role: "owner" })).status, 200);
  o = (await store.snapshot()).storeOrders[0];
  assert.equal((await store.snapshot()).vouchers.some((v) => v.kit?.orderId === id), false, "nothing is given at payment");
  const collected = await call("/api/admin/store/orders/update", { id, version: o.version, action: "collect", collectionCode: o.collectionCode }, { role: "owner" });
  assert.equal(collected.status, 200);
  const s = await store.snapshot(), v = s.vouchers.find((x) => x.kit?.orderId === id);
  assert.deepEqual([v.customerId, v.status, v.activatedAt, v.startsOnFirstConnection, v.accessType, v.saleType, v.saleAmount], ["c1", "available", null, true, "home_wisp_unlimited", "gift", undefined],
    "unstarted until its router's first connection; the kit order carries the revenue");
  assert.equal(v.customTerms.price, 50000, "the bundle's terms as sold");
  assert.equal(s.storeOrders[0].kitBundle.voucherId, v.id);
  assert.deepEqual([s.storeProducts.find((p) => p.id === "router").stock, s.storeProducts.find((p) => p.id === "cable").stock], [2, 8]);
  assert.equal((await call("/api/admin/store", undefined, { role: "owner" })).body.kits[0].soldThisMonth, 1);
});
