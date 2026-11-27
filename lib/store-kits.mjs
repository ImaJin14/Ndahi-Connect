// Kits (#424; decisions.md → "Kits, installations and payment plans (23 Nov)";
// canvas AdminStoreServices → Kits, PhoneStarterKit). A kit sells store
// products with a first bundle from the Unlimited catalogue at one price:
// - The server prices everything. "Bought separately" and the saving come
//   from the current product and bundle prices, and the saving is shown only
//   when it is real.
// - A kit order reserves and takes stock from each of its products, and keeps
//   an immutable copy of what was sold (products, first bundle, price).
// - The first bundle is given when the kit is collected, never at payment,
//   unstarted: Home WISP waits for the buyer's router and starts on its first
//   connection (#336, #351); Personal Unlimited waits until the buyer uses it.
// - "Set up for the buyer's account" adds a Set up step: staff prepare the
//   router at the shop, and the order can't be made ready until they have.
//   The buyer registers it with the existing Home router flow (#351).
// - Installation and Pay in 3 are kit options now; checkout offers them once
//   #425 and #426 build them (batch 19).
// - Kits are sold to signed-in accounts (PhoneStarterKit: "set up for your
//   NDAHI account").
import { randomUUID } from "node:crypto";
import { fail, text, localized, integer, available, storeState, photoView } from "./device-store.mjs";
import { isUnlimitedBundle, accessTerms } from "./catalogue.mjs";
import { quotePayment } from "./payment-fees.mjs";

export const KIT_STATUSES = Object.freeze(["draft", "on_sale", "archived"]);
export const MAX_KIT_ITEMS = 6;
const ZONE = "Africa/Douala";
const month = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: ZONE }).slice(0, 7);
const productOf = (s, id) => s.storeProducts.find((p) => p.id === id);
export const kitBundle = (s, id) => (s.bundles || []).find((b) => b.id === id && isUnlimitedBundle(b)) || null;

// What the admin saves; the status changes on its own action.
export function kitInput(s, input) {
  storeState(s);
  const name = localized(input.name, 120, true), description = localized(input.description || { en: "", fr: "" }, 600);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_KIT_ITEMS) fail(`Choose between 1 and ${MAX_KIT_ITEMS} products.`);
  const items = input.items.map((item) => {
    const productId = text(item?.productId, 100, true), product = productOf(s, productId);
    if (!product || product.status === "archived") fail("Choose products from the store.");
    return { productId, quantity: integer(item.quantity, 1, 10) };
  });
  if (new Set(items.map((item) => item.productId)).size !== items.length) fail("List each product once, with its quantity.");
  const firstBundleId = text(input.firstBundleId, 100, true), bundle = kitBundle(s, firstBundleId);
  if (!bundle || bundle.status === "archived") fail("Choose a first bundle from the catalogue.");
  const setUp = input.setUp === true;
  if (setUp && bundle.accessType !== "home_wisp_unlimited") fail("Set up for the buyer's account needs a Home WISP Unlimited first bundle.");
  return { name, description, items, firstBundleId, price: integer(input.price, 1), setUp, installation: input.installation === true, payIn3: input.payIn3 === true };
}

// On sale and buyable: every product published with a price, the bundle published.
export function kitBuyable(s, k) {
  return k.status === "on_sale" && kitBundle(s, k.firstBundleId)?.status === "published" &&
    k.items.every((item) => { const p = productOf(s, item.productId); return p && p.status === "published" && Number.isSafeInteger(p.price) && p.price > 0; });
}
export function kitStatusChange(s, k, status) {
  if (!KIT_STATUSES.includes(status)) fail("Choose a kit status.");
  if (status === "on_sale" && !kitBuyable(s, { ...k, status })) fail("Put a kit on sale once its products are published with prices and its first bundle is published.", 409);
  return status;
}

