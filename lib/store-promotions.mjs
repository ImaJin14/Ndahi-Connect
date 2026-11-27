// Store promotions (#302): a sale price on chosen products for a time window,
// with a limit per phone number and an optional free bundle. First use: Black
// Friday, 27-30 Nov 2026: any AX1500 for 100,000 FCFA with a month of
// Unlimited, given when the router is collected and started by the customer
// within 60 days (owner, 23 Nov, #423; replaces the 20 Nov rule).
//
// Promotions live in storeSettings.promotions and are set up in the admin.
// The server alone decides whether a sale applies; the front ends show what
// the catalogue returns. Selection started from Codex's draft (20 Nov): exact
// product IDs only, UTC times with an inclusive start and an exclusive end,
// and invalid or overlapping enabled promotions fail closed.
import { randomUUID } from "node:crypto";

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_PRICE = 100_000_000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const PROMOTION_STATUSES = Object.freeze(["draft", "scheduled", "live", "ended"]);

function utcTime(value) {
  if (typeof value !== "string" || !UTC.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  // Reject dates that Date.parse silently normalizes, such as February 30.
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  return new Date(time).toISOString() === canonical ? time : null;
}

function localized(value, max) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const en = typeof value.en === "string" ? value.en.trim() : "";
  const fr = typeof value.fr === "string" ? value.fr.trim() : "";
  if (!en || !fr || en.length > max || fr.length > max) return null;
  return { en, fr };
}

// The free bundle: a plan from the catalogue, how long it lasts once started,
// and how many days the customer has to start it. Owner, 23 Nov (#423): it is
// given when the router is collected and its days start when the customer
// presses Start, within the window (60 days by default).
//
// "payment_confirmation" is the 20 Nov rule (days from payment). A promotion
// saved under it is read as the new rule: the owner replaced that rule before
// the sale opened. Orders keep the rule they were placed under, because the
// order holds its own copy (order.promotion.bonus).
//
// From #345 (owner, 27 Nov) the free bundle is an Unlimited catalogue bundle
// (`bundleId`; its length is the bundle's), given at collection or, if staff
// choose, as soon as the payment is confirmed. Older promotions name a plan
// from the earlier catalogue (`planId`) and keep working.
export const BONUS_START_WITHIN_DAYS = 60;
export const BONUS_GIVEN = Object.freeze(["collection", "payment"]);
export function validBonus(bonus) {
  if (bonus === null || bonus === undefined) return null;
  const within = bonus?.startWithinDays ?? BONUS_START_WITHIN_DAYS;
  const bundle = typeof bonus?.bundleId === "string";
  if (typeof bonus !== "object" || Array.isArray(bonus) || !ID.test((bundle ? bonus.bundleId : bonus.planId) || "") ||
      !Number.isSafeInteger(bonus.validityHours) || bonus.validityHours < 1 || bonus.validityHours > 8760 ||
      !["customer_start", "payment_confirmation"].includes(bonus.startsAt) ||
      (bonus.givenAt != null && !BONUS_GIVEN.includes(bonus.givenAt)) || (!bundle && bonus.givenAt === "payment") ||
      !Number.isSafeInteger(within) || within < 1 || within > 365) return undefined;
  return { ...(bundle ? { bundleId: bonus.bundleId } : { planId: bonus.planId }), validityHours: bonus.validityHours, startsAt: "customer_start",
    givenAt: bonus.givenAt || "collection", startWithinDays: within };
}
// The free bundle's catalogue entry, shaped as the earlier plans are so the
// store, the order and the voucher describe both the same way.
export function bonusPlan(s, bonus, plans = []) {
  if (!bonus) return null;
  if (!bonus.bundleId) return plans.find((plan) => plan.id === bonus.planId) || null;
  const b = (s.bundles || []).find((x) => x.id === bonus.bundleId && ["personal_unlimited", "home_wisp_unlimited"].includes(x.accessType));
  if (!b) return null;
  return { id: b.id, name: b.name, price: b.price ?? null, validityHours: b.validityHours, quotaGb: null, fairUse: false,
    deviceLimit: b.accessType === "personal_unlimited" ? b.deviceSlots : 1, accessType: b.accessType, deviceSlots: b.deviceSlots ?? null, bundle: b };
}

