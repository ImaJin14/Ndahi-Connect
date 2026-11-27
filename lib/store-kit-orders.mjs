// Kit orders with installation and Pay in 3 (#425, #426, #427; decisions.md →
// "Kits, installations and payment plans (23 Nov)"; canvas AdminStoreServices,
// PhoneStarterKit, PhoneInstallBooking, PhoneInstalments; owner 27 Nov).
//
// Installations (#425):
// - Staff set the installation price, the areas with their travel fees, each
//   slot's capacity (morning 8:00–12:00, afternoon 13:00–17:00) and the
//   technicians (the Installations tab's settings panel, owner).
// - A booking holds its slot inside the checkout transaction, so two buyers
//   can't take the last one. Monday to Saturday, from tomorrow.
// - It is paid with the kit; moving or cancelling is free up to 24 h before;
//   "Couldn't install" refunds exactly the installation and travel.
// Pay in 3 (#426):
// - The rules (deposit 30/40/50%, rest within 30/45/60 days, grace 7/14 days,
//   items from a minimum price) are copied onto each plan. The deposit is
//   taken at checkout (with any installation); two equal payments follow,
//   the second halfway through the period (rounded up) and the last at its
//   end (owner); rounding goes to the last payment.
// - Each later payment is its own Mobile Money payment: a small linked order
//   (kind "plan_payment"), so the store's payment, receipt and refund code
//   handles it. Paying the rest at once is one such payment.
// - The kit is taken from stock at the deposit and held; the collection code
//   shows only once everything is paid.
// - Late past the grace (plus one extension of the grace length, owner):
//   cancelled, every payment refunded (their amounts, so the Mobile Money fees
//   aren't), the kit back on sale. A customer with a late or cancelled plan in
//   the last 6 months can't start another.
import { randomUUID } from "node:crypto";
import { fail, text, integer, trackingToken } from "./device-store.mjs";
import { hashSecret } from "./security.mjs";
import { quotePayment } from "./payment-fees.mjs";
import { normalizeCameroonPhone, validCameroonPhone } from "../shared-app/cameroon-phone.js";

const DAY = 86400000, ZONE_OFFSET_HOURS = 1; // Douala is UTC+1 all year.
export const SLOTS = Object.freeze({ morning: { start: 8, end: 12 }, afternoon: { start: 13, end: 17 } });
const localDay = (at) => new Date(+new Date(at) + ZONE_OFFSET_HOURS * 3600000).toISOString().slice(0, 10);
const dayDate = (day) => new Date(`${day}T00:00:00Z`);
export const slotStart = (day, slot) => new Date(Date.parse(`${day}T00:00:00Z`) + (SLOTS[slot].start - ZONE_OFFSET_HOURS) * 3600000);

// ---------- Installation settings (#425) ----------
export function installSettings(s) {
  s.storeSettings.installations ||= { price: null, areas: [], capacity: { morning: 0, afternoon: 0 }, technicians: [], version: 1 };
  return s.storeSettings.installations;
}
export function installSettingsInput(input, old) {
  const price = input.price === null ? null : integer(input.price, 1);
  if (!Array.isArray(input.areas) || input.areas.length > 30) fail("List up to 30 areas.");
  const areas = input.areas.map((a) => ({ id: typeof a?.id === "string" && a.id ? text(a.id, 60) : `area-${randomUUID().slice(0, 8)}`,
    name: text(a?.name, 80, true), town: text(a?.town || "", 80), travelFee: integer(a?.travelFee, 0) }));
  if (!Array.isArray(input.technicians) || input.technicians.length > 20) fail("List up to 20 technicians.");
  const technicians = input.technicians.map((t) => ({ id: typeof t?.id === "string" && t.id ? text(t.id, 60) : `tech-${randomUUID().slice(0, 8)}`, name: text(t?.name, 80, true) }));
  const capacity = { morning: integer(input.capacity?.morning, 0, 20), afternoon: integer(input.capacity?.afternoon, 0, 20) };
  return { price, areas, capacity, technicians, version: (old?.version || 0) + 1 };
}
export const installsOpen = (s) => { const c = installSettings(s); return Number.isSafeInteger(c.price) && c.areas.length > 0 && c.capacity.morning + c.capacity.afternoon > 0; };

