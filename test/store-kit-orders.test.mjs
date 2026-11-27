import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { storeState, reserveOrder, settleOrder, orderView } from "../lib/device-store.mjs";
import { kitInput } from "../lib/store-kits.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";
import {
  installSettings, installSettingsInput, availability, moveBooking, cancelBooking, refundPart, refundable, slotStart,
  planRules, planRulesInput, planSchedule, planEligible, newPlanPayment, sweepPlans, extendPlan, planMetrics, planReminders, kitQuote,
} from "../lib/store-kit-orders.mjs";

// Kit orders with installation and Pay in 3 (#425, #426, #427; owner 27 Nov).
const now = new Date("2026-11-19T10:00:00Z"), secret = "kit-orders-tests", DAY = 86400000;
const text = { en: "Router", fr: "Routeur" };
const product = (id, price, stock) => ({ id, version: 1, sku: id.toUpperCase(), name: { en: id, fr: id }, description: text, warranty: text, images: [], price, cost: 1, stock, status: "published", categoryId: "" });
function state() {
  const s = storeState({ bundles: [], vouchers: [], payments: [], customers: [] });
  seedCatalogue(s, now);
  Object.assign(s.storeSettings, { open: true, pickup: "Akwa office", hours: "9–17", warranty: text, returns: text });
  s.storeProducts.push(product("router", 30000, 5));
  s.storeKits.push({ id: "kit-1", status: "on_sale", version: 1, ...kitInput(s, { name: { en: "Home kit", fr: "Kit maison" }, items: [{ productId: "router", quantity: 1 }],
    firstBundleId: "home-wisp-30d", price: 70000, setUp: true, installation: true, payIn3: true }) });
  s.storeSettings.installations = installSettingsInput({ price: 15000, areas: [{ id: "akwa", name: "Akwa", town: "Douala", travelFee: 2000 }],
    capacity: { morning: 1, afternoon: 1 }, technicians: [{ id: "eric", name: "Eric" }] }, null);
  return s;
}
const buyer = (overrides = {}) => ({ kitId: "kit-1", expectedPrice: 70000, name: "Amina", phone: "670000001", payerPhone: "690000002", network: "mtn", checkoutKey: randomUUID(), ...overrides });
const reserve = (s, input, at = now, customerId = "c1") => reserveOrder(s, input, { now: at, secret, customerId, provider: "mesomb" });
const pay = (s, o, at = now) => settleOrder(s, o, { status: "paid", transactionReference: o.payment.id, providerReference: "ref-" + o.id, amount: o.payment.amount, currency: "XAF" }, at);
const install = (overrides = {}) => ({ day: "2026-11-21", slot: "morning", areaId: "akwa", directions: "Behind the Total station, blue gate", phone: "670000009", ...overrides });

test("availability: Monday to Saturday from tomorrow, Full and Busy as drawn", () => {
  const s = state(), days = availability(s, now, 8);
  assert.equal(days[0].day, "2026-11-20");
  assert.equal(days.some((d) => d.day === "2026-11-22"), false, "no Sundays");
  assert.deepEqual(days[0].slots, { morning: { capacity: 1, left: 1 }, afternoon: { capacity: 1, left: 1 } });
  assert.throws(() => installSettingsInput({ price: 15000, areas: "x", technicians: [], capacity: {} }), /up to 30 areas/);
});

