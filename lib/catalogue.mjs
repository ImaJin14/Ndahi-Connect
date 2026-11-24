// The Unlimited bundle catalogue (#332; spec docs/redesign/specs/
// unlimited-catalog-and-device-locking.md §1, updated by the owner on 24 Nov:
// docs/redesign/decisions.md → "No fixed-data plans, no 60-device claim").
//
// - The catalogue lives in the database: Unlimited bundles are rows of the
//   existing `bundles` collection marked `catalogue: "unlimited"`, managed by
//   admins (lib/api/catalogue.mjs). Data is always unlimited.
// - Two access types: Personal Unlimited (a number of device slots) and Home
//   WISP Unlimited (one registered WISP router, household sharing on).
// - The starting catalogue is inserted once (SEED, under a marker), the first
//   time an admin manages the catalogue (always before the switch can turn it
//   on): a bundle an admin deleted or archived is never recreated.
// - A switch decides what is on sale (settings `catalogue.mode`):
//   "legacy" (the default) sells today's fixed-data plans exactly as before
//   and keeps Unlimited bundles off sale; "unlimited" sells only published
//   Unlimited bundles, and every fixed-data plan counts as archived. Nothing
//   is written to a fixed-data plan either way, so flipping back is a full
//   rollback (#337), and every bundle already bought keeps its own terms.
import { randomUUID } from "node:crypto";

export const SEED_MARKER = "unlimited-2026-11-24";
export const ACCESS_TYPES = Object.freeze(["personal_unlimited", "home_wisp_unlimited"]);
export const STATUSES = Object.freeze(["published", "unpublished", "archived"]);
const HOUR = 1, DAY = 24;
const MAX_HOURS = 365 * DAY;

// The owner's catalogue of 24 Nov (XAF). Personal Unlimited by validity and
// device count; five hours is offered for one device only. Home WISP has no
// device or router count in its name or terms.
const PERSONAL = [
  ["5h", 5, "hours", [250]],
  ["24h", 24, "hours", [500, 900, 1300, 1700, 2100, 2500]],
  ["7d", 7, "days", [2500, 4000, 5500, 7000, 8500, 10000]],
  ["30d", 30, "days", [6000, 10000, 15000, 20000, 25000, 30000]],
];
export const SEED = Object.freeze([
  ...PERSONAL.flatMap(([key, value, unit, prices], row) => prices.map((price, i) => ({
    id: `unlimited-${key}-${i + 1}`, name: "Personal Unlimited", price, validityValue: value, validityUnit: unit,
    accessType: "personal_unlimited", deviceSlots: i + 1, displayOrder: (row * 10 + i + 1) * 10,
  }))),
  { id: "home-wisp-30d", name: "Home WISP Unlimited", price: 50000, validityValue: 30, validityUnit: "days",
    accessType: "home_wisp_unlimited", deviceSlots: 1, displayOrder: 1000 },
].map((b) => Object.freeze(b)));

export const isUnlimitedBundle = (b) => b?.catalogue === "unlimited";
export const catalogueSettings = (s) => (s.catalogue && typeof s.catalogue === "object" ? s.catalogue : {});
export const catalogueMode = (s) => (catalogueSettings(s).mode === "unlimited" ? "unlimited" : "legacy");
const hoursOf = (value, unit) => value * (unit === "days" ? DAY : HOUR);

// The bundle as the rest of the system reads a plan: validityHours,
// deviceLimit and quotaGb (null: unlimited data) keep provisioning, receipts
// and quotes working unchanged.
function complete(b) {
  const home = b.accessType === "home_wisp_unlimited";
  return Object.assign(b, {
    catalogue: "unlimited", quotaGb: null, validityHours: hoursOf(b.validityValue, b.validityUnit),
    deviceSlots: home ? 1 : b.deviceSlots, deviceLimit: home ? 1 : b.deviceSlots, sharing: home,
  });
}

// Inserts the starting catalogue once. Returns the ids inserted (none after
// the first run). A seeded id that already exists, or that an admin deleted
// (the marker is then set), is never inserted again.
export function seedCatalogue(s, now = new Date()) {
  s.catalogue = { mode: "legacy", ...catalogueSettings(s) };
  s.catalogue.seeds ??= {};
  if (s.catalogue.seeds[SEED_MARKER]) return [];
  const at = new Date(now).toISOString(), inserted = [];
  for (const row of SEED) {
    if (s.bundles.some((b) => b.id === row.id)) continue;
    s.bundles.push(complete({ ...row, status: "published", version: 1, seed: SEED_MARKER, createdAt: at, updatedAt: at }));
    inserted.push(row.id);
  }
  s.catalogue.seeds[SEED_MARKER] = at;
  return inserted;
}

