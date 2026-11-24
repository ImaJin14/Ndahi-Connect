// The free bundle of a store promotion (#302, rule of 23 Nov in #423): who
// gets it, when it is given and started, when it expires, refunds, and that
// orders placed under the 20 Nov rule keep it.
import test from "node:test";
import assert from "node:assert/strict";
import { bonusRecipient, bonusTerms, issuePromotionBonus, claimBonus, startPromotionBonus, expireUnstartedBonuses,
  resumePausedBundles, endPromotionBonus, bonusView } from "../lib/store-promotion-bonus.mjs";
import { claimReservation } from "../lib/reservations.mjs";

const now = new Date("2026-11-27T10:00:00Z"), DAY = 864e5, later = (days) => new Date(+now + days * DAY);
const plan = { id: "unlimited", name: "Unlimited Home", price: 30000, quotaGb: null, validityHours: 720, deviceLimit: 6 };
// The Black Friday free month as sold at checkout: one month, started within 60 days of collection.
const sold = bonusTerms({ planId: "unlimited", validityHours: 720, startsAt: "customer_start", givenAt: "collection", startWithinDays: 60 }, plan);
const order = (extra = {}) => ({ id: "o1", reference: "NS-1", status: "collected", customerId: null,
  payment: { status: "paid", confirmedAt: now.toISOString(), payerPhone: "670000002" },
  promotion: { id: "black-friday", bonus: sold }, ...extra });
// An order placed under the 20 Nov rule: 45 days from payment.
const legacyOrder = (extra = {}) => order({ status: "preparing",
  promotion: { id: "black-friday", bonus: { planId: "unlimited", validityHours: 1080, startsAt: "payment_confirmation", planName: "Unlimited Home" } }, ...extra });
const weekly = () => ({ id: "weekly", customerId: "payer", planId: "weekly", status: "active", activatedAt: later(-4).toISOString(),
  expiresAt: later(3).toISOString(), quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1, speedSnapshot: { downloadMbps: 5, uploadMbps: 2 } });
const state = (extra = {}) => ({ customers: [{ id: "signed-in", phone: "670000001" }, { id: "payer", phone: "670000002" }, { id: "off", phone: "670000003", status: "suspended" }],
  vouchers: [], routerCommands: [], auditLogs: [], storeOrders: [], ...extra });
let n = 0;
const code = () => `NC-TEST-${String(++n).padStart(4, "0")}`;
const give = (s, o, at = now) => { s.storeOrders.push(o); return issuePromotionBonus(s, o, at, { plan, code }); };
const audited = (s, action) => s.auditLogs.some((a) => a.action === action);

test("the signed-in buyer's account comes first, then the paying number's; never a suspended one", () => {
  const s = state();
  assert.equal(bonusRecipient(s, order({ customerId: "signed-in" })).id, "signed-in");
  assert.equal(bonusRecipient(s, order()).id, "payer");
  assert.equal(bonusRecipient(s, order({ payment: { payerPhone: "670000003" } })), null);
  assert.equal(bonusRecipient(s, order({ payment: { payerPhone: "699999999" } })), null);
});

test("nothing is given at payment: only a collected, paid order gets it, once", () => {
  for (const extra of [{ status: "preparing" }, { status: "ready" }, { status: "review" }, { payment: { status: "pending", payerPhone: "670000002" } }]) {
    const s = state();
    assert.equal(give(s, order(extra)), null, JSON.stringify(extra));
    assert.equal(s.vouchers.length, 0);
  }
  const s = state(), o = order();
  give(s, o);
  assert.equal(issuePromotionBonus(s, o, now, { plan, code }), null, "a second call gives nothing more");
  assert.equal(s.vouchers.length, 1);
  assert.equal(bonusView(order({ status: "ready" })).status, "pending", "before collection the order says it is given at collection");
});

test("collection gives it unstarted in the account, with a deadline 60 days on", () => {
  const s = state({ vouchers: [weekly()] }), o = order();
  const given = give(s, o);
  assert.deepEqual([given.status, given.recipient, given.customerId, given.startBy], ["given", "account", "payer", later(60).toISOString()]);
  const v = s.vouchers.find((x) => x.id === given.voucherId);
  assert.deepEqual([v.status, v.customerId, v.activatedAt, v.expiresAt, v.startBy], ["available", "payer", null, null, later(60).toISOString()]);
  assert.equal(s.vouchers.find((x) => x.id === "weekly").status, "active", "nothing pauses until it is started");
  assert.equal(s.routerCommands.length, 0);
  assert.ok(audited(s, "store.promotion_bonus_given"));
  const view = bonusView(o);
  assert.deepEqual([view.status, view.days, view.rule, view.startWithinDays, view.startBy, view.voucherId], ["given", 30, "customer_start", 60, later(60).toISOString(), v.id]);
});