// A booking holds its slot while its order's payment is pending (inside the
// reservation) and once paid, until it is installed, can't be, or is cancelled.
const holds = (o, now) => o.installation && ["booked", "moved", "on_the_way"].includes(o.installation.status) && o.status !== "cancelled" && o.status !== "expired" &&
  (o.payment.confirmedAt || (o.stockState === "reserved" && Date.parse(o.expiresAt) > +now));
export const slotsTaken = (s, day, slot, now, exceptId = null) =>
  s.storeOrders.filter((o) => o.id !== exceptId && holds(o, now) && o.installation.day === day && o.installation.slot === slot).length;
// The next working days (Monday to Saturday) from tomorrow, each slot's places
// left, and "full" (none left) or "busy" (one left) as drawn.
export function availability(s, now, count = 8, exceptId = null) {
  const c = installSettings(s), days = [];
  for (let n = 1; days.length < count && n < 40; n++) {
    const day = localDay(+now + n * DAY);
    if (dayDate(day).getUTCDay() === 0) continue;
    const slots = Object.fromEntries(Object.keys(SLOTS).map((slot) => [slot, { capacity: c.capacity[slot], left: Math.max(0, c.capacity[slot] - slotsTaken(s, day, slot, now, exceptId)) }]));
    const left = slots.morning.left + slots.afternoon.left;
    days.push({ day, slots, note: left === 0 ? "full" : left === 1 ? "busy" : null });
  }
  return days;
}
function slotChoice(s, day, slot, now, exceptId) {
  if (!SLOTS[slot]) fail("Choose morning or afternoon.");
  const open = availability(s, now, 8, exceptId).find((d) => d.day === day);
  if (!open) fail("Choose one of the days shown.");
  if (open.slots[slot].left < 1) fail("That slot was just taken. Choose another.", 409);
}
// What the customer books: day, slot, area, directions and the phone the technician calls.
export function bookingInput(s, input, now) {
  if (!installsOpen(s)) fail("Installation isn't available yet.", 409);
  const c = installSettings(s), day = text(input?.day, 10, true), slot = text(input?.slot, 20, true);
  slotChoice(s, day, slot, now);
  const area = c.areas.find((a) => a.id === input?.areaId);
  if (!area) fail("Choose your area.");
  const phone = normalizeCameroonPhone(input?.phone);
  if (!validCameroonPhone(phone)) fail("Enter the phone the technician should call.");
  return { day, slot, areaId: area.id, area: { name: area.name, town: area.town }, travelFee: area.travelFee, price: c.price,
    directions: text(input?.directions, 300, true), phone };
}
// "IN-2611-014": the booking's day and month, then its number that day.
export function bookingReference(s, now) {
  const d = localDay(now), prefix = `IN-${d.slice(8, 10)}${d.slice(5, 7)}-`;
  const n = s.storeOrders.filter((o) => o.installation?.reference?.startsWith(prefix)).length + 1;
  return prefix + String(n).padStart(3, "0");
}
export const canChangeBooking = (b, now) => +slotStart(b.day, b.slot) - +now >= DAY;
export function moveBooking(s, o, input, now, actor) {
  const b = o.installation;
  if (!b || !["booked", "moved"].includes(b.status) || o.status === "cancelled") fail("This installation can't be moved.", 409);
  if (!canChangeBooking(b, now)) fail("Moving is free up to 24 h before the visit. Call us to change it now.", 409);
  const day = text(input?.day, 10, true), slot = text(input?.slot, 20, true);
  slotChoice(s, day, slot, now, o.id);
  (b.history ||= []).push({ action: "moved", from: { day: b.day, slot: b.slot }, actor, at: now.toISOString() });
  Object.assign(b, { day, slot, status: "moved" });
  delete b.remindedFor;
}
export function cancelBooking(s, o, now, actor, { cutoff = true } = {}) {
  const b = o.installation;
  if (!b || !["booked", "moved"].includes(b.status) || o.status === "cancelled") fail("This installation can't be cancelled.", 409);
  if (cutoff && !canChangeBooking(b, now)) fail("Cancelling is free up to 24 h before the visit. Call us to cancel now.", 409);
  b.status = "cancelled"; (b.history ||= []).push({ action: "cancelled", actor, at: now.toISOString() });
  // Paid: the installation and travel come back; the kit is collected at the shop.
  if (o.payment.confirmedAt) refundPart(o, b.price + b.travelFee, "Installation cancelled", now);
}

