// Black Friday AX1500 offer (#302) through the real API. Owner rules, 20 Nov:
// - any AX1500 for 100,000 FCFA, 27-30 Nov, one per phone number;
// - 45 days of Unlimited Home starting when the payment is confirmed;
// - a bundle already running is paused, and resumes after the 45 days;
// - a guest gets the 45 days reserved for the paying number, claimed with the
//   code from the order, and the days still run from payment;
// - a refund ends the 45 days and resumes the paused bundle;
// - the free bundle is a gift, never revenue.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { storeState } from "../lib/device-store.mjs";
import { hashSecret } from "../lib/security.mjs";
import { recordedCollectionsByDay } from "../lib/insights.mjs";

const secret = "black-friday-tests-secret", DAY = 864e5;
const text = { en: "Router", fr: "Routeur" };
const start = new Date("2026-11-27T10:00:00Z");
const product = (id, overrides = {}) => ({ id, version: 1, stock: 3, sku: id, name: { en: "TP-Link AX1500", fr: "TP-Link AX1500" }, description: text, specifications: text,
  compatibility: text, contents: text, warranty: text, setup: text, images: [], price: 120000, cost: 80000, status: "published", featured: true, categoryId: "", ...overrides });
const blackFriday = (overrides = {}) => ({ id: "black-friday", enabled: true, version: 1,
  name: { en: "Black Friday", fr: "Black Friday" }, terms: { en: "One per number.", fr: "Un par numéro." },
  productIds: ["ax1500", "ax1500-outdoor"], salePrice: 100000, perNumberLimit: 1,
  startsAt: "2026-11-26T23:00:00.000Z", endsAt: "2026-11-30T23:00:00.000Z",
  bonus: { planId: "unlimited", validityHours: 1080, startsAt: "payment_confirmation" }, ...overrides });