function validatedPromotion(p) {
  if (!p || typeof p !== "object" || Array.isArray(p) || p.enabled !== true) return null;
  const id = typeof p.id === "string" ? p.id.trim() : "";
  const name = localized(p.name, 120);
  const terms = localized(p.terms, 4000);
  const start = utcTime(p.startsAt);
  const end = utcTime(p.endsAt);
  const productIds = p.productIds;
  const validIds = Array.isArray(productIds) && productIds.length > 0 && productIds.length <= 20 &&
    productIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100 && id.trim() === id) &&
    new Set(productIds).size === productIds.length;
  const bonus = validBonus(p.bonus);
  const perNumberLimit = p.perNumberLimit ?? 1, units = p.units ?? null;
  const endedEarly = p.endedEarlyAt == null ? null : utcTime(p.endedEarlyAt);
  if (!id || id.length > 100 || !name || !terms || !validIds ||
      !Number.isSafeInteger(p.salePrice) || p.salePrice < 1 || p.salePrice > MAX_PRICE ||
      start === null || end === null || start >= end || bonus === undefined ||
      !Number.isSafeInteger(perNumberLimit) || perNumberLimit < 1 || perNumberLimit > 10 ||
      (units !== null && (!Number.isSafeInteger(units) || units < 1 || units > 100000)) ||
      (p.endedEarlyAt != null && endedEarly === null)) return null;
  return {
    id, name, productIds: [...productIds], salePrice: p.salePrice,
    startsAt: p.startsAt, endsAt: p.endsAt, terms, perNumberLimit, bonus, units, showWas: p.showWas === true,
    ...(p.endedEarlyAt ? { endedEarlyAt: p.endedEarlyAt } : {}),
  };
}

/**
 * Select the one active offer for an exact product ID. Start is inclusive and
 * end is exclusive; "End early" ends it from that moment. Invalid enabled
 * offers or overlapping active offers throw, so callers cannot confuse invalid
 * configuration with no offer. Never infer product eligibility from a display
 * name or SKU substring. Returns a detached snapshot suitable for an order.
 */
export function activeStorePromotion(promotions, productId, now) {
  if (promotions == null) promotions = [];
  if (!Array.isArray(promotions)) throw new Error("Invalid store promotions configuration");
  if (typeof productId !== "string" || !productId || productId.trim() !== productId || productId.length > 100)
    throw new Error("Invalid store product ID");
  const at = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(at)) throw new Error("Invalid store promotion time");
  const valid = [];
  const ids = new Set();
  for (const p of promotions) {
    if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.enabled !== "boolean")
      throw new Error("Invalid store promotion configuration");
    if (!p.enabled) continue;
    const configured = validatedPromotion(p);
    if (!configured) throw new Error("Invalid enabled store promotion");
    if (ids.has(configured.id)) throw new Error("Duplicate store promotion ID");
    ids.add(configured.id);
    valid.push(configured);
  }
  const active = valid.filter((p) => p.productIds.includes(productId) && utcTime(p.startsAt) <= at && at < utcTime(p.endsAt) &&
    !(p.endedEarlyAt && utcTime(p.endedEarlyAt) <= at));
  if (active.length > 1) throw new Error("Overlapping store promotions");
  if (active.length === 0) return null;
  return structuredClone(active[0]);
}

// The catalogue and checkout ask here. A configuration problem never falls
// back to the regular price silently: the product is shown without the offer
// and can't be bought until the promotion is fixed.
// "Units at this price" (#345): once that many are sold the sale stops, as it
// does when the stock runs out.
export function promotionForProduct(s, productId, now) {
  try {
    const promotion = activeStorePromotion(s.storeSettings?.promotions || [], productId, now);
    if (promotion?.units != null && unitsSold(s, promotion.id) >= promotion.units) return { promotion: null, error: null, soldOut: true };
    return { promotion, error: null };
  } catch (error) {
    return { promotion: null, error: error.message };
  }
}

// Orders that count against a promotion: every order placed at its price that
// has not failed, expired or been cancelled before payment.
const counts = (o) => !["cancelled", "expired"].includes(o.status) && o.payment?.status !== "failed";
export function promotionOrders(s, promotionId) {
  return (s.storeOrders || []).filter((o) => o.promotion?.id === promotionId && counts(o));
}
export const unitsSold = (s, promotionId) => promotionOrders(s, promotionId).reduce((n, o) => n + (o.quantity || 1), 0);
export const unitsLeft = (s, promotion) => (promotion?.units == null ? null : Math.max(0, promotion.units - unitsSold(s, promotion.id)));