// ---------- Partial refunds ----------
// What a payment can still give back after earlier partial refunds.
export const refundable = (p) => p.amount - (p.refunds || []).filter((r) => r.status === "completed").reduce((sum, r) => sum + r.amount, 0);
// Requests a refund of part of an order's payment (the store's refund worker sends it).
export function refundPart(o, amount, reason, now) {
  const p = o.payment;
  if (p.refund) fail("A refund is already in progress for this payment.", 409);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > refundable(p)) fail("That refund is more than the payment can return.", 409);
  const partial = amount < refundable(p);
  p.refund = { id: randomUUID(), status: "requested", reason, amount, partial, restock: false, requestedAt: now.toISOString() };
  // Part of it: the order stays paid (its code still collects the kit); the
  // refund's own status says how it's going, and the store worker sends it.
  if (!partial) p.status = "refund-pending";
}

// ---------- Pay in 3 (#426) ----------
export const DEPOSITS = [30, 40, 50], PERIODS = [30, 45, 60], GRACES = [7, 14];
export function planRules(s) {
  s.storeSettings.payPlans ||= { depositPct: 40, days: 30, grace: 7, minPrice: null, version: 1 };
  return s.storeSettings.payPlans;
}
export function planRulesInput(input, old) {
  if (!DEPOSITS.includes(input.depositPct)) fail("Choose a deposit of 30, 40 or 50%.");
  if (!PERIODS.includes(input.days)) fail("Choose 30, 45 or 60 days for the rest.");
  if (!GRACES.includes(input.grace)) fail("Choose 7 or 14 days of grace.");
  return { depositPct: input.depositPct, days: input.days, grace: input.grace, minPrice: input.minPrice === null ? null : integer(input.minPrice, 1), version: (old?.version || 0) + 1 };
}
// Deposit, then two equal payments; rounding goes to the last.
export function planSchedule(price, rules, start) {
  const deposit = Math.floor(price * rules.depositPct / 100), rest = price - deposit, second = Math.floor(rest / 2);
  const at = (days) => new Date(+new Date(start) + days * DAY).toISOString();
  return [{ n: 1, amount: deposit, dueAt: new Date(start).toISOString() }, { n: 2, amount: second, dueAt: at(Math.ceil(rules.days / 2)) }, { n: 3, amount: rest - second, dueAt: at(rules.days) }];
}
// No late or cancelled plan in the last 6 months (checked here, never in the browser).
export function planEligible(s, customerId, now) {
  const since = +now - 183 * DAY;
  return !s.storeOrders.some((o) => o.customerId === customerId && o.plan && (o.plan.status === "cancelled" || o.plan.late) &&
    Date.parse(o.plan.startedAt || o.createdAt) >= since);
}
export const planOffered = (s, kit) => kit.payIn3 === true && (planRules(s).minPrice === null || kit.price >= planRules(s).minPrice);
const unpaid = (plan) => plan.payments.filter((p) => !p.paidAt);
export const planDeadline = (plan, payment) => new Date(Date.parse(payment.dueAt) + (plan.rules.grace + (plan.extension?.days || 0)) * DAY);
export const planLeft = (plan) => unpaid(plan).reduce((sum, p) => sum + p.amount, 0);

// What a kit order costs today and in all, for each choice (#427): the kit page
// and its next screens show these numbers, never their own.
export function kitQuote(s, kit, { setup, areaId, pay, network }, now, feeRules = {}) {
  const c = installSettings(s), install = setup === "install";
  const area = install ? c.areas.find((a) => a.id === areaId) || null : null;
  const installation = install ? { price: c.price, travelFee: area ? area.travelFee : null } : null;
  const extra = install ? (c.price || 0) + (area ? area.travelFee : 0) : 0;
  const plan = pay === "plan" ? planSchedule(kit.price, planRules(s), now) : null;
  const today = (plan ? plan[0].amount : kit.price) + extra;
  return { kitPrice: kit.price, installation, plan: plan ? { rules: { depositPct: planRules(s).depositPct, days: planRules(s).days, grace: planRules(s).grace }, payments: plan } : null,
    today, total: kit.price + extra, ...(network ? { paymentQuote: quotePayment(today, network, feeRules) } : {}),
    paymentQuotes: Object.fromEntries(["mtn", "orange"].map((n) => [n, quotePayment(today, n, feeRules)])) };
}