// "Bought separately" (products at their prices, plus the first bundle) and
// the saving, only when real; how many kits the stock allows.
export function kitFigures(s, k, now) {
  const bundle = kitBundle(s, k.firstBundleId);
  const parts = k.items.map((item) => { const p = productOf(s, item.productId); return p && Number.isSafeInteger(p.price) ? p.price * item.quantity : null; });
  const separately = parts.every((n) => n !== null) && Number.isSafeInteger(bundle?.price) ? parts.reduce((sum, n) => sum + n, 0) + bundle.price : null;
  const saving = separately !== null && separately > k.price ? separately - k.price : null;
  const stock = Math.min(...k.items.map((item) => { const p = productOf(s, item.productId); return p ? Math.floor(available(s, p, now) / item.quantity) : 0; }));
  return { boughtSeparately: separately, saving, available: Math.max(0, stock) };
}
// Paid, unrefunded kit orders this month (Douala time), for the admin list.
export function kitsSoldThisMonth(s, k, now) {
  const current = month(now);
  return s.storeOrders.filter((o) => o.kitId === k.id && o.payment.confirmedAt && !o.payment.refund && month(o.payment.confirmedAt) === current).length;
}
// The first bundle as the kit describes it.
export function bundleSummary(b) {
  return b ? { id: b.id, name: b.name, price: b.price, accessType: b.accessType, validityHours: b.validityHours, validityValue: b.validityValue,
    validityUnit: b.validityUnit, deviceSlots: b.accessType === "personal_unlimited" ? b.deviceSlots : null, status: b.status } : null;
}
function itemsView(s, k) {
  return k.items.map((item) => { const p = productOf(s, item.productId);
    return { productId: item.productId, quantity: item.quantity, name: p?.name || null, sku: p?.sku || null, price: p?.price ?? null, status: p?.status || "missing",
      image: p?.images?.[0] ? photoView(p.images[0]) : null }; });
}
export function adminKitView(s, k, now) {
  return { ...k, items: itemsView(s, k), firstBundle: bundleSummary(kitBundle(s, k.firstBundleId)), ...kitFigures(s, k, now),
    buyable: kitBuyable(s, k), soldThisMonth: kitsSoldThisMonth(s, k, now) };
}
// The shop's kits: on sale and buyable; the saving only when real; each
// network's fee and total for the kit price (#297).
export function publicKits(s, now, feeRules = {}) {
  storeState(s);
  return s.storeKits.filter((k) => kitBuyable(s, k)).map((k) => {
    const figures = kitFigures(s, k, now);
    return { id: k.id, name: k.name, description: k.description, price: k.price, currency: "XAF", items: itemsView(s, k).map(({ status, ...item }) => item),
      firstBundle: bundleSummary(kitBundle(s, k.firstBundleId)), setUp: k.setUp, installation: k.installation, payIn3: k.payIn3,
      available: figures.available, ...(figures.saving ? { boughtSeparately: figures.boughtSeparately, saving: figures.saving } : {}),
      paymentQuotes: Object.fromEntries(["mtn", "orange"].map((network) => [network, quotePayment(k.price, network, feeRules)])), version: k.version };
  });
}

// What a kit checkout sells, checked and copied (reserveOrder calls this).
export function kitSale(s, input, { customerId, now, settings }) {
  if (!customerId) fail("Sign in to buy a kit; it's set up for your account.", 401);
  if (input.quantity !== undefined && input.quantity !== 1) fail("Kits are sold one at a time.");
  if (input.installation === true || input.payIn3 === true) fail("Installation and Pay in 3 aren't available yet. Choose to plug it in yourself and pay in full.", 409);
  const k = (s.storeKits || []).find((x) => x.id === input.kitId);
  if (!k || !kitBuyable(s, k)) fail("Kit unavailable.", 404);
  if (input.expectedPrice !== k.price) fail("The price changed. Reload the kit before paying.", 409);
  for (const item of k.items) if (available(s, productOf(s, item.productId), now) < item.quantity) fail("Not enough stock is available.", 409);
  const bundle = kitBundle(s, k.firstBundleId);
  const { cost: _cost, stock: _stock, images: _images, ...firstBundle } = structuredClone(bundle);
  return {
    kitId: k.id,
    lines: k.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
    kit: { id: k.id, version: k.version, name: k.name, description: k.description, price: k.price, setUp: k.setUp,
      items: k.items.map((item) => { const p = productOf(s, item.productId); return { productId: p.id, sku: p.sku, name: structuredClone(p.name), quantity: item.quantity, unitPrice: p.price }; }),
      // The first bundle as sold: catalogue changes before collection never change it.
      firstBundle },
    // The receipt and order pages read one line: the kit at its price.
    product: { id: k.id, sku: `KIT-${k.id.slice(0, 8).toUpperCase()}`, name: structuredClone(k.name), price: k.price,
      warranty: { en: settings.warranty.en, fr: settings.warranty.fr }, kit: true },
    unitPrice: k.price,
    ...(k.setUp ? { setup: { status: "pending" } } : {}),
  };
}

// The first bundle, given at collection, unstarted, in the buyer's account.
export function issueKitBundle(s, o, now, code) {
  if (!o.kit || o.kitBundle || o.payment.status !== "paid" || o.status !== "collected" || !o.customerId) return o.kitBundle || null;
  const plan = o.kit.firstBundle, at = now.toISOString();
  const v = {
    id: randomUUID(), customerId: o.customerId, planId: plan.id, code: code(s), status: "available", activatedAt: null, expiresAt: null,
    quotaBytes: null, usedBytes: 0, deviceLimit: plan.deviceLimit, ...accessTerms(plan),
    ...(plan.accessType === "home_wisp_unlimited" ? { startsOnFirstConnection: true, validityHours: plan.validityHours } : {}),
    // The bundle's terms as sold with the kit (the voucher's plan from now on).
    customTerms: structuredClone(plan),
    // Part of the kit's sale: the kit order carries the revenue, so the bundle has no sale amount.
    saleType: "gift", faceValue: plan.price ?? null, givenAt: at, createdAt: at,
    kit: { orderId: o.id, reference: o.reference, kitId: o.kitId },
    emailStatus: "not_applicable", emailAttempts: 5,
  };
  s.vouchers.unshift(v);
  o.kitBundle = { status: "given", voucherId: v.id, givenAt: at };
  return o.kitBundle;
}
// A refund after collection takes back a first bundle not yet started.
export function withdrawKitBundle(s, o, now) {
  const v = o.kitBundle && s.vouchers.find((x) => x.id === o.kitBundle.voucherId);
  if (!v || v.status !== "available") return;
  v.status = "revoked"; v.revokedAt = now.toISOString();
  o.kitBundle.status = "withdrawn";
}
export const newKitId = () => `kit-${randomUUID().slice(0, 8)}`;
