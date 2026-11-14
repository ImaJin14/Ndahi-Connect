// Outages (#259, server task 4; canvas: PhoneOutage, AdminOutage). Staff post a
// notice in English and French, post updates, then close the outage and choose
// the time to give back. Customers see the notice on Home and in their
// notifications, then "We're back online" with the time added.
import { randomUUID } from "node:crypto";

const HOUR = 36e5, DAY = 864e5;
// Customers keep seeing "We're back online" for a day after the fix.
export const RESTORED_NOTICE_MS = DAY;
// The give-back choices on the canvas: the outage length rounded up to whole
// hours (suggested), one day, or nothing.
export const COMPENSATIONS = ["round", "day", "none"];

const text = (value, max) => String(value || "").trim().slice(0, max);
export const outageLengthMs = (o, now) => Math.max(0, Date.parse(o.fixedAt || new Date(now).toISOString()) - Date.parse(o.startedAt));
export const roundedHours = (ms) => Math.max(1, Math.ceil(ms / HOUR));
export const hoursFor = (choice, o, now) => (choice === "day" ? 24 : choice === "round" ? roundedHours(outageLengthMs(o, now)) : 0);
export const liveOutage = (s) => (s.outages || []).find((o) => o.status === "live") || null;

// Bundles that were running at some point during [start, end]: still active,
// or ended by time during the outage (those are extended too). Used-up,
// revoked and replaced bundles get nothing: more time does not help them.
export function affectedVouchers(s, o, now) {
  const start = Date.parse(o.startedAt), end = Date.parse(o.fixedAt || new Date(now).toISOString());
  return s.vouchers.filter((v) => v.customerId && Date.parse(v.activatedAt) <= end && Date.parse(v.expiresAt) > start &&
    (v.status === "active" || v.status === "expired" && Date.parse(v.expiresAt) <= end));
}
export const activeBundleCount = (s, now) => s.vouchers.filter((v) => v.status === "active" && Date.parse(v.expiresAt) > +now).length;

export function validOutage(input, now) {
  const startedAt = Date.parse(input.startedAt || new Date(now).toISOString()), next = input.nextUpdateBy ? Date.parse(input.nextUpdateBy) : null;
  const message = { en: text(input.message?.en, 500), fr: text(input.message?.fr, 500) }, area = text(input.area, 80);
  if (!area) return { error: "Choose the affected area." };
  if (!message.en || !message.fr) return { error: "Write the message in English and French." };
  if (!Number.isFinite(startedAt) || startedAt > +now + 60000) return { error: "Enter when it started (not in the future)." };
  if (next !== null && !(next > +now)) return { error: "The next update must be later than now." };
  return { outage: { id: randomUUID(), status: "live", area, startedAt: new Date(startedAt).toISOString(), ...(next ? { nextUpdateBy: new Date(next).toISOString() } : {}),
    message, showToCustomers: input.showToCustomers !== false, notify: input.notify !== false, updates: [], createdAt: new Date(now).toISOString() } };
}

// Adds the hours to every affected bundle, once. A bundle that ended during
// the outage runs again if the added time takes it past now.
export function giveTimeBack(s, o, hours, now, enqueue) {
  if (o.compensation) return o.compensation;
  const vouchers = hours > 0 ? affectedVouchers(s, o, now) : [];
  for (const v of vouchers) {
    v.expiresAt = new Date(Date.parse(v.expiresAt) + hours * HOUR).toISOString();
    if (v.status === "expired" && Date.parse(v.expiresAt) > +now) v.status = "active";
    (v.outageCredits ||= []).push({ outageId: o.id, hours });
    if (v.status === "active") { enqueue(s, { action: "sync_voucher", targetId: v.id }); v.routerSyncStatus = "pending"; }
  }
  o.compensation = { hours, voucherIds: vouchers.map((v) => v.id), customerIds: [...new Set(vouchers.map((v) => v.customerId))], at: new Date(now).toISOString() };
  return o.compensation;
}

// What a customer's Home shows: the live notice, or for a day after the fix
// "We're back online" with the hours their own bundle got.
export function customerOutage(s, customerId, now) {
  const live = liveOutage(s);
  if (live && live.showToCustomers) return { state: "down", ...noticeView(live) };
  const fixed = (s.outages || []).filter((o) => o.status === "fixed" && o.showToCustomers && +now - Date.parse(o.fixedAt) < RESTORED_NOTICE_MS)
    .sort((a, b) => Date.parse(b.fixedAt) - Date.parse(a.fixedAt))[0];
  if (!fixed) return null;
  const credit = s.vouchers.filter((v) => v.customerId === customerId).flatMap((v) => v.outageCredits || []).find((c) => c.outageId === fixed.id);
  return { state: "restored", ...noticeView(fixed), fixedAt: fixed.fixedAt, addedHours: credit ? credit.hours : 0 };
}

// The public notice (hotspot page, portal): area, times and both languages.
export function noticeView(o) {
  const last = o.updates.at(-1);
  return { id: o.id, area: o.area, startedAt: o.startedAt, nextUpdateBy: o.nextUpdateBy || null, message: o.message,
    updatedAt: last ? last.at : o.createdAt, ...(last ? { lastUpdate: last.text } : {}) };
}

// The staff view of an outage.
export function staffView(s, o, now) {
  return { ...noticeView(o), status: o.status, showToCustomers: o.showToCustomers, notify: o.notify, updates: o.updates, fixedAt: o.fixedAt || null,
    lengthMs: outageLengthMs(o, now), affected: o.compensation ? o.compensation.voucherIds.length : affectedVouchers(s, o, now).length,
    compensation: o.compensation ? { hours: o.compensation.hours, customers: o.compensation.customerIds.length } : null, cause: o.cause || null };
}