test("it is issued from the plan as sold, not the catalogue at collection", () => {
  const s = state(), o = order();
  const changed = { ...plan, quotaGb: 50, deviceLimit: 2, price: 99999 };
  s.storeOrders.push(o);
  issuePromotionBonus(s, o, now, { plan: changed, code });
  const v = s.vouchers[0];
  assert.deepEqual([v.quotaBytes, v.deviceLimit, v.faceValue], [null, 6, 30000]);
  // Even a plan since removed from the catalogue: the order's copy is enough.
  const s2 = state(), o2 = order();
  s2.storeOrders.push(o2);
  assert.equal(issuePromotionBonus(s2, o2, now, { plan: undefined, code }).status, "given");
});

test("starting runs 30 days from the press of Start; a running bundle pauses and resumes with its time left", () => {
  const s = state({ vouchers: [weekly()] }), o = order();
  const { voucherId } = give(s, o);
  const at = later(10);
  const started = startPromotionBonus(s, voucherId, s.customers[1], at);
  const v = started.voucher, paused = s.vouchers.find((x) => x.id === "weekly");
  assert.deepEqual([v.status, v.activatedAt, v.expiresAt], ["active", at.toISOString(), new Date(+at + 30 * DAY).toISOString()]);
  // The Weekly bundle ran out on day 3, so there was nothing to pause.
  assert.equal(paused.status, "active");
  assert.deepEqual(o.bonus.pausedVoucherIds, []);
  assert.deepEqual([o.bonus.status, o.bonus.startedAt, o.bonus.endsAt], ["active", at.toISOString(), v.expiresAt]);
  assert.ok(audited(s, "store.promotion_bonus_started"));
  // Pressing Start again changes nothing.
  assert.equal(startPromotionBonus(s, voucherId, s.customers[1], later(11)).replayed, true);
  assert.equal(v.activatedAt, at.toISOString());
});

test("starting while a bundle runs pauses it with its own terms, and it resumes after the free month", () => {
  const s = state({ vouchers: [weekly()] }), o = order();
  const { voucherId } = give(s, o);
  const at = later(1), before = structuredClone(s.vouchers.find((x) => x.id === "weekly"));
  startPromotionBonus(s, voucherId, s.customers[1], at);
  const w = s.vouchers.find((x) => x.id === "weekly");
  assert.deepEqual([w.status, w.pausedFor.remainingMs], ["paused", 2 * DAY]);
  for (const key of ["planId", "quotaBytes", "usedBytes", "deviceLimit", "speedSnapshot", "activatedAt"]) assert.deepEqual(w[key], before[key], key);
  assert.deepEqual(o.bonus.pausedVoucherIds, ["weekly"]);
  assert.ok(["store.promotion_bundle_paused"].every((a) => audited(s, a)));
  for (const expected of ["sync_usage", "disconnect_voucher:weekly", `sync_voucher:${voucherId}`])
    assert.ok(s.routerCommands.some((c) => `${c.action}:${c.targetId}`.startsWith(expected)), expected);
  // The free month ends (housekeeping expires it); the Weekly bundle resumes with its 2 days.
  const end = new Date(+at + 30 * DAY + 60000);
  s.vouchers.find((x) => x.id === voucherId).status = "expired";
  assert.deepEqual(resumePausedBundles(s, end), ["weekly"]);
  assert.deepEqual([w.status, w.expiresAt, w.usedBytes], ["active", new Date(+end + 2 * DAY).toISOString(), 1e9]);
  assert.ok(audited(s, "store.promotion_bundle_resumed"));
});

test("unstarted 60 days after collection, it expires and can no longer be started", () => {
  const s = state(), o = order();
  const { voucherId } = give(s, o);
  assert.deepEqual(expireUnstartedBonuses(s, later(59.9)), []);
  assert.deepEqual(expireUnstartedBonuses(s, later(60)), [voucherId]);
  assert.deepEqual([s.vouchers[0].status, o.bonus.status], ["expired", "expired"]);
  assert.ok(audited(s, "store.promotion_bonus_expired"));
  assert.throws(() => startPromotionBonus(s, voucherId, s.customers[1], later(61)), (e) => e.status === 409 && e.code === "START_WINDOW_ENDED");
  assert.deepEqual(expireUnstartedBonuses(s, later(61)), [], "once");
  // Without its order loaded (a targeted read), nothing changes: both change together later.
  const s2 = state(), o2 = order();
  give(s2, o2);
  s2.storeOrders = undefined;
  assert.deepEqual(expireUnstartedBonuses(s2, later(61)), []);
  assert.equal(s2.vouchers[0].status, "available");
});