// Unlimited bundles on sale, in display order (used only in "unlimited" mode).
export function unlimitedOnSale(s) {
  return s.bundles.filter((b) => isUnlimitedBundle(b) && b.status === "published")
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.price - b.price || String(a.id).localeCompare(String(b.id)));
}

// The access terms a voucher carries from the bundle it was bought with
// (#333): what the network policy reads (#334 device slots, #335 sharing
// rule, #336 Home WISP). Nothing for a bundle outside the Unlimited
// catalogue, so every other voucher stays exactly as before.
export function accessTerms(plan) {
  if (!isUnlimitedBundle(plan)) return {};
  return { accessType: plan.accessType, deviceSlots: plan.deviceSlots, sharing: Boolean(plan.sharing) };
}

// What the server accepts for a bundle. Throws { status: 400 } with a
// message an admin can act on.
export function bundleInput(input, existing) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  const value = (key) => (input[key] === undefined && existing ? existing[key] : input[key]);
  const name = String(value("name") ?? "").trim();
  if (!name || name.length > 80) fail("Enter a bundle name (up to 80 characters).");
  const priceText = String(value("price") ?? "").trim();
  if (!/^[1-9]\d{0,8}$/.test(priceText)) fail("Enter the price in whole FCFA (1 to 999,999,999).");
  const accessType = value("accessType");
  if (!ACCESS_TYPES.includes(accessType)) fail("Choose Personal Unlimited or Home WISP Unlimited.");
  if (existing && accessType !== existing.accessType) fail("The access type can't change. Create a new bundle instead.");
  const validityUnit = value("validityUnit"), validityValue = Number(value("validityValue"));
  if (!["hours", "days"].includes(validityUnit) || !Number.isSafeInteger(validityValue) || validityValue < 1)
    fail("Enter the validity in whole hours or days.");
  const hours = hoursOf(validityValue, validityUnit);
  if (hours < 1 || hours > MAX_HOURS) fail("Validity must be between 1 hour and 365 days.");
  const home = accessType === "home_wisp_unlimited";
  const deviceSlots = home ? 1 : Number(value("deviceSlots"));
  if (!Number.isSafeInteger(deviceSlots) || deviceSlots < 1 || deviceSlots > 10) fail("Choose 1 to 10 device slots.");
  const displayOrder = value("displayOrder") === undefined ? undefined : Number(value("displayOrder"));
  if (displayOrder !== undefined && !Number.isSafeInteger(displayOrder)) fail("Enter a whole number for the display order.");
  return { name, price: Number(priceText), accessType, validityValue, validityUnit, deviceSlots, ...(displayOrder === undefined ? {} : { displayOrder }) };
}

export function newBundle(fields, now) {
  const at = new Date(now).toISOString();
  return complete({ id: `unlimited-${randomUUID().slice(0, 8)}`, status: "unpublished", version: 1, createdAt: at, updatedAt: at,
    displayOrder: fields.displayOrder ?? 0, ...fields });
}

export function applyBundleInput(b, fields, now) {
  Object.assign(b, fields, { updatedAt: new Date(now).toISOString(), version: (b.version || 0) + 1 });
  return complete(b);
}

// A bundle with any sale behind it is archived on delete, never removed:
// payments, vouchers, store orders (a promotion's free bundle) and
// promotions all keep pointing at it.
export function bundleInUse(s, id) {
  return s.payments.some((p) => p.planId === id) || s.vouchers.some((v) => v.planId === id) ||
    (s.storeOrders || []).some((o) => o.promotion?.bonus?.planId === id) ||
    (s.storeSettings?.promotions || []).some((p) => p.bonus?.planId === id);
}

// The admin's view of a catalogue row.
export function bundleView(b) {
  return {
    id: b.id, name: b.name, price: b.price, currency: "XAF", validityValue: b.validityValue, validityUnit: b.validityUnit,
    validityHours: b.validityHours, accessType: b.accessType, deviceSlots: b.accessType === "personal_unlimited" ? b.deviceSlots : null,
    sharing: Boolean(b.sharing), quotaGb: null, displayOrder: b.displayOrder ?? 0, status: b.status, version: b.version || 1,
    ...(b.downloadMbps || b.uploadMbps ? { downloadMbps: b.downloadMbps ?? null, uploadMbps: b.uploadMbps ?? null } : {}),
    seeded: b.seed === SEED_MARKER, createdAt: b.createdAt, updatedAt: b.updatedAt, ...(b.archivedAt ? { archivedAt: b.archivedAt } : {}),
  };
}