// Checkout choices for a kit order (reserveKitOrder calls this inside its transaction).
export function kitChoices(s, kit, input, { customerId, now }) {
  const setup = input.setup === undefined ? "self" : input.setup, pay = input.pay === undefined ? "full" : input.pay;
  if (!["self", "install"].includes(setup)) fail("Choose how it's set up.");
  if (!["full", "plan"].includes(pay)) fail("Choose how to pay.");
  let installation = null, plan = null;
  if (setup === "install") {
    if (!kit.installation) fail("This kit isn't offered with installation.", 409);
    installation = { id: randomUUID(), reference: bookingReference(s, now), status: "booked", technicianId: null, history: [], ...bookingInput(s, input.installation, now) };
  }
  if (pay === "plan") {
    if (!planOffered(s, kit)) fail("Pay in 3 isn't offered for this kit.", 409);
    if (!planEligible(s, customerId, now)) fail("Pay in 3 isn't available on your account right now: a plan was late or cancelled in the last 6 months. Pay in full instead.", 409);
    const rules = planRules(s);
    plan = { rules: { depositPct: rules.depositPct, days: rules.days, grace: rules.grace }, price: kit.price, status: "pending", startedAt: null, late: false,
      payments: planSchedule(kit.price, rules, now).map((p) => ({ ...p, paidAt: null, orderId: null })) };
  }
  const extra = installation ? installation.price + installation.travelFee : 0;
  const today = (plan ? plan.payments[0].amount : kit.price) + extra;
  if (input.expectedAmount !== undefined && input.expectedAmount !== today) fail("The total changed. Reload before paying.", 409);
  const breakdown = [{ part: plan ? "deposit" : "kit", amount: plan ? plan.payments[0].amount : kit.price },
    ...(installation ? [{ part: "installation", amount: installation.price }, { part: "travel", amount: installation.travelFee }] : [])];
  return { setupChoice: setup, payChoice: pay, installation, plan, today, breakdown };
}

// A plan's deposit (the kit order itself) was paid: the dates start now.
export function planStarted(o, now) {
  if (!o.plan || o.plan.status !== "pending") return;
  const start = now.toISOString(), schedule = planSchedule(o.plan.price, o.plan.rules, now);
  o.plan.payments = o.plan.payments.map((p, i) => ({ ...p, dueAt: schedule[i].dueAt, ...(p.n === 1 ? { paidAt: start, orderId: o.id } : {}) }));
  Object.assign(o.plan, { status: "running", startedAt: start });
}