test("only the account it was given to can start it", () => {
  const s = state(), o = order();
  const { voucherId } = give(s, o);
  assert.throws(() => startPromotionBonus(s, voucherId, s.customers[0], later(1)), (e) => e.status === 404);
  assert.throws(() => startPromotionBonus(s, "nope", s.customers[1], later(1)), (e) => e.status === 404);
});

test("a guest's free month waits for the paying number; claiming saves it unstarted, then the customer starts it", () => {
  const s = state(), o = order({ payment: { status: "paid", confirmedAt: now.toISOString(), payerPhone: "699111222" } });
  const given = give(s, o);
  assert.deepEqual([given.status, given.recipient, given.phone, given.startBy], ["reserved", "number", "699111222", later(60).toISOString()]);
  assert.match(given.code, /^NC-TEST-/);
  const v = s.vouchers[0];
  assert.equal(v.reservation.expiresAt, later(60).toISOString(), "claimable until the start deadline");
  const guest = { id: "guest", phone: "699111222" };
  s.customers.push(guest);
  claimReservation(v, guest, later(5), "code");
  claimBonus(s, v, guest, later(5));
  assert.deepEqual([v.status, v.customerId, v.startBy], ["available", "guest", later(60).toISOString()], "unstarted, same deadline (not the 90 days of other gifts)");
  assert.deepEqual([o.bonus.status, o.bonus.code], ["given", undefined]);
  assert.ok(audited(s, "store.promotion_bonus_claimed"));
  startPromotionBonus(s, v.id, guest, later(20));
  assert.deepEqual([v.status, v.expiresAt], ["active", new Date(+later(20) + 30 * DAY).toISOString()]);
});

test("a refund before collection or before the start cancels it; after the start it ends and resumes the paused bundle", () => {
  // Before collection: nothing was given, nothing will be.
  const s0 = state(), o0 = order({ status: "ready" });
  assert.equal(endPromotionBonus(s0, o0, now, "refund").status, "not_given");
  o0.status = "collected";
  assert.equal(issuePromotionBonus(s0, o0, now, { plan, code }), null, "collected after the refund: still nothing");
  // Collected, not started: cancelled; a reserved code can no longer be claimed.
  const s1 = state(), o1 = order({ payment: { status: "paid", confirmedAt: now.toISOString(), payerPhone: "699111222" } });
  give(s1, o1);
  assert.equal(endPromotionBonus(s1, o1, later(2), "refund").status, "cancelled");
  assert.deepEqual([s1.vouchers[0].status, s1.vouchers[0].reservation.status, o1.bonus.code], ["revoked", "revoked", undefined]);
  // Started: ends at once and the paused bundle resumes.
  const s2 = state({ vouchers: [weekly()] }), o2 = order();
  const { voucherId } = give(s2, o2);
  startPromotionBonus(s2, voucherId, s2.customers[1], later(1));
  const ended = endPromotionBonus(s2, o2, later(4), "refund");
  assert.deepEqual([ended.status, ended.endedReason], ["ended", "refund"]);
  assert.equal(s2.vouchers.find((x) => x.id === voucherId).status, "revoked");
  const w = s2.vouchers.find((x) => x.id === "weekly");
  assert.deepEqual([w.status, w.expiresAt], ["active", new Date(+later(4) + 2 * DAY).toISOString()]);
  assert.ok(s2.routerCommands.some((c) => c.action === "disconnect_voucher" && c.targetId === voucherId));
  // Idempotent.
  const audits = s2.auditLogs.length;
  assert.equal(endPromotionBonus(s2, o2, later(5), "refund").status, "ended");
  assert.equal(s2.auditLogs.length, audits);
  assert.equal(endPromotionBonus(s2, order({ promotion: { id: "p" } }), now, "refund"), null, "no free bundle on the offer");
});