// "Show the regular price crossed out" (#345; owner, 27 Nov): only when the
// promotion asks for it AND the product really sold at its regular price in
// the 30 days before the sale (paid orders outside any promotion).
export function soldAtRegular(s, product, before, days = 30) {
  if (!product || !Number.isSafeInteger(product.price)) return false;
  const end = +before, start = end - days * 864e5;
  return (s.storeOrders || []).some((o) => o.productId === product.id && !o.promotion && o.unitPrice === product.price && o.payment?.confirmedAt &&
    !o.payment.refund && Date.parse(o.payment.confirmedAt) >= start && Date.parse(o.payment.confirmedAt) < end);
}
export const wasPrice = (s, promotion, product, now) =>
  promotion?.showWas && product && soldAtRegular(s, product, Math.min(Date.parse(promotion.startsAt), +now)) ? product.price : null;

// One per phone number (owner, 20 Nov): the paying number, the order's contact
// number and the signed-in account all count as the same buyer.
export function numberAlreadyUsed(s, promotion, { payerPhone, contactPhone, customerId }) {
  const used = promotionOrders(s, promotion.id).filter((o) =>
    o.payment.payerPhone === payerPhone || o.contact?.phone === contactPhone || o.payment.payerPhone === contactPhone ||
    o.contact?.phone === payerPhone || (customerId && o.customerId === customerId));
  return used.length >= promotion.perNumberLimit;
}

// What the store front ends show. The bonus is described from the catalogue
// plan, never invented in the browser.
// `extra` carries what needs the state: the regular price to cross out (only
// when it really sold at it, see wasPrice) and the units left at this price.
export function promotionView(promotion, product, plan, extra = {}) {
  return {
    id: promotion.id, name: promotion.name, terms: promotion.terms,
    salePrice: promotion.salePrice, startsAt: promotion.startsAt, endsAt: promotion.endedEarlyAt || promotion.endsAt, perNumberLimit: promotion.perNumberLimit,
    regularPrice: extra.regularPrice ?? null, units: promotion.units ?? null, unitsLeft: extra.unitsLeft ?? null,
    bonus: promotion.bonus && plan ? {
      planId: plan.id, planName: plan.name, days: Math.round(promotion.bonus.validityHours / 24),
      quotaGb: plan.quotaGb ?? null, deviceLimit: plan.deviceLimit, fairUse: Boolean(plan.fairUse), worth: plan.price ?? null,
      // An Unlimited bundle (#345): its access type and devices, as the catalogue shows them.
      ...(plan.accessType ? { accessType: plan.accessType, deviceSlots: plan.deviceSlots } : {}),
      // The free bundle's speed limit, when it has one (#263).
      ...(plan.downloadMbps || plan.uploadMbps ? { downloadMbps: plan.downloadMbps ?? null, uploadMbps: plan.uploadMbps ?? null } : {}),
      // Given at collection, started by the customer within this many days.
      startsAt: promotion.bonus.startsAt, givenAt: promotion.bonus.givenAt, startWithinDays: promotion.bonus.startWithinDays,
    } : null,
  };
}

