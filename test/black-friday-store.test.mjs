// Black Friday AX1500 offer (#302) through the real API. Owner rules, 20 Nov,
// with the free month changed on 23 Nov (#423):
// - any AX1500 for 100,000 FCFA, 27-30 Nov, one per phone number;
// - a month (30 days) of Unlimited free, given when the router is collected;
// - it waits unstarted until the customer presses Start, within 60 days of
//   collection; unstarted after that, it expires;
// - starting it while a bundle runs pauses that bundle, which resumes after
//   the free month with the time it had left;
// - a guest gets it reserved for the paying number, claimed unstarted with the
//   code on the slip;
// - a refund before the start cancels it; after the start it ends and resumes
//   the paused bundle;
// - orders placed under the 20 Nov rule keep it;
// - the free month is a gift, never revenue.
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
  bonus: { planId: "unlimited", validityHours: 720, startsAt: "customer_start", startWithinDays: 60 }, ...overrides });

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
    s.customers.push({ id: "other", name: "Other", phone: "670000009", email: "" });
    s.dashboardSessions.push({ id: "other-session", customerId: "other", tokenHash: hashSecret("other", secret), csrfToken: "other-csrf", expiresAt: "2031-01-01T00:00:00Z" });
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
  const call = async (path, input, { role, cookie, csrf } = {}) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET",
      headers: { ...(input ? { "content-type": "application/json" } : {}), ...(role ? { cookie: "admin_session=" + role, "x-csrf-token": "csrf-" + role } : cookie ? { cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) } : {}) },
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
  assert.deepEqual([ax.promotion.bonus.days, ax.promotion.bonus.planName, ax.promotion.bonus.quotaGb, ax.promotion.bonus.deviceLimit], [30, "Unlimited Home", null, 6]);
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
  assert.deepEqual(o.receipt.included, { days: 30, planName: "Unlimited Home", startWithinDays: 60 });
});