test("orders placed under the 20 Nov rule keep it: given at payment, days from payment", () => {
  const s = state(), o = legacyOrder();
  assert.equal(issuePromotionBonus(s, legacyOrder({ status: "collected" }), now, { plan, code }), null, "not at collection");
  s.storeOrders.push(o);
  const given = issuePromotionBonus(s, o, now, { plan, code });
  assert.deepEqual([given.status, given.endsAt], ["active", later(45).toISOString()]);
  assert.equal(bonusView(o).rule, "payment_confirmation");
  assert.equal(endPromotionBonus(s, o, later(1), "refund").status, "ended");
  // A missing plan holds it for staff review instead of inventing one.
  const s2 = state(), o2 = legacyOrder();
  assert.equal(issuePromotionBonus(s2, o2, now, { plan: undefined, code }).status, "needs_review");
  assert.ok(audited(s2, "store.promotion_bonus_needs_review"));
});

test("resuming acts only when the free bundle is loaded and over", () => {
  const s = state();
  s.vouchers.push({ id: "weekly", status: "paused", pausedFor: { voucherId: "bonus", remainingMs: 3 * DAY } });
  assert.deepEqual(resumePausedBundles(s, now), [], "the free bundle isn't loaded: leave it paused");
  s.vouchers.push({ id: "bonus", status: "active" });
  assert.deepEqual(resumePausedBundles(s, now), [], "still running");
  s.vouchers[1].status = "expired";
  assert.deepEqual(resumePausedBundles(s, now), ["weekly"]);
  assert.equal(s.vouchers[0].expiresAt, new Date(+now + 3 * DAY).toISOString());
  assert.ok(s.routerCommands.some((c) => c.action === "sync_voucher" && c.targetId === "weekly"));
});

test("a legacy bundle is unaffected: only the customer's own Start pauses it, and it resumes with its own terms and time left", () => {
  // A fixed-data bundle bought before the change, and a 20 Nov free bundle still waiting for its number.
  const legacyFree = { id: "old-free", planId: "unlimited", code: "NC-OLD-0001", status: "available", customerId: null, quotaBytes: null, deviceLimit: 6,
    promotion: { id: "black-friday", orderId: "old-order", endsAt: later(40).toISOString(), validityHours: 1080 },
    reservation: { phone: "699000777", status: "waiting", expiresAt: later(40).toISOString() } };
  const s = state({ vouchers: [weekly(), legacyFree] });
  s.storeOrders.push({ id: "old-order", promotion: { bonus: { startsAt: "payment_confirmation" } }, bonus: { status: "reserved", voucherId: "old-free" } });
  const untouched = () => structuredClone(s.vouchers.filter((v) => ["weekly", "old-free"].includes(v.id)));
  const before = untouched();
  // Given at collection, claimed, expired unstarted, refunded before the start: none of it touches them.
  const o = order();
  give(s, o);
  const guestOrder = order({ id: "o2", payment: { status: "paid", confirmedAt: now.toISOString(), payerPhone: "699111222" } });
  give(s, guestOrder);
  const guest = { id: "guest", phone: "699111222" };
  s.customers.push(guest);
  const reserved = s.vouchers.find((v) => v.promotion?.orderId === "o2");
  claimReservation(reserved, guest, later(1), "code");
  claimBonus(s, reserved, guest, later(1));
  endPromotionBonus(s, guestOrder, later(1), "refund");
  assert.deepEqual(expireUnstartedBonuses(s, later(1)), []);
  assert.deepEqual(untouched(), before, "nothing changed on the legacy bundles");
  // The 20 Nov free bundle is never expired by the 23 Nov window, whatever the date.
  expireUnstartedBonuses(s, later(70));
  assert.deepEqual(s.vouchers.find((v) => v.id === "old-free"), before[1]);
  // The customer presses Start: the Weekly bundle pauses with its terms, then resumes with exactly its time left.
  const s2 = state({ vouchers: [weekly()] }), o3 = order();
  const { voucherId } = give(s2, o3);
  const was = structuredClone(s2.vouchers.find((v) => v.id === "weekly"));
  startPromotionBonus(s2, voucherId, s2.customers[1], later(1));
  const end = later(31);
  s2.vouchers.find((v) => v.id === voucherId).status = "expired";
  resumePausedBundles(s2, end);
  const after = s2.vouchers.find((v) => v.id === "weekly");
  for (const key of ["planId", "quotaBytes", "usedBytes", "deviceLimit", "speedSnapshot", "activatedAt", "customerId"]) assert.deepEqual(after[key], was[key], key);
  assert.equal(Date.parse(after.expiresAt) - +end, Date.parse(was.expiresAt) - +later(1), "the same time left: validity is never restarted");
});