// A later payment as its own small order: the store's payment, receipt and
// refund handling works on it unchanged.
export function newPlanPayment(s, parent, input, { now, secret, provider, clientIp, feeRules = {} }) {
  const plan = parent.plan;
  if (!plan || plan.status !== "running") fail("This plan isn't taking payments.", 409);
  const which = input.which === "rest" ? "rest" : "next", left = unpaid(plan);
  const covers = which === "rest" ? left.map((p) => p.n) : [left[0].n], amount = left.filter((p) => covers.includes(p.n)).reduce((sum, p) => sum + p.amount, 0);
  if (input.expectedAmount !== amount) fail("The amount changed. Reload before paying.", 409);
  const checkoutKey = text(input.checkoutKey, 100, true);
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(checkoutKey)) fail("Use a fresh checkout key.");
  // Later payments charge the deposit's number and network unless others are
  // given (owner, 27 Nov, #375).
  const payerPhone = normalizeCameroonPhone(input.payerPhone ?? parent.payment.payerPhone), network = input.network ?? parent.payment.network;
  if (!validCameroonPhone(payerPhone)) fail("Enter a valid Cameroon payment number.");
  if (!["mtn", "orange"].includes(network)) fail("Choose MTN or Orange Money.");
  const keyHash = hashSecret(checkoutKey, secret), fingerprint = hashSecret(JSON.stringify([parent.id, covers, payerPhone, network, provider]), secret);
  const existing = s.storeOrders.find((o) => o.checkoutKeyHash === keyHash);
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail("This checkout key was already used for another payment.", 409);
    return { order: existing, replayed: true };
  }
  // One payment in flight at a time: a new one waits for the last to settle or expire.
  if (s.storeOrders.some((o) => o.kind === "plan_payment" && o.parentId === parent.id && o.status === "awaiting_payment" && o.stockState === "reserved" && Date.parse(o.expiresAt) > +now))
    fail("A payment for this plan is already waiting for approval on your phone.", 409);
  const id = randomUUID(), at = now.toISOString(), quote = quotePayment(amount, network, provider === "flutterwave" ? {} : feeRules);
  const label = (lang) => `${parent.kit.name[lang] || parent.kit.name.en} · ${covers.length > 1 ? (lang === "fr" ? "solde" : "the rest") : (lang === "fr" ? `paiement ${covers[0]} sur 3` : `payment ${covers[0]} of 3`)}`;
  const order = {
    id, kind: "plan_payment", parentId: parent.id, covers, reference: `NS-${id.slice(0, 8).toUpperCase()}`, version: 1, productId: null, lines: [],
    product: { id: parent.kitId, sku: parent.product.sku, name: { en: label("en"), fr: label("fr") }, price: amount, warranty: parent.product.warranty, kit: true },
    quantity: 1, unitPrice: amount, seller: parent.seller, contact: parent.contact, customerId: parent.customerId, fingerprint, checkoutKeyHash: keyHash,
    trackingHash: hashSecret(trackingToken(id, keyHash, secret), secret), pickup: parent.pickup, hours: parent.hours, returns: parent.returns,
    createdAt: at, expiresAt: new Date(+now + 10 * 60000).toISOString(), status: "awaiting_payment", stockState: "reserved", history: [],
    payment: { id: `store-${id}`, provider, amount, fee: quote.fee, total: quote.total, currency: "XAF", payerPhone, network,
      email: parent.contact.email || undefined, customerName: parent.contact.name, clientIp, status: "pending", creationState: "reserved", createdAt: at },
  };
  s.storeOrders.unshift(order);
  return { order, replayed: false };
}
// What the next payment and the rest cost with the deposit's network, fee
// included, for the plan screen's buttons (#375).
export function planQuotes(o, feeRules = {}) {
  if (o.plan?.status !== "running") return null;
  const left = unpaid(o.plan), rules = o.payment.provider === "flutterwave" ? {} : feeRules, network = o.payment.network;
  if (!left.length) return null;
  return { network, next: quotePayment(left[0].amount, network, rules), rest: quotePayment(left.reduce((sum, p) => sum + p.amount, 0), network, rules) };
}
// A later payment confirmed: its instalments are paid; all paid ends the plan.
export function planPaymentSettled(s, child, now) {
  const parent = s.storeOrders.find((o) => o.id === child.parentId), plan = parent?.plan;
  if (!plan || plan.status !== "running") {
    // The plan ended meanwhile: the payment goes to review for a refund.
    child.payment.review = "plan_closed"; child.status = "review"; return;
  }
  for (const p of plan.payments) if (child.covers.includes(p.n) && !p.paidAt) Object.assign(p, { paidAt: now.toISOString(), orderId: child.id });
  child.status = "paid";
  if (!unpaid(plan).length) { plan.status = "completed"; plan.completedAt = now.toISOString(); }
  parent.version++;
}
// Cancels a plan: every payment made comes back (its amount; the Mobile Money
// fees don't), the kit goes back on sale once the deposit's refund completes,
// and any booked installation is cancelled.
export function cancelPlan(s, parent, now, reason, actor) {
  const plan = parent.plan;
  if (!plan || !["running", "pending"].includes(plan.status)) fail("This plan can't be cancelled.", 409);
  Object.assign(plan, { status: "cancelled", cancelledAt: now.toISOString(), cancelReason: reason, cancelledBy: actor });
  if (parent.installation && ["booked", "moved", "on_the_way"].includes(parent.installation.status)) {
    parent.installation.status = "cancelled"; parent.installation.history.push({ action: "cancelled", actor, reason: "plan_cancelled", at: now.toISOString() });
  }
  if (parent.payment.confirmedAt && !parent.payment.refund) {
    parent.payment.refund = { id: randomUUID(), status: "requested", reason: reason === "late" ? "Payment plan cancelled: late" : "Payment plan cancelled",
      amount: refundable(parent.payment), restock: true, requestedAt: now.toISOString() };
    parent.payment.status = "refund-pending";
  }
  for (const child of s.storeOrders.filter((o) => o.kind === "plan_payment" && o.parentId === parent.id && o.payment.confirmedAt && !o.payment.refund)) {
    child.payment.refund = { id: randomUUID(), status: "requested", reason: "Payment plan cancelled", amount: child.payment.amount, restock: false, requestedAt: now.toISOString() };
    child.payment.status = "refund-pending";
  }
  parent.version++;
}
// Late plans: marked late once a payment is overdue; cancelled past the grace.
export function sweepPlans(s, now) {
  const cancelled = [];
  for (const o of s.storeOrders.filter((x) => x.plan?.status === "running")) {
    const due = unpaid(o.plan);
    if (due.some((p) => Date.parse(p.dueAt) < +now) && !o.plan.late) Object.assign(o.plan, { late: true, lateAt: now.toISOString() });
    if (due.some((p) => +planDeadline(o.plan, p) < +now)) { cancelPlan(s, o, now, "late", "system"); cancelled.push(o.id); }
  }
  return cancelled;
}
export function extendPlan(o, now, actor) {
  const plan = o.plan;
  if (!plan || plan.status !== "running") fail("Only a running plan can be extended.", 409);
  if (plan.extension) fail("This plan was already extended once.", 409);
  plan.extension = { days: plan.rules.grace, at: now.toISOString(), by: actor };
}
// The Payment plans tab's figures.
export function planMetrics(s, now) {
  const plans = s.storeOrders.filter((o) => o.plan && o.plan.status !== "pending").map((o) => o.plan);
  const running = plans.filter((p) => p.status === "running"), done = plans.filter((p) => p.status === "completed").length, ended = done + plans.filter((p) => p.status === "cancelled").length;
  return { running: running.length, stillToPay: running.reduce((sum, p) => sum + planLeft(p), 0),
    late: running.filter((p) => unpaid(p).some((x) => Date.parse(x.dueAt) < +now)).length, completionRate: ended ? Math.round(done / ended * 100) : null };
}
// Reminders 3 days and 1 day before each date (and staff's "Send reminder"):
// which are due now, by key, for notices and emails.
export function planReminders(o, now) {
  const plan = o.plan;
  if (!plan || plan.status !== "running") return [];
  const next = unpaid(plan)[0];
  if (!next) return [];
  const keys = [];
  for (const days of [3, 1]) if (+now >= Date.parse(next.dueAt) - days * DAY && +now < Date.parse(next.dueAt) - (days === 3 ? 1 : 0) * DAY) keys.push({ key: `${next.n}:${days}d`, n: next.n, days, dueAt: next.dueAt, amount: next.amount });
  for (const r of plan.reminders || []) if (+now - Date.parse(r.at) < 7 * DAY) keys.push({ key: `manual:${r.at}`, n: next.n, days: null, dueAt: next.dueAt, amount: next.amount, manual: true });
  return keys;
}
// Booking notices: confirmed, and the day before.
export function bookingReminders(o, now) {
  const b = o.installation;
  if (!b || !["booked", "moved"].includes(b.status) || !o.payment.confirmedAt) return [];
  const start = +slotStart(b.day, b.slot), keys = [{ key: `booked:${b.day}:${b.slot}`, kind: "booked" }];
  if (+now >= start - 1.5 * DAY && +now < start) keys.push({ key: `tomorrow:${b.day}:${b.slot}`, kind: "tomorrow" });
  return keys;
}
