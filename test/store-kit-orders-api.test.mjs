import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { storeState } from "../lib/device-store.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";
import { createStoreCommerce } from "../lib/store-commerce.mjs";
import { hashSecret } from "../lib/security.mjs";

// One kit order flow (#427) through the API: installation (#425) and Pay in 3
// (#426) at checkout, the plan's payments, Set up, the visit, and Couldn't install.
const time = new Date("2026-11-19T10:00:00Z"), secret = "kit-orders-api-tests";
const text = { en: "Router", fr: "Routeur" };
const product = { id: "router", version: 1, sku: "AX1500", name: { en: "TP-Link AX1500", fr: "TP-Link AX1500" }, description: text, specifications: text, compatibility: text,
  contents: text, warranty: text, setup: text, images: [], price: 30000, cost: 1, stock: 4, status: "published", featured: false, categoryId: "" };

async function server(t) {
  const store = createStore({ persistent: false });
  let now = time;
  await store.transaction((s) => {
    storeState(s); seedCatalogue(s, time);
    Object.assign(s.storeSettings, { open: true, pickup: "Akwa office", contact: "670000001", warranty: text, returns: text });
    s.storeProducts.push(structuredClone(product));
    for (const role of ["owner", "operator"]) {
      s.adminUsers.push({ id: role, role, username: role, active: true });
      s.adminSessions.push({ id: role, userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: "csrf-" + role, expiresAt: "2031-01-01T00:00:00Z" });
    }
    s.customers.push({ id: "c1", name: "Amina Ndi", phone: "670000001", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "c-session", customerId: "c1", tokenHash: hashSecret("customer", secret), csrfToken: "customer-csrf", expiresAt: "2031-01-01T00:00:00Z" });
  });
  const adapter = { configured: () => true, createPayment: async (p) => ({ status: "pending", providerReference: "ref-" + p.id }),
    verifyPayment: async (p) => ({ status: "paid", amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }),
    handleWebhook: async () => { throw Error(); }, refundPayment: async (p) => ({ status: "completed", providerReference: "refund-" + p.id + "-" + p.amount }),
    verifyRefund: async () => ({ status: "completed" }) };
  const app = createServer({ store, now: () => now, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", PAYMENT_MODE: "mesomb",
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
  const commerce = createStoreCommerce({ store, pays: { mesomb: adapter }, clock: () => now, email: null });
  return { store, call, commerce, at: (iso) => (now = new Date(iso)) };
}
const order = async (store, id) => (await store.snapshot()).storeOrders.find((o) => o.id === id);

test("a Home kit with installation and Pay in 3, through the API: booked, paid in 3, set up, installed and collected", async (t) => {
  const { store, call, commerce, at } = await server(t);
  assert.equal((await call("/api/store/installations")).body.open, false, "closed until staff set it up");
  assert.equal((await call("/api/admin/store/installations/settings", { price: 15000, areas: [{ id: "akwa", name: "Akwa", town: "Douala", travelFee: 2000 }],
    capacity: { morning: 1, afternoon: 1 }, technicians: [{ id: "eric", name: "Eric" }] }, { role: "operator" })).status, 200);
  assert.equal((await call("/api/admin/store/plans/rules", { depositPct: 40, days: 30, grace: 7, minPrice: 50000 }, { role: "owner" })).status, 200);
  let snap = (await call("/api/admin/store/kits/save", { name: { en: "Home kit", fr: "Kit maison" }, items: [{ productId: "router", quantity: 1 }], firstBundleId: "home-wisp-30d",
    price: 70000, setUp: true, installation: true, payIn3: true }, { role: "owner" })).body;
  const kit = snap.kits[0];
  await call("/api/admin/store/kits/status", { id: kit.id, version: kit.version, status: "on_sale" }, { role: "owner" });

  const installs = (await call("/api/store/installations")).body;
  assert.deepEqual([installs.open, installs.price, installs.areas[0].travelFee, installs.days[0].day], [true, 15000, 2000, "2026-11-20"]);
  const quote = (await call(`/api/store/kits/quote?kitId=${kit.id}&setup=install&areaId=akwa&pay=plan`, undefined, { customer: true })).body;
  assert.deepEqual([quote.today, quote.total, quote.planEligible, quote.plan.payments.map((p) => p.amount)], [45000, 87000, true, [28000, 21000, 21000]]);

  const bought = await call("/api/account/store/checkout", { kitId: kit.id, expectedPrice: 70000, expectedAmount: 45000, setup: "install", pay: "plan",
    installation: { day: "2026-11-21", slot: "morning", areaId: "akwa", directions: "Behind the Total station", phone: "670000009" },
    name: "Amina", phone: "670000001", payerPhone: "690000002", network: "mtn", checkoutKey: randomUUID() }, { customer: true });
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const id = bought.body.order.id;
  await call("/api/account/store/verify", { orderId: id }, { customer: true });
  let o = await order(store, id);
  assert.deepEqual([o.payment.status, o.plan.status, o.installation.status], ["paid", "running", "booked"]);
  assert.equal((await call("/api/account/store/order", { orderId: id }, { customer: true })).body.order.collectionCode, undefined, "no code before it's fully paid");
  snap = (await call("/api/admin/store", undefined, { role: "owner" })).body;
  assert.equal(snap.orders.find((x) => x.id === id).nextAction, "await_plan");
  assert.equal(snap.plans.metrics.running, 1);
  assert.ok(snap.kitBundles.some((b) => b.id === "home-wisp-30d" && b.accessType === "home_wisp_unlimited"), "the Unlimited bundles a kit can give");
  // The plan screen's buttons: the next payment and the rest, with the deposit's network fee.
  const tracked = (await call("/api/account/store/order", { orderId: id }, { customer: true })).body;
  assert.deepEqual([tracked.planQuotes.network, tracked.planQuotes.next.price, tracked.planQuotes.rest.price], ["mtn", 21000, 42000]);
  assert.ok("fee" in tracked.planQuotes.rest, "a fee when the fee rules are set");

  // The customer moves the visit (more than 24 h before), then pays the rest at once.
  const moved = await call("/api/account/store/installation", { orderId: id, action: "move", day: "2026-11-23", slot: "afternoon" }, { customer: true });
  assert.deepEqual([moved.status, moved.body.order.installation.day, moved.body.order.installation.status], [200, "2026-11-23", "moved"]);
  // Charged to the deposit's number and network, straight from the button (owner, 27 Nov, #375).
  const rest = await call("/api/account/store/plan/pay", { orderId: id, which: "rest", expectedAmount: 42000, checkoutKey: randomUUID() }, { customer: true });
  assert.equal(rest.status, 200, JSON.stringify(rest.body));
  assert.equal(rest.body.order.payment?.network ?? (await order(store, rest.body.order.id)).payment.network, "mtn");
  assert.equal((await order(store, rest.body.order.id)).payment.payerPhone, (await order(store, id)).payment.payerPhone);
  assert.deepEqual([rest.body.order.kind, rest.body.order.covers, rest.body.parent.id], ["plan_payment", [2, 3], id]);
  await call("/api/account/store/verify", { orderId: rest.body.order.id }, { customer: true });
  o = await order(store, id);
  assert.equal(o.plan.status, "completed");
  const context = (await call("/api/account/store/context", undefined, { customer: true })).body;
  assert.deepEqual(context.orders.map((x) => x.id), [id], "the plan's payment shows inside its kit order");

  // Staff: Set up, then the visit hands it over.
  snap = (await call("/api/admin/store", undefined, { role: "owner" })).body;
  assert.equal(snap.orders.find((x) => x.id === id).nextAction, "setup");
  await call("/api/admin/store/orders/update", { id, version: o.version, action: "setup" }, { role: "operator" });
  o = await order(store, id);
  assert.equal((await call("/api/admin/store/orders/update", { id, version: o.version, action: "ready" }, { role: "owner" })).status, 409, "handed over at the visit");
  assert.equal((await call("/api/admin/store/installations/update", { id, version: o.version, action: "assign", technicianId: "eric" }, { role: "operator" })).status, 200);
  o = await order(store, id);
  await call("/api/admin/store/installations/update", { id, version: o.version, action: "on_the_way" }, { role: "operator" });
  o = await order(store, id);
  const done = await call("/api/admin/store/installations/update", { id, version: o.version, action: "installed", signal: "-62 dBm" }, { role: "operator" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const s = await store.snapshot();
  o = s.storeOrders.find((x) => x.id === id);
  assert.deepEqual([o.status, o.installation.status, o.installation.signal, o.installation.technicianId], ["collected", "installed", "-62 dBm", "eric"]);
  assert.equal(s.vouchers.some((v) => v.kit?.orderId === id && v.status === "available"), true, "the first bundle, unstarted");
  assert.ok(s.auditLogs.some((a) => a.action === "store.installations.update"));

  // Another order: Couldn't install refunds exactly the installation and travel.
  at("2026-11-20T09:00:00Z");
  const second = await call("/api/account/store/checkout", { kitId: kit.id, expectedPrice: 70000, expectedAmount: 87000, setup: "install", pay: "full",
    installation: { day: "2026-11-24", slot: "morning", areaId: "akwa", directions: "Near the market", phone: "670000009" },
    name: "Amina", phone: "670000001", payerPhone: "690000002", network: "mtn", checkoutKey: randomUUID() }, { customer: true });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const id2 = second.body.order.id;
  await call("/api/account/store/verify", { orderId: id2 }, { customer: true });
  o = await order(store, id2);
  assert.equal((await call("/api/admin/store/installations/update", { id: id2, version: o.version, action: "not_installed", reason: "Weak signal" }, { role: "operator" })).status, 200);
  // The refund is sent at once: exactly the installation and travel.
  await commerce.run();
  o = await order(store, id2);
  assert.deepEqual([o.payment.status, o.status, o.payment.refunds[0].amount, o.payment.refunds[0].partial, o.payment.refund], ["paid", "preparing", 17000, true, undefined],
    "the kit part stays paid; it can be collected or returned");
  // Returning the kit later refunds what is left, never more.
  assert.equal((await call("/api/admin/store/orders/update", { id: id2, version: o.version, action: "refund", beforeCollection: true }, { role: "owner" })).status, 200);
  await commerce.run();
  o = await order(store, id2);
  assert.deepEqual([o.payment.status, o.payment.refunds.map((r) => r.amount)], ["refunded", [17000, 70000]]);
});