async function fixture(t) {
  const store = createStore({ persistent: false });
  let now = start;
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "WhatsApp +237671493902", warranty: text, returns: text,
      promotions: [blackFriday()] };
    s.storeProducts.push(product("ax1500"), product("ax1500-outdoor"), product("cable", { price: 2000, name: text }));
    for (const role of ["owner", "operator", "auditor"]) {
      s.adminUsers.push({ id: role, role, username: role, active: true });
      s.adminSessions.push({ id: role, userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: "csrf-" + role, expiresAt: "2031-01-01T00:00:00Z" });
    }
    // Amina has an account and a Weekly bundle with 3 days left.
    s.customers.push({ id: "amina", name: "Amina", phone: "670000001", email: "" });
    s.dashboardSessions.push({ id: "amina-session", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "amina-csrf", expiresAt: "2031-01-01T00:00:00Z" });
    s.vouchers.push({ id: "weekly", customerId: "amina", planId: "weekly", code: "NC-WEEK-0001", status: "active", activatedAt: new Date(+start - 4 * DAY).toISOString(),
      expiresAt: new Date(+start + 3 * DAY).toISOString(), quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1 });
  });
  const adapter = {
    configured: () => true,
    createPayment: async (p) => ({ status: "pending", providerReference: "ref-" + p.id }),
    verifyPayment: async (p) => ({ status: "paid", amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }),
    handleWebhook: async (raw) => JSON.parse(raw),
    refundPayment: async () => ({ status: "completed", providerReference: "refund-ref" }),
  };
  const server = createServer({ store, now: () => now, validateConfig: false, payments: { mesomb: adapter }, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mesomb", STORE_APP_URL: "http://localhost:8083", CUSTOMER_APP_URL: "http://localhost:8080",
    ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, PAYMENT_WEBHOOK_REPLAY_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (path, input, { role, cookie } = {}) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET",
      headers: { ...(input ? { "content-type": "application/json" } : {}), ...(role ? { cookie: "admin_session=" + role, "x-csrf-token": "csrf-" + role } : cookie ? { cookie } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie") };
  };
  const checkout = (overrides) => ({ productId: "ax1500", quantity: 1, expectedPrice: 100000, name: "Buyer", phone: "670000001",
    payerPhone: "670000001", network: "mtn", checkoutKey: randomUUID().replaceAll("-", ""), ...overrides });
  const buy = async (overrides) => {
    const placed = await call("/api/store/checkout", checkout(overrides));
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    const paid = await call("/api/store/verify", { orderId: placed.body.order.id, token: placed.body.token });
    assert.equal(paid.body.order.paymentStatus, "paid");
    return { ...paid.body.order, token: placed.body.token };
  };
  return { store, call, checkout, buy, at: (time) => { now = new Date(time); }, now: () => now };
}

test("the catalogue shows the offer price, its free bundle and one per number", async (t) => {
  const f = await fixture(t);
  const { body } = await f.call("/api/store/catalogue");
  const ax = body.products.find((p) => p.id === "ax1500"), cable = body.products.find((p) => p.id === "cable");
  assert.equal(ax.price, 100000);
  assert.equal(ax.promotion.salePrice, 100000);
  assert.equal(ax.promotion.regularPrice, null, "no crossed-out price without a sales history at it");
  assert.deepEqual([ax.promotion.bonus.days, ax.promotion.bonus.planName, ax.promotion.bonus.quotaGb, ax.promotion.bonus.deviceLimit], [45, "Unlimited Home", null, 6]);
  assert.equal(ax.paymentQuotes.mtn.length, 1, "quotes for one router only");
  assert.equal(ax.paymentQuotes.mtn[0].price, 100000);
  assert.equal(cable.price, 2000);
  assert.equal(cable.promotion, undefined);
  assert.equal(body.settings.promotions, undefined, "promotion set-up is not public");
  // Before and after the window: the regular price.
  f.at("2026-11-26T22:59:59Z");
  assert.equal((await f.call("/api/store/catalogue")).body.products.find((p) => p.id === "ax1500").price, 120000);
  f.at("2026-11-30T23:00:00Z");
  assert.equal((await f.call("/api/store/catalogue")).body.products.find((p) => p.id === "ax1500").promotion, undefined);
});

test("checkout charges the offer price once per number and refuses a second one", async (t) => {
  const f = await fixture(t);
  assert.match((await f.call("/api/store/checkout", f.checkout({ quantity: 2 }))).body.error, /one per phone number/);
  assert.match((await f.call("/api/store/checkout", f.checkout({ expectedPrice: 120000 }))).body.error, /price changed/);
  const order = await f.buy({ phone: "699000001", payerPhone: "699000001" });
  assert.equal(order.amount, 100000);
  // The same number again, as payer or as contact, or the other AX1500 model.
  for (const again of [{ phone: "699000001", payerPhone: "699000002" }, { phone: "699000003", payerPhone: "699000001" },
    { productId: "ax1500-outdoor", phone: "699000001", payerPhone: "699000001" }]) {
    const r = await f.call("/api/store/checkout", f.checkout(again));
    assert.equal(r.status, 409, JSON.stringify(again));
    assert.match(r.body.error, /already has an order at the offer price/);
  }
  const s = await f.store.snapshot(), o = s.storeOrders.find((x) => x.id === order.id);
  assert.deepEqual([o.unitPrice, o.payment.amount, o.promotion.id, o.promotion.bonus.planName], [100000, 100000, "black-friday", "Unlimited Home"]);
  assert.equal(o.receipt.item.unitPrice, 100000);
  assert.deepEqual(o.receipt.included, { days: 45, planName: "Unlimited Home" });
});

test("an account gets 45 days from payment; its running bundle pauses, then resumes with its time left", async (t) => {
  const f = await fixture(t);
  const order = await f.buy();
  assert.deepEqual([order.bonus.status, order.bonus.recipient, order.bonus.days, order.bonus.code], ["active", "account", 45, undefined]);
  let s = await f.store.snapshot();
  const bonus = s.vouchers.find((v) => v.promotion?.orderId === order.id), weekly = s.vouchers.find((v) => v.id === "weekly");
  assert.deepEqual([bonus.status, bonus.customerId, bonus.planId, bonus.quotaBytes, bonus.deviceLimit], ["active", "amina", "unlimited", null, 6]);
  assert.equal(bonus.expiresAt, new Date(+start + 45 * DAY).toISOString(), "45 days from the payment");
  assert.equal(bonus.paymentId, undefined, "a gift: no payment");
  assert.equal(weekly.status, "paused");
  assert.equal(weekly.pausedFor.remainingMs, 3 * DAY);
  const commands = s.routerCommands.map((c) => `${c.action}:${c.targetId || ""}`);
  for (const expected of ["sync_usage:", "disconnect_voucher:weekly", `sync_voucher:${bonus.id}`]) assert.ok(commands.some((c) => c.startsWith(expected)), expected);
  // The gift is not revenue: the day's collections are the router's price alone.
  const collected = recordedCollectionsByDay(s, { from: "2026-11-26T23:00:00Z", to: "2026-11-27T23:00:00Z" });
  assert.equal(collected.days[0].collected, 100000, "the router's 100,000 FCFA and nothing for the free bundle");
  // After the 45 days, the Weekly bundle resumes with its 3 days.
  f.at(+start + 45 * DAY + 60000);
  await f.call("/api/account/dashboard", null, { cookie: "customer_session=amina" });
  s = await f.store.snapshot();
  const resumed = s.vouchers.find((v) => v.id === "weekly");
  assert.equal(s.vouchers.find((v) => v.id === bonus.id).status, "expired");
  assert.equal(resumed.status, "active");
  assert.equal(resumed.expiresAt, new Date(+start + 45 * DAY + 60000 + 3 * DAY).toISOString());
  assert.equal(resumed.usedBytes, 1e9, "its data is kept");
});

test("a guest's 45 days are reserved for the paying number and start when claimed with the order's code", async (t) => {
  const f = await fixture(t);
  const order = await f.buy({ phone: "699111222", payerPhone: "699111222" });
  assert.deepEqual([order.bonus.status, order.bonus.recipient], ["reserved", "number"]);
  assert.match(order.bonus.code, /\S/, "the code is on the order for the slip");
  let s = await f.store.snapshot();
  const reserved = s.vouchers.find((v) => v.promotion?.orderId === order.id);
  assert.deepEqual([reserved.status, reserved.customerId, reserved.reservation.phone], ["available", null, "699111222"]);
  // Ten days later the guest claims it: it starts now and ends 45 days after payment.
  f.at(+start + 10 * DAY);
  const wrong = await f.call("/api/account/claim/check", { phone: "699000000", code: order.bonus.code });
  assert.equal(wrong.status, 401);
  const check = await f.call("/api/account/claim/check", { phone: "699111222", code: order.bonus.code });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  const done = await f.call("/api/account/claim/complete", { token: check.body.token, pin: "4829", confirmPin: "4829", name: "Guest buyer" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  s = await f.store.snapshot();
  const claimed = s.vouchers.find((v) => v.id === reserved.id);
  assert.equal(claimed.status, "active");
  assert.equal(claimed.expiresAt, new Date(+start + 45 * DAY).toISOString());
  const o = s.storeOrders.find((x) => x.id === order.id);
  assert.equal(o.bonus.status, "active");
  assert.equal(o.bonus.code, undefined, "the code leaves the order once claimed");
});

test("a refund ends the free 45 days and resumes the paused bundle at once", async (t) => {
  const f = await fixture(t);
  const order = await f.buy();
  f.at(+start + 2 * DAY);
  const s0 = await f.store.snapshot(), o0 = s0.storeOrders.find((x) => x.id === order.id);
  const refunded = await f.call("/api/admin/store/orders/update", { id: order.id, version: o0.version, action: "refund", restock: true, reason: "Returned unopened" }, { role: "owner" });
  assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
  const s = await f.store.snapshot(), o = s.storeOrders.find((x) => x.id === order.id);
  const bonus = s.vouchers.find((v) => v.id === o.bonus.voucherId), weekly = s.vouchers.find((v) => v.id === "weekly");
  assert.deepEqual([o.bonus.status, o.bonus.endedReason, bonus.status], ["ended", "refund", "revoked"]);
  assert.equal(weekly.status, "active");
  assert.equal(weekly.expiresAt, new Date(+start + 2 * DAY + 3 * DAY).toISOString(), "the Weekly bundle's 3 days count from now");
  assert.ok(s.auditLogs.some((a) => a.action === "store.promotion_bonus_ended"));
});

test("a refunded guest order can no longer be claimed", async (t) => {
  const f = await fixture(t);
  const order = await f.buy({ phone: "699333444", payerPhone: "699333444" });
  const s0 = await f.store.snapshot(), o0 = s0.storeOrders.find((x) => x.id === order.id);
  await f.call("/api/admin/store/orders/update", { id: order.id, version: o0.version, action: "refund", restock: true, reason: "Changed mind" }, { role: "owner" });
  const check = await f.call("/api/account/claim/check", { phone: "699333444", code: order.bonus.code });
  assert.equal(check.status, 401);
});

test("staff set up, list and end promotions; saving the store settings keeps them", async (t) => {
  const f = await fixture(t);
  const listed = await f.call("/api/admin/store", null, { role: "operator" });
  const bf = listed.body.promotions.find((p) => p.id === "black-friday");
  assert.equal(bf.status, "live");
  assert.equal(bf.figures.unitsSold, 0);
  await f.buy();
  let promo = (await f.call("/api/admin/store", null, { role: "owner" })).body.promotions.find((p) => p.id === "black-friday");
  assert.deepEqual([promo.figures.unitsSold, promo.figures.revenue, promo.figures.bonusActive], [1, 100000, 1]);
  assert.equal(promo.orders[0].payer, "6•• •• 00 01");
  // An auditor can't touch the store; an operator can create a promotion.
  assert.equal((await f.call("/api/admin/store/promotions/save", {}, { role: "auditor" })).status, 403);
  const created = await f.call("/api/admin/store/promotions/save", { enabled: true, name: { en: "Cable week", fr: "Semaine câble" }, terms: { en: "While stocks last.", fr: "Dans la limite des stocks." },
    productIds: ["cable"], salePrice: 1500, startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-07T00:00:00Z", bonus: null }, { role: "operator" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.ok(created.body.promotions.some((p) => p.name.en === "Cable week" && p.status === "scheduled"));
  assert.equal((await f.call("/api/admin/store/promotions/save", { enabled: true, name: { en: "Clash", fr: "Conflit" }, terms: text,
    productIds: ["ax1500"], salePrice: 90000, startsAt: "2026-11-28T00:00:00Z", endsAt: "2026-11-29T00:00:00Z", bonus: null }, { role: "owner" })).status, 400);
  // Saving the store settings keeps the promotions.
  const settings = (await f.call("/api/admin/store", null, { role: "owner" })).body.settings;
  const saved = await f.call("/api/admin/store/settings/save", { ...settings }, { role: "owner" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.promotions.length, 2);
  // End early: the regular price is back at once; the order keeps its price.
  const ended = await f.call("/api/admin/store/promotions/end", { id: "black-friday" }, { role: "owner" });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.promotions.find((p) => p.id === "black-friday").status, "ended");
  assert.equal((await f.call("/api/store/catalogue")).body.products.find((p) => p.id === "ax1500").price, 120000);
  const s = await f.store.snapshot();
  assert.equal(s.storeOrders[0].payment.amount, 100000);
  assert.ok(["store.promotions.save", "store.promotions.end"].every((action) => s.auditLogs.some((a) => a.action === action)));
});

test("an invalid enabled promotion never sells at the regular price by mistake", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.storeSettings.promotions[0].salePrice = -1; });
  const ax = (await f.call("/api/store/catalogue")).body.products.find((p) => p.id === "ax1500");
  assert.deepEqual([ax.available, ax.offerUnavailable], [0, true]);
  const r = await f.call("/api/store/checkout", f.checkout({ expectedPrice: 120000 }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /offer is being updated/);
  // Other products sell normally.
  assert.equal((await f.call("/api/store/catalogue")).body.products.find((p) => p.id === "cable").price, 2000);
});