// The admin form: everything checked here so an invalid promotion can never be
// saved (the catalogue would otherwise hide the offer).
// `plans` is the bundle catalogue (lib/api/state.mjs catalogue).
export function promotionInput(s, input, existing, now, plans = []) {
  const problem = (message) => { throw Object.assign(Error(message), { status: 400 }); };
  const name = localized(input.name, 120) || problem("Enter the name customers see.");
  const terms = localized(input.terms, 4000) || problem("Enter the terms in English and French.");
  const productIds = Array.isArray(input.productIds) ? [...new Set(input.productIds)] : [];
  if (!productIds.length || productIds.length > 20) problem("Choose the products on offer.");
  for (const id of productIds) if (!(s.storeProducts || []).some((p) => p.id === id)) problem("Choose existing products.");
  if (!Number.isSafeInteger(input.salePrice) || input.salePrice < 1 || input.salePrice > MAX_PRICE) problem("Enter the sale price in FCFA.");
  const start = utcTime(input.startsAt), end = utcTime(input.endsAt);
  if (start === null || end === null || start >= end) problem("Choose a start and an end, the end after the start.");
  const perNumberLimit = input.perNumberLimit ?? 1;
  if (!Number.isSafeInteger(perNumberLimit) || perNumberLimit < 1 || perNumberLimit > 10) problem("Choose how many each number can buy (1 to 10).");
  const units = input.units ?? null;
  if (units !== null && (!Number.isSafeInteger(units) || units < 1 || units > 100000)) problem("Enter how many units are at this price (1 to 100,000), or leave it empty.");
  // The free bundle (#345): an Unlimited catalogue bundle, its length the
  // bundle's. A promotion saved earlier with a plan keeps it while unchanged.
  let bonus;
  if (input.bonus?.bundleId) {
    const old = existing?.bonus?.bundleId === input.bonus.bundleId;
    const b = (s.bundles || []).find((x) => x.id === input.bonus.bundleId && ["personal_unlimited", "home_wisp_unlimited"].includes(x.accessType) &&
      (x.status === "published" || (old && x.status === "archived")));
    if (!b) problem("Choose a bundle from the Unlimited catalogue.");
    bonus = validBonus({ bundleId: b.id, validityHours: b.validityHours, startsAt: "customer_start", givenAt: input.bonus.givenAt, startWithinDays: input.bonus.startWithinDays });
  } else {
    bonus = validBonus(input.bonus);
    if (bonus && existing?.bonus?.planId !== bonus.planId) problem("Choose a bundle from the Unlimited catalogue.");
    if (bonus && !plans.some((p) => p.id === bonus.planId)) problem("Choose a bundle from the catalogue.");
  }
  if (bonus === undefined) problem("Choose the free bundle, when it's given and how long the customer has to start it.");
  const next = {
    id: existing?.id || `promo-${randomUUID().slice(0, 8)}`, enabled: input.enabled === true, name, terms, productIds,
    salePrice: input.salePrice, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), perNumberLimit, bonus,
    units, showWas: input.showWas === true,
    ...(existing?.endedEarlyAt ? { endedEarlyAt: existing.endedEarlyAt } : {}),
    createdAt: existing?.createdAt || now.toISOString(), updatedAt: now.toISOString(), version: (existing?.version || 0) + 1,
  };
  // Changing what was sold is refused once orders exist at this price; they
  // keep their snapshot, but the figures would stop matching the offer.
  if (existing && promotionOrders(s, existing.id).length &&
      (existing.salePrice !== next.salePrice || JSON.stringify(validBonus(existing.bonus)) !== JSON.stringify(next.bonus)))
    problem("Orders were placed at this offer. End it and create a new one to change the price or the free bundle.");
  // Checked the same way the catalogue reads it, so overlaps are refused here.
  const others = (s.storeSettings?.promotions || []).filter((p) => p.id !== next.id);
  try { for (const id of next.productIds) activeStorePromotion([...others, next], id, new Date(Math.max(start, +now))); }
  catch (error) { problem(/Overlapping/.test(error.message) ? "Another offer covers one of these products at the same time." : "Check the promotion's details."); }
  for (const other of others.filter((o) => o.enabled && next.enabled && o.productIds?.some((id) => next.productIds.includes(id)))) {
    const a = utcTime(other.startsAt), b = utcTime(other.endedEarlyAt || other.endsAt);
    if (a < end && start < b) problem("Another offer covers one of these products at the same time.");
  }
  return next;
}

// Offers to announce: live now, or starting within `horizonMs` (the store and
// portal count down to the start). Only valid, enabled offers; a broken one
// is never announced.
export function promotionsToAnnounce(s, now, horizonMs = 14 * 864e5) {
  const at = +now, out = [];
  for (const p of s.storeSettings?.promotions || []) {
    const v = p && p.enabled === true ? validatedPromotion(p) : null;
    if (!v) continue;
    const start = utcTime(v.startsAt), end = utcTime(v.endedEarlyAt || v.endsAt);
    if (end <= at || start - at > horizonMs) continue;
    out.push({ ...v, status: start <= at ? "live" : "scheduled" });
  }
  return out.sort((a, b) => utcTime(a.startsAt) - utcTime(b.startsAt));
}

// draft, scheduled, live or ended: what the admin list shows.
export function promotionStatus(p, now) {
  if (!p.enabled) return "draft";
  const at = +now;
  if (p.endedEarlyAt && Date.parse(p.endedEarlyAt) <= at) return "ended";
  if (at < Date.parse(p.startsAt)) return "scheduled";
  return at < Date.parse(p.endsAt) ? "live" : "ended";
}
