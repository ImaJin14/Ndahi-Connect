// Promotions after #345 (owner, 27 Nov): the free bundle is an Unlimited
// catalogue bundle, given at collection or as soon as the payment is
// confirmed; "Units at this price" caps the sale beside stock; the regular
// price shows crossed out only after real sales at it; and the admin counts
// free bundles given and started, and buyers new to NDAHI.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { storeState, reserveOrder, settleOrder, catalogue } from "../lib/device-store.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";
import { promotionInput, soldAtRegular } from "../lib/store-promotions.mjs";
import { issuePromotionBonus, startPromotionBonus, endPromotionBonus, bonusView } from "../lib/store-promotion-bonus.mjs";

const now = new Date("2026-12-04T10:00:00Z"), DAY = 864e5, secret = "promotions-unlimited";
const text = { en: "Router", fr: "Routeur" };
let n = 0;
const code = () => `NC-PROMO-${String(++n).padStart(4, "0")}`;
function state({ givenAt = "collection", units = null, showWas = false } = {}) {
  const s = storeState({ bundles: [], vouchers: [], payments: [], customers: [{ id: "amina", phone: "670000001", name: "Amina Ndi" }], auditLogs: [], routerCommands: [] });
  seedCatalogue(s, now);
  Object.assign(s.storeSettings, { open: true, pickup: "Akwa", warranty: text, returns: text });
  s.storeProducts.push({ id: "ax1500", version: 1, sku: "AX1500", name: { en: "AX1500", fr: "AX1500" }, description: text, warranty: text, images: [], price: 120000, cost: 1, stock: 10, status: "published", categoryId: "" });
  const promotion = promotionInput(s, { enabled: true, name: { en: "Cyber Monday", fr: "Cyber Monday" }, terms: text, productIds: ["ax1500"], salePrice: 100000,
    startsAt: "2026-12-03T00:00:00Z", endsAt: "2026-12-06T00:00:00Z", perNumberLimit: 2, units, showWas,
    bonus: { bundleId: "unlimited-30d-1", givenAt, startWithinDays: 60 } }, null, new Date("2026-12-01T00:00:00Z"));
  s.storeSettings.promotions = [promotion];
  return s;
}
const buy = (s, { phone = "670000001", customerId = "amina", quantity = 1, at = now } = {}) =>
  reserveOrder(s, { productId: "ax1500", quantity, expectedPrice: 100000, name: "Amina", phone, payerPhone: phone, network: "mtn", checkoutKey: randomUUID() },
    { now: at, secret, customerId, provider: "mock" }).order;
const pay = (s, o, at = now) => settleOrder(s, o, { status: "paid", transactionReference: o.payment.id, providerReference: "r-" + o.id, amount: o.payment.amount, currency: "XAF" }, at);

test("the free bundle is an Unlimited bundle: the shop describes it, the order keeps a copy, collection gives it with its own terms", () => {
  const s = state(), product = catalogue(s, now).products.find((p) => p.id === "ax1500");
  assert.deepEqual([product.price, product.promotion.bonus.planName, product.promotion.bonus.days, product.promotion.bonus.accessType, product.promotion.bonus.deviceSlots],
    [100000, "Personal Unlimited", 30, "personal_unlimited", 1]);
  const o = buy(s);
  assert.equal(o.promotion.bonus.bundle.id, "unlimited-30d-1", "a copy of the bundle as sold");
  pay(s, o);
  assert.equal(issuePromotionBonus(s, o, now, { code }), null, "given at collection, not at payment");
  o.status = "collected";
  const given = issuePromotionBonus(s, o, now, { code });
  const v = s.vouchers.find((x) => x.id === given.voucherId);
  assert.deepEqual([v.status, v.customerId, v.quotaBytes, v.accessType, v.deviceSlots, v.customTerms.id, v.saleType], ["available", "amina", null, "personal_unlimited", 1, "unlimited-30d-1", "gift"]);
  // Started by the customer: one month from then.
  startPromotionBonus(s, v.id, s.customers[0], new Date(+now + DAY));
  assert.deepEqual([v.status, v.expiresAt], ["active", new Date(+now + 31 * DAY).toISOString()]);
  assert.equal(bonusView(o).status, "active");
});