// Marks a paid order ready, then collected with its code, as staff do.
async function collect(f, orderId) {
  for (const action of ["ready", "collect"]) {
    const o = (await f.store.snapshot()).storeOrders.find((x) => x.id === orderId);
    const r = await f.call("/api/admin/store/orders/update", { id: orderId, version: o.version, action, collectionCode: o.collectionCode }, { role: "operator" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return (await f.store.snapshot()).storeOrders.find((x) => x.id === orderId);
}
const amina = { cookie: "customer_session=amina", csrf: "amina-csrf" };

test("an account's free month is given at collection, waits unstarted, and runs 30 days from Start", async (t) => {
  const f = await fixture(t);
  const order = await f.buy();
  assert.deepEqual([order.bonus.status, order.bonus.rule, order.bonus.days, order.bonus.startWithinDays], ["pending", "customer_start", 30, 60],
    "nothing at payment: given when you collect");
  let s = await f.store.snapshot();
  assert.equal(s.vouchers.filter((v) => v.promotion).length, 0);
  assert.equal(s.vouchers.find((v) => v.id === "weekly").status, "active");
  // Collected the next day: in Amina's account, unstarted, start by 60 days on.
  f.at(+start + DAY);
  const o = await collect(f, order.id);
  assert.deepEqual([o.bonus.status, o.bonus.recipient, o.bonus.startBy], ["given", "account", new Date(+start + 61 * DAY).toISOString()]);
  s = await f.store.snapshot();
  const bonus = s.vouchers.find((v) => v.promotion?.orderId === order.id);
  assert.deepEqual([bonus.status, bonus.customerId, bonus.planId, bonus.quotaBytes, bonus.deviceLimit, bonus.expiresAt], ["available", "amina", "unlimited", null, 6, null]);
  assert.equal(bonus.paymentId, undefined, "a gift: no payment");
  assert.equal(s.vouchers.find((v) => v.id === "weekly").status, "active", "nothing pauses until Start");
  // Two days after payment the account lists it, unstarted, with its deadline
  // (Home's "Start your free month").
  f.at(+start + 2 * DAY);
  const dashboard = await f.call("/api/account/dashboard", null, amina);
  const waiting = dashboard.body.vouchers.find((v) => v.id === bonus.id);
  assert.deepEqual([waiting.status, waiting.startBy, waiting.promotion.rule, waiting.promotion.validityHours], ["available", o.bonus.startBy, "customer_start", 720]);
  assert.equal(dashboard.body.activeBundle.id, "weekly", "the running bundle is still the one in use");
  // The order was placed as a guest, so it is not this account's order.
  assert.equal((await f.call("/api/account/store/context", null, amina)).body.orders.some((x) => x.id === order.id), false);
  // Another account can't start it.
  assert.equal((await f.call("/api/account/store/bonus/start", { voucherId: bonus.id }, { cookie: "customer_session=other", csrf: "other-csrf" })).status, 404);
  // Started then: 30 days from now; the Weekly bundle (1 day left) pauses.
  const started = await f.call("/api/account/store/bonus/start", { voucherId: bonus.id }, amina);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual([started.body.bonus.status, started.body.bonus.endsAt, started.body.voucher.expiresAt], ["active", new Date(+start + 32 * DAY).toISOString(), new Date(+start + 32 * DAY).toISOString()]);
  assert.equal(started.body.order, undefined, "only the free month, not the order");
  assert.equal((await f.call("/api/account/store/bonus/start", { voucherId: bonus.id }, amina)).body.replayed, true, "pressing again changes nothing");
  s = await f.store.snapshot();
  const weekly = s.vouchers.find((v) => v.id === "weekly");
  assert.deepEqual([weekly.status, weekly.pausedFor.remainingMs], ["paused", DAY]);
  const commands = s.routerCommands.map((c) => `${c.action}:${c.targetId || ""}`);
  for (const expected of ["sync_usage:", "disconnect_voucher:weekly", `sync_voucher:${bonus.id}`]) assert.ok(commands.some((c) => c.startsWith(expected)), expected);
  assert.ok(["store.promotion_bonus_given", "store.promotion_bonus_started", "store.promotion_bundle_paused"].every((a) => s.auditLogs.some((x) => x.action === a)));
  // The gift is not revenue: the day's collections are the router's price alone.
  const collected = recordedCollectionsByDay(s, { from: "2026-11-26T23:00:00Z", to: "2026-11-27T23:00:00Z" });
  assert.equal(collected.days[0].collected, 100000, "the router's 100,000 FCFA and nothing for the free month");
  // After the 30 days, the Weekly bundle resumes with its day.
  f.at(+start + 32 * DAY + 60000);
  await f.call("/api/account/dashboard", null, amina);
  s = await f.store.snapshot();
  const resumed = s.vouchers.find((v) => v.id === "weekly");
  assert.equal(s.vouchers.find((v) => v.id === bonus.id).status, "expired");
  assert.deepEqual([resumed.status, resumed.expiresAt, resumed.usedBytes], ["active", new Date(+start + 32 * DAY + 60000 + DAY).toISOString(), 1e9]);
  assert.ok(s.auditLogs.some((x) => x.action === "store.promotion_bundle_resumed"));
});

test("unstarted 60 days after collection, the free month expires", async (t) => {
  const f = await fixture(t);
  const order = await f.buy();
  await collect(f, order.id);
  const bonus = (await f.store.snapshot()).vouchers.find((v) => v.promotion?.orderId === order.id);
  f.at(+start + 60 * DAY);
  const late = await f.call("/api/account/store/bonus/start", { voucherId: bonus.id }, amina);
  assert.equal(late.status, 409);
  assert.match(late.body.error, /had to be started by 2027-01-26/);
  const s = await f.store.snapshot();
  assert.deepEqual([s.vouchers.find((v) => v.id === bonus.id).status, s.storeOrders.find((x) => x.id === order.id).bonus.status], ["expired", "expired"]);
  assert.ok(s.auditLogs.some((x) => x.action === "store.promotion_bonus_expired"));
  assert.equal(s.vouchers.find((v) => v.id === "weekly").status, "expired", "the Weekly bundle simply ran out; nothing was paused");
});

test("a guest's free month is reserved at collection, claimed unstarted with the slip's code, then started", async (t) => {
  const f = await fixture(t);
  const order = await f.buy({ phone: "699111222", payerPhone: "699111222" });
  assert.equal(order.bonus.status, "pending");
  f.at(+start + DAY);
  await collect(f, order.id);
  const tracked = await f.call("/api/store/order", { orderId: order.id, token: order.token });
  assert.deepEqual([tracked.body.order.bonus.status, tracked.body.order.bonus.recipient, tracked.body.order.bonus.startBy], ["reserved", "number", new Date(+start + 61 * DAY).toISOString()]);
  const code = tracked.body.order.bonus.code;
  assert.match(code, /\S/, "the code is on the order for the slip");
  let s = await f.store.snapshot();
  const reserved = s.vouchers.find((v) => v.promotion?.orderId === order.id);
  assert.deepEqual([reserved.status, reserved.customerId, reserved.reservation.phone], ["available", null, "699111222"]);
  // Ten days later the guest claims it: saved unstarted, the same deadline.
  f.at(+start + 11 * DAY);
  assert.equal((await f.call("/api/account/claim/check", { phone: "699000000", code })).status, 401);
  const check = await f.call("/api/account/claim/check", { phone: "699111222", code });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.equal(check.body.gift.plan.validityHours, 720, "the free month's own length");
  const done = await f.call("/api/account/claim/complete", { token: check.body.token, pin: "4829", confirmPin: "4829", name: "Guest buyer" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.claimed.startBy, new Date(+start + 61 * DAY).toISOString());
  s = await f.store.snapshot();
  let claimed = s.vouchers.find((v) => v.id === reserved.id), o = s.storeOrders.find((x) => x.id === order.id);
  assert.deepEqual([claimed.status, claimed.expiresAt, o.bonus.status, o.bonus.code], ["available", null, "given", undefined]);
  // "Start now" on the claim screen enters the code with the number: it starts, 30 days.
  f.at(+start + 12 * DAY);
  const redeemed = await f.call("/api/vouchers/redeem", { phone: "699111222", code, deviceId: "guest-phone" });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  s = await f.store.snapshot();
  claimed = s.vouchers.find((v) => v.id === reserved.id);
  assert.deepEqual([claimed.status, claimed.expiresAt], ["active", new Date(+start + 42 * DAY).toISOString()]);
  assert.equal(s.storeOrders.find((x) => x.id === order.id).bonus.status, "active");
  // Someone else's number with the code never takes it.
  assert.equal((await f.call("/api/vouchers/redeem", { phone: "699000009", code, deviceId: "x" })).status, 401);
});

test("an account's free month can't be taken by another number that has its code", async (t) => {
  const f = await fixture(t);
  const order = await f.buy();
  await collect(f, order.id);
  const bonus = (await f.store.snapshot()).vouchers.find((v) => v.promotion?.orderId === order.id);
  assert.equal((await f.call("/api/vouchers/redeem", { phone: "699000009", code: bonus.code, deviceId: "x" })).status, 401);
  assert.equal((await f.store.snapshot()).vouchers.find((v) => v.id === bonus.id).customerId, "amina");
});

test("a refund before collection gives nothing; after collection it cancels; after the start it ends and resumes the paused bundle", async (t) => {
  const f = await fixture(t);
  const refund = async (id) => {
    const o = (await f.store.snapshot()).storeOrders.find((x) => x.id === id);
    const r = await f.call("/api/admin/store/orders/update", { id, version: o.version, action: "refund", restock: true, reason: "Returned unopened" }, { role: "owner" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (await f.store.snapshot()).storeOrders.find((x) => x.id === id);
  };
  // Before collection.
  const first = await f.buy({ phone: "699444555", payerPhone: "699444555" });
  assert.equal((await refund(first.id)).bonus.status, "not_given");
  // Collected, then refunded before the start: cancelled, the slip's code no longer claims it.
  const second = await f.buy({ phone: "699333444", payerPhone: "699333444" });
  const collected = await collect(f, second.id);
  const cancelled = await refund(second.id);
  assert.equal(cancelled.bonus.status, "cancelled");
  assert.equal((await f.call("/api/account/claim/check", { phone: "699333444", code: collected.bonus.code })).status, 401);
  // Started, then refunded: it ends and the Weekly bundle resumes with its time left.
  const third = await f.buy();
  await collect(f, third.id);
  const bonus = (await f.store.snapshot()).vouchers.find((v) => v.promotion?.orderId === third.id);
  await f.call("/api/account/store/bonus/start", { voucherId: bonus.id }, amina);
  f.at(+start + 2 * DAY);
  const ended = await refund(third.id);
  const s = await f.store.snapshot(), weekly = s.vouchers.find((v) => v.id === "weekly");
  assert.deepEqual([ended.bonus.status, ended.bonus.endedReason, s.vouchers.find((v) => v.id === bonus.id).status], ["ended", "refund", "revoked"]);
  assert.equal(weekly.status, "active");
  assert.equal(weekly.expiresAt, new Date(+start + 2 * DAY + 3 * DAY).toISOString(), "the Weekly bundle's 3 days count from now");
  assert.ok(s.auditLogs.some((a) => a.action === "store.promotion_bonus_ended"));
});

test("an order placed under the 20 Nov rule keeps it: 45 days from payment", async (t) => {
  const f = await fixture(t);
  const placed = await f.call("/api/store/checkout", f.checkout());
  // As if placed before the change: its own copy of the offer says the old rule.
  await f.store.transaction((s) => {
    Object.assign(s.storeOrders.find((o) => o.id === placed.body.order.id).promotion.bonus, { startsAt: "payment_confirmation", validityHours: 1080 });
  });
  const paid = (await f.call("/api/store/verify", { orderId: placed.body.order.id, token: placed.body.token })).body.order;
  assert.deepEqual([paid.bonus.status, paid.bonus.rule, paid.bonus.endsAt], ["active", "payment_confirmation", new Date(+start + 45 * DAY).toISOString()]);
  const s = await f.store.snapshot();
  assert.equal(s.vouchers.find((v) => v.id === "weekly").status, "paused");
});

test("a promotion saved under the 20 Nov rule sells under the 23 Nov one", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.storeSettings.promotions[0].bonus = { planId: "unlimited", validityHours: 720, startsAt: "payment_confirmation" }; });
  const ax = (await f.call("/api/store/catalogue")).body.products.find((p) => p.id === "ax1500");
  assert.deepEqual([ax.promotion.bonus.startsAt, ax.promotion.bonus.givenAt, ax.promotion.bonus.startWithinDays], ["customer_start", "collection", 60]);
  const order = await f.buy();
  assert.deepEqual([order.bonus.status, order.bonus.rule], ["pending", "customer_start"]);
});

test("staff set up, list and end promotions; saving the store settings keeps them", async (t) => {
  const f = await fixture(t);
  const listed = await f.call("/api/admin/store", null, { role: "operator" });
  const bf = listed.body.promotions.find((p) => p.id === "black-friday");
  assert.equal(bf.status, "live");
  assert.equal(bf.figures.unitsSold, 0);
  const bought = await f.buy();
  let promo = (await f.call("/api/admin/store", null, { role: "owner" })).body.promotions.find((p) => p.id === "black-friday");
  assert.deepEqual([promo.figures.unitsSold, promo.figures.revenue, promo.figures.bonusGiven, promo.orders[0].bonus], [1, 100000, 0, "pending"]);
  await collect(f, bought.id);
  promo = (await f.call("/api/admin/store", null, { role: "owner" })).body.promotions.find((p) => p.id === "black-friday");
  assert.deepEqual([promo.figures.bonusGiven, promo.orders[0].bonus, promo.orders[0].bonusRule], [1, "given", "customer_start"]);
  assert.equal(promo.orders[0].bonusStartBy, new Date(+start + 60 * DAY).toISOString());
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

test("the catalogue announces the offer to count down to, on the server's clock", async (t) => {
  const f = await fixture(t);
  // Six days before: announced as scheduled, the regular price still charged.
  f.at("2026-11-21T10:00:00Z");
  let body = (await f.call("/api/store/catalogue")).body;
  assert.equal(body.serverTime, "2026-11-21T10:00:00.000Z");
  assert.deepEqual(body.promotions.map((p) => [p.id, p.status, p.startsAt, p.endsAt, p.salePrice, p.productIds.join(","), p.bonus.days]),
    [["black-friday", "scheduled", "2026-11-26T23:00:00.000Z", "2026-11-30T23:00:00.000Z", 100000, "ax1500,ax1500-outdoor", 30]]);
  assert.equal(body.products.find((p) => p.id === "ax1500").price, 120000);
  // Live: the same offer, and the products carry it.
  f.at("2026-11-28T10:00:00Z");
  body = (await f.call("/api/store/catalogue")).body;
  assert.equal(body.promotions[0].status, "live");
  // Weeks ahead it isn't announced; ended it's gone.
  f.at("2026-11-01T10:00:00Z");
  assert.deepEqual((await f.call("/api/store/catalogue")).body.promotions, []);
  f.at("2026-12-01T10:00:00Z");
  assert.deepEqual((await f.call("/api/store/catalogue")).body.promotions, []);
});