test("installation: two customers can't take the last slot; moving and cancelling stop 24 h before; Couldn't install refunds exactly its part", () => {
  const s = state();
  const { order: a } = reserve(s, buyer({ setup: "install", installation: install(), expectedAmount: 87000 }));
  assert.deepEqual([a.payment.amount, a.installation.reference, a.installation.status], [87000, "IN-1911-001", "booked"]);
  assert.deepEqual(a.breakdown, [{ part: "kit", amount: 70000 }, { part: "installation", amount: 15000 }, { part: "travel", amount: 2000 }]);
  // The slot is held while the first order's payment is pending: the second buyer is refused.
  assert.throws(() => reserve(s, buyer({ setup: "install", installation: install() }), now, "c2"), /just taken/);
  assert.equal(availability(s, now).find((d) => d.day === "2026-11-21").note, "busy");
  assert.throws(() => reserve(s, buyer({ setup: "install", installation: install({ slot: "afternoon" }), expectedAmount: 1 }), now, "c2"), /total changed/);
  pay(s, a);
  // Move: free until 24 h before the visit (21 Nov 08:00 Douala).
  moveBooking(s, a, { day: "2026-11-23", slot: "afternoon" }, now, "customer");
  assert.deepEqual([a.installation.day, a.installation.slot, a.installation.status], ["2026-11-23", "afternoon", "moved"]);
  const late = new Date(+slotStart("2026-11-23", "afternoon") - 23 * 3600000);
  assert.throws(() => moveBooking(s, a, { day: "2026-11-24", slot: "morning" }, late, "customer"), /up to 24 h before/);
  assert.throws(() => cancelBooking(s, a, late, "customer"), /up to 24 h before/);
  // Couldn't install: exactly the installation and travel come back; the rest can come back later.
  refundPart(a, a.installation.price + a.installation.travelFee, "Couldn't install", now);
  assert.deepEqual([a.payment.refund.amount, a.payment.refund.partial, a.payment.status], [17000, true, "paid"], "part of it: the order stays paid");
  assert.match(orderView(a).collectionCode, /^\d{6}$/, "and its code still collects the kit");
  a.payment.refunds = [{ ...a.payment.refund, status: "completed" }]; delete a.payment.refund; a.payment.status = "paid";
  assert.equal(refundable(a.payment), 70000);
  assert.throws(() => refundPart(a, 70001, "too much", now), /more than the payment can return/);
});