test("\"As soon as payment is confirmed\": given when paid; a refund before it starts cancels it", () => {
  const s = state({ givenAt: "payment" }), o = buy(s);
  pay(s, o);
  const given = issuePromotionBonus(s, o, now, { code });
  assert.equal(given.status, "given");
  assert.equal(bonusView(o).givenAt, "payment");
  endPromotionBonus(s, o, now, "refund");
  assert.deepEqual([o.bonus.status, s.vouchers.find((x) => x.id === given.voucherId).status], ["cancelled", "revoked"]);
});

test("Units at this price: never more than are left; the sale stops when they're gone", () => {
  const s = state({ units: 2 });
  assert.equal(catalogue(s, now).products[0].promotion.unitsLeft, 2);
  assert.throws(() => buy(s, { quantity: 3 }), /limited to 2 per phone number|Only 2 are left/);
  pay(s, buy(s, { quantity: 1 }));
  assert.throws(() => buy(s, { phone: "690000002", customerId: null, quantity: 2 }), /Only 1 is left at the offer price/);
  pay(s, buy(s, { phone: "690000002", customerId: null }));
  const product = catalogue(s, now).products[0];
  assert.deepEqual([product.price, product.promotion], [120000, undefined], "sold out at the offer: the regular price again");
});

test("the regular price shows crossed out only when asked AND it really sold at it in the 30 days before", () => {
  const s = state({ showWas: true });
  assert.equal(catalogue(s, now).products[0].promotion.regularPrice, null, "no sales at the regular price yet");
  // A sale at the regular price before the promotion started.
  s.storeOrders.push({ id: "old", productId: "ax1500", unitPrice: 120000, quantity: 1, status: "collected", payment: { status: "paid", confirmedAt: "2026-11-20T10:00:00Z" } });
  assert.equal(soldAtRegular(s, s.storeProducts[0], Date.parse("2026-12-03T00:00:00Z")), true);
  assert.equal(catalogue(s, now).products[0].promotion.regularPrice, 120000);
  s.storeSettings.promotions[0].showWas = false;
  assert.equal(catalogue(s, now).products[0].promotion.regularPrice, null, "not when unticked");
  s.storeSettings.promotions[0].showWas = true;
  s.storeOrders[s.storeOrders.length - 1].payment.confirmedAt = "2026-10-01T10:00:00Z";
  assert.equal(catalogue(s, now).products[0].promotion.regularPrice, null, "a sale more than 30 days before doesn't count");
});

test("the admin's figures: units, free bundles given and started, new customers", async () => {
  const { createServer, createStore } = await import("../server.mjs");
  const { hashSecret } = await import("../lib/security.mjs");
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    Object.assign(s, state({ units: 20 }));
    s.adminUsers.push({ id: "owner", role: "owner", username: "owner", active: true });
    s.adminSessions.push({ id: "owner", userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "c", expiresAt: "2031-01-01T00:00:00Z" });
    // Amina paid for a bundle before: not new. A guest's number is new.
    s.payments.push({ id: "p0", customerId: "amina", payerPhone: "670000001", status: "paid", confirmedAt: "2026-11-01T10:00:00Z", amount: 1000 });
    const a = buy(s), b = buy(s, { phone: "690000002", customerId: null });
    pay(s, a); pay(s, b);
    a.status = "collected"; issuePromotionBonus(s, a, now, { code });
    startPromotionBonus(s, a.bonus.voucherId, s.customers[0], now);
  });
  const app = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false" } });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try {
    const snap = await (await fetch(`http://127.0.0.1:${app.address().port}/api/admin/store`, { headers: { cookie: "admin_session=owner" } })).json();
    const p = snap.promotions[0];
    assert.deepEqual([p.figures.unitsSold, p.figures.units, p.figures.freeGiven, p.figures.freeStarted, p.figures.newCustomers], [2, 20, 1, 1, 1]);
    assert.equal(p.orders.find((o) => o.account).name, "Amina", "an account holder by name");
    assert.ok(snap.promotionBundles.some((b) => b.id === "unlimited-30d-1"));
    assert.equal(snap.products[0].soldAtRegular30d, false);
  } finally { app.closeAllConnections(); await new Promise((r) => app.close(r)); }
});