test("Pay in 3: the rules, the schedule (halfway, rounding to the last), eligibility, and the deposit with installation", () => {
  assert.deepEqual(planSchedule(70000, { depositPct: 40, days: 30 }, now).map((p) => [p.amount, p.dueAt.slice(0, 10)]), [[28000, "2026-11-19"], [21000, "2026-12-04"], [21000, "2026-12-19"]]);
  assert.deepEqual(planSchedule(70001, { depositPct: 30, days: 45 }, now).map((p) => p.amount), [21000, 24500, 24501], "rounding goes to the last");
  assert.throws(() => planRulesInput({ depositPct: 35, days: 30, grace: 7 }), /30, 40 or 50/);
  const s = state();
  const { order } = reserve(s, buyer({ pay: "plan", setup: "install", installation: install(), expectedAmount: 28000 + 17000 }));
  assert.equal(order.payment.amount, 45000, "the deposit plus installation and travel");
  assert.equal(order.plan.status, "pending");
  pay(s, order);
  assert.deepEqual([order.plan.status, order.plan.payments[0].paidAt !== null, order.stockState], ["running", true, "consumed"]);
  assert.equal(orderView(order).collectionCode, undefined, "no collection code before it's fully paid");
  // A late or cancelled plan in the last 6 months blocks a new one.
  assert.equal(planEligible(s, "c1", now), true);
  order.plan.late = true;
  assert.equal(planEligible(s, "c1", now), false);
  assert.throws(() => reserve(s, buyer({ pay: "plan", expectedAmount: 28000 })), /isn't available on your account/);
  assert.equal(planEligible(s, "c1", new Date(+now + 200 * DAY)), true, "after 6 months");
});

test("Pay in 3 payments: the next or the rest, idempotent, then the code; late beyond grace cancels and refunds; extend once", () => {
  const s = state();
  const { order } = reserve(s, buyer({ pay: "plan", expectedAmount: 28000 }));
  pay(s, order);
  const at = new Date(+now + DAY), input = { which: "next", expectedAmount: 21000, payerPhone: "690000002", network: "mtn", checkoutKey: randomUUID() };
  assert.throws(() => newPlanPayment(s, order, { ...input, expectedAmount: 20000 }, { now: at, secret, provider: "mesomb" }), /amount changed/);
  const { order: second } = newPlanPayment(s, order, input, { now: at, secret, provider: "mesomb" });
  assert.equal(newPlanPayment(s, order, input, { now: at, secret, provider: "mesomb" }).order.id, second.id, "a retry is the same payment");
  assert.throws(() => newPlanPayment(s, order, { ...input, checkoutKey: randomUUID() }, { now: at, secret, provider: "mesomb" }), /already waiting/);
  pay(s, second, at);
  assert.deepEqual([second.status, order.plan.payments[1].orderId], ["paid", second.id]);
  const { order: rest } = newPlanPayment(s, order, { ...input, which: "rest", checkoutKey: randomUUID() }, { now: at, secret, provider: "mesomb" });
  pay(s, rest, at);
  assert.equal(order.plan.status, "completed");
  assert.match(orderView(order).collectionCode, /^\d{6}$/, "the code once fully paid");
  assert.deepEqual(planMetrics(s, at), { running: 0, stillToPay: 0, late: 0, completionRate: 100 });

  // Another customer's plan goes late: marked late after the date, cancelled after the grace (and one extension).
  const { order: other } = reserve(s, buyer({ pay: "plan", expectedAmount: 28000 }), now, "c2");
  pay(s, other);
  const due = Date.parse(other.plan.payments[1].dueAt);
  sweepPlans(s, new Date(due + DAY));
  assert.deepEqual([other.plan.status, other.plan.late], ["running", true]);
  assert.equal(planMetrics(s, new Date(due + DAY)).late, 1);
  extendPlan(other, new Date(due + DAY), "owner");
  assert.throws(() => extendPlan(other, new Date(due + DAY), "owner"), /already extended once/);
  sweepPlans(s, new Date(due + 13 * DAY));
  assert.equal(other.plan.status, "running", "7 days of grace plus 7 more");
  sweepPlans(s, new Date(due + 15 * DAY));
  assert.deepEqual([other.plan.status, other.payment.refund.amount, other.payment.refund.restock], ["cancelled", 28000, true], "the deposit comes back, the kit goes back on sale");
});

test("reminders 3 days and 1 day before; the quote the screens show", () => {
  const s = state();
  const { order } = reserve(s, buyer({ pay: "plan", expectedAmount: 28000 }));
  pay(s, order);
  const due = Date.parse(order.plan.payments[1].dueAt);
  assert.deepEqual(planReminders(order, new Date(due - 2.5 * DAY)).map((r) => r.key), ["2:3d"]);
  assert.deepEqual(planReminders(order, new Date(due - 0.5 * DAY)).map((r) => r.key), ["2:1d"]);
  assert.deepEqual(planReminders(order, new Date(due - 5 * DAY)), []);
  const q = kitQuote(s, s.storeKits[0], { setup: "install", areaId: "akwa", pay: "plan" }, now);
  assert.deepEqual([q.today, q.total, q.installation.price, q.installation.travelFee, q.plan.payments[0].amount], [45000, 87000, 15000, 2000, 28000]);
  assert.equal(planRules(s).grace, 7);
  assert.equal(installSettings(s).technicians[0].name, "Eric");
});

test("notices: a plan's payment 3 days before, then late with its last day; under payments, shown by default", async () => {
  const { blank } = await import("../server.mjs");
  const { notificationItems } = await import("../lib/notifications.mjs");
  const s = Object.assign(blank(), state());
  s.customers.push({ id: "c1", phone: "670000001", name: "Amina" });
  const { order } = reserve(s, buyer({ pay: "plan", expectedAmount: 28000 }));
  pay(s, order);
  const due = Date.parse(order.plan.payments[1].dueAt);
  let items = notificationItems(s, { type: "customer", id: "c1" }, new Date(due - 2.5 * DAY));
  const soon = items.find((n) => n.id === `plan:${order.id}:2:3d`);
  assert.deepEqual([soon.category, soon.title, soon.url], ["payments", "Payment 2 of 3 due Fri 4 Dec", `/dashboard#plan/${order.id}`]);
  items = notificationItems(s, { type: "customer", id: "c1" }, new Date(due + DAY));
  const late = items.find((n) => n.id === `plan-late:${order.id}:2`);
  assert.match(late.body, /^Pay by Fri 11 Dec to keep Home kit; after that the plan is cancelled/);
});
