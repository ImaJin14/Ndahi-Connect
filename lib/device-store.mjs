import { storeReceipt } from "./store-receipt.mjs";
import { randomUUID, randomInt, createHmac, createHash } from "node:crypto";
import { hashSecret, safeEqual } from "./security.mjs";
import { chargedAmounts, feeNetworks, quotePayment, recordProviderCharge } from "./payment-fees.mjs";
import { promotionForProduct, promotionView, numberAlreadyUsed, promotionsToAnnounce } from "./store-promotions.mjs";
import { bonusView, bonusTerms } from "./store-promotion-bonus.mjs";
import { kitSale, publicKits } from "./store-kits.mjs";
import {
  normalizeCameroonPhone,
  validCameroonPhone,
} from "../shared-app/cameroon-phone.js";

export const storeCollections = [
  "storeProducts",
  "storeCategories",
  "storeOrders",
  "storeMovements",
  "storeOperations",
  "storeKits",
];
export function storeState(s) {
  for (const key of storeCollections) s[key] ||= [];
  s.storeSettings ||= {
    id: "store",
    version: 1,
    open: false,
    name: "NDAHI Store",
    introduction: {
      en: "Make room for better connections.",
      fr: "Faites place à de meilleures connexions.",
    },
    contact: "",
    pickup: "",
    hours: "",
    warranty: { en: "", fr: "" },
    returns: { en: "", fr: "" },
    banner: { en: "", fr: "" },
    readyHoldDays: 14,
  };
  return s;
}
// How long a ready order is held for its buyer (PhoneOrder, #406; owner 26
// Nov): "Held for you until <date>". Nothing happens when it passes.
export const DEFAULT_READY_HOLD_DAYS = 14;
export const readyHoldDays = (s) => (Number.isSafeInteger(s?.storeSettings?.readyHoldDays) ? s.storeSettings.readyHoldDays : DEFAULT_READY_HOLD_DAYS);
// Six digits, shown "739 204" (#406; owner 26 Nov), for new orders. Unique
// among orders still open, so the code staff type matches one order.
export function newCollectionCode(s) {
  const open = new Set(s.storeOrders.filter((o) => !["collected", "cancelled", "expired"].includes(o.status)).map((o) => o.collectionCode));
  for (let tries = 0; tries < 50; tries++) {
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    if (!open.has(code)) return code;
  }
  fail("Could not reserve a collection code. Try again.", 503);
}
export function fail(message, status = 400) {
  throw Object.assign(Error(message), { status });
}
export function text(value, max = 300, required = false) {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (required && !value.trim())
  )
    fail("Enter valid text within the field limit.");
  return value.trim();
}
export function localized(value, max = 300, required = false) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Provide English and French text.");
  return {
    en: text(value.en ?? "", max, required),
    fr: text(value.fr ?? "", max, required),
  };
}
// Key specs (ProductDesktop, #415; owner 26 Nov): up to 12 short label/value
// rows that fill the product page's spec table, e.g. "Band — 2.4 GHz". English
// is required for each row, French optional; blank rows are dropped.
export const MAX_KEY_SPECS = 12;
export function keySpecs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail("Enter valid key specs.");
  const rows = value
    .map((row) => ({ label: localized(row?.label || {}, 40), value: localized(row?.value || {}, 120) }))
    .filter((row) => row.label.en || row.label.fr || row.value.en || row.value.fr);
  if (rows.length > MAX_KEY_SPECS) fail(`Add up to ${MAX_KEY_SPECS} key specs.`);
  if (rows.some((row) => !row.label.en || !row.value.en)) fail("Give each key spec a label and a value in English.");
  return rows;
}
export function integer(value, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail("Enter a valid whole number.");
  return value;
}
// Product photos, up to 30 a product. Each photo is uploaded on its own and
// stored outside the state (store.photos), named by the SHA-256 of its bytes;
// a product keeps only { id, mime, bytes, alt }. So full-state reads never
// carry image data, and a photo's URL never changes. Photos saved inside the
// product before this ({ data, alt }, at most four) stay until removed.
export const MAX_PRODUCT_IMAGES = 30;
export const PHOTO_ID = /^[0-9a-f]{64}$/;
export const photoPath = (id) => `/api/store/photos/${id}`;
// What the admin and the shop see: a src for each photo (a path on the API,
// or an older photo's data URL), its alternative text, and for the admin, what
// to send back when saving.
export function photoView(image, { admin = false } = {}) {
  const alt = image.alt || { en: "", fr: "" };
  if (image.id) return { ...(admin ? { id: image.id } : {}), src: photoPath(image.id), alt };
  return { ...(admin ? { data: image.data } : {}), src: image.data, alt };
}
// An uploaded photo (a PNG, JPEG or WebP data URL under 175 KB), ready to store.
export function photoUpload(data) {
  const { mime, bytes } = decodeImage(data);
  return { id: createHash("sha256").update(bytes).digest("hex"), mime: `image/${mime}`, bytes: bytes.length, data: bytes.toString("base64") };
}
export function image(value) {
  if (!value || typeof value !== "object") fail("Invalid image.");
  const data = text(value.data, 240000, true);
  decodeImage(data);
  return { data, alt: localized(value.alt || { en: "", fr: "" }, 180) };
}
function decodeImage(value) {
  const data = text(value, 240000, true),
    match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      data,
    );
  if (!match) fail("Upload a PNG, JPEG or WebP image under 175 KB.");
  const bytes = Buffer.from(match[2], "base64");
  const valid =
    match[1] === "png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === "jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid || bytes.length > 175000 || bytes.toString("base64") !== match[2])
    fail("Invalid image contents.");
  return { mime: match[1], bytes };
}
// A product's photos as saved: each one already on the product, or uploaded
// (`stored`: the uploads' { id, mime, bytes } by id). An older inline photo can
// be kept, but not added.
function productImages(images, old, stored = new Map()) {
  if (!Array.isArray(images) || images.length > MAX_PRODUCT_IMAGES)
    fail(`Use at most ${MAX_PRODUCT_IMAGES} product photos.`);
  const before = new Map((old?.images || []).filter((p) => p.id).map((p) => [p.id, p])),
    inline = new Set((old?.images || []).filter((p) => p.data).map((p) => p.data));
  return images.map((value) => {
    if (!value || typeof value !== "object") fail("Invalid image.");
    const alt = localized(value.alt || { en: "", fr: "" }, 180);
    if (value.id !== undefined) {
      const photo = typeof value.id === "string" && PHOTO_ID.test(value.id) && (before.get(value.id) || stored.get(value.id));
      if (!photo) fail("A photo could not be found. Upload it again.");
      return { id: value.id, mime: photo.mime, bytes: photo.bytes, alt };
    }
    if (!inline.has(value.data)) fail("Upload each photo before saving the product.");
    return { data: value.data, alt };
  });
}
// The photo ids in a save that the product doesn't have yet (to look up).
export function newPhotoIds(images, old) {
  const have = new Set((old?.images || []).map((p) => p.id).filter(Boolean));
  return [...new Set((Array.isArray(images) ? images : []).slice(0, MAX_PRODUCT_IMAGES + 1)
    .map((p) => p?.id).filter((id) => typeof id === "string" && PHOTO_ID.test(id) && !have.has(id)))];
}
export function productInput(s, input, old, stored) {
  const categoryId = text(input.categoryId || "", 100);
  if (categoryId && !s.storeCategories.some((c) => c.id === categoryId))
    fail("Choose an existing category.");
  const sku = text(input.sku, 80, true);
  if (
    s.storeProducts.some(
      (p) => p.id !== old?.id && p.sku.toLowerCase() === sku.toLowerCase(),
    )
  )
    fail("This SKU already exists.", 409);
  if (!["draft", "published", "archived"].includes(input.status))
    fail("Choose a product status.");
  const images = productImages(input.images, old, stored);
  return {
    sku,
    categoryId,
    name: localized(input.name, 120, true),
    description: localized(input.description, 4000),
    specifications: localized(input.specifications, 3000),
    compatibility: localized(input.compatibility, 2000),
    contents: localized(input.contents, 2000),
    warranty: localized(input.warranty, 2000),
    setup: localized(input.setup, 4000),
    // The product page's "Needs" tile (PhoneProduct, #410; owner 26 Nov), e.g.
    // "Installation + alignment"; blank shows no tile. A save without the field
    // (the frozen v1 admin) keeps the saved one.
    ...(input.needs !== undefined || !old ? { needs: localized(input.needs || { en: "", fr: "" }, 60) } : {}),
    // A save without the field (the frozen v1 admin) keeps the saved rows.
    ...(input.keySpecs !== undefined || !old ? { keySpecs: keySpecs(input.keySpecs) } : {}),
    price: input.price === null ? null : integer(input.price, 1),
    cost: integer(input.cost || 0),
    featured: input.featured === true,
    status: input.status,
    images,
  };
}
export function checkVersion(row, input) {
  if (row.version !== input.version)
    fail("This record changed. Reload before saving.", 409);
}
// What an order takes from stock: its product, or each of a kit's (#424).
export const orderLines = (o) => o.lines || [{ productId: o.productId, quantity: o.quantity }];
export function available(s, p, now) {
  const reserved = s.storeOrders
    .filter((o) => o.stockState === "reserved" && Date.parse(o.expiresAt) > +now)
    .reduce((sum, o) => sum + orderLines(o).filter((line) => line.productId === p.id).reduce((n, line) => n + line.quantity, 0), 0);
  return Math.max(0, p.stock - reserved);
}
export function expireReservations(s, now) {
  storeState(s);
  for (const o of s.storeOrders)
    if (o.stockState === "reserved" && Date.parse(o.expiresAt) <= +now) {
      o.stockState = "released";
      if (o.payment.status === "pending") o.payment.status = "expired";
      o.status = "expired";
    }
}
// Each quantity a customer can choose has its own Mobile Money fee and total
// (#297), so the checkout never works one out: paymentQuotes.mtn[quantity - 1].
// A promotion (#302) sets the price and how many one number may buy; `plans`
// (the bundle catalogue) describes its free bundle.
export function publicProduct(s, p, now, feeRules = {}, plans = []) {
  const { cost, stock, ...rest } = p, count = available(s, p, now);
  // Photos as URLs: the catalogue stays small however many a product has.
  const safe = { ...rest, images: (p.images || []).map((image) => photoView(image)) };
  const { promotion, error } = promotionForProduct(s, p.id, now);
  // An offer that can't be read is never sold at the regular price by mistake.
  if (error) return { ...safe, available: 0, offerUnavailable: true };
  const price = promotion ? promotion.salePrice : p.price;
  const quantities = Math.max(1, Math.min(promotion ? promotion.perNumberLimit : 20, count));
  return { ...safe, price, available: count,
    ...(promotion ? { promotion: promotionView(promotion, p, plans.find((plan) => plan.id === promotion.bonus?.planId)) } : {}),
    ...(Number.isSafeInteger(price) ? { paymentQuotes: Object.fromEntries(feeNetworks.map((network) =>
      [network, Array.from({ length: quantities }, (_, i) => ({ quantity: i + 1, ...quotePayment(price * (i + 1), network, feeRules) }))])) } : {}) };
}
export function catalogue(s, now, feeRules = {}, plans = []) {
  storeState(s);
  const categories = s.storeCategories
    .filter((c) => !c.hidden)
    .sort((a, b) => a.position - b.position);
  // Promotions are set up in the admin; shoppers see each one on its products,
  // and the offers live or starting soon, to count down to (#302).
  const { promotions: _promotions, ...settings } = s.storeSettings;
  const published = new Set(s.storeProducts.filter((p) => p.status === "published").map((p) => p.id));
  return {
    // Countdowns run on the server's clock, not the browser's.
    serverTime: now.toISOString(),
    promotions: promotionsToAnnounce(s, now).map((p) => ({ ...promotionView(p, null, plans.find((plan) => plan.id === p.bonus?.planId)),
      status: p.status, productIds: p.productIds.filter((id) => published.has(id)) })).filter((p) => p.productIds.length),
    settings,
    categories,
    products: s.storeProducts
      .filter(
        (p) =>
          p.status === "published" &&
          (!p.categoryId || categories.some((c) => c.id === p.categoryId)),
      )
      .map((p) => publicProduct(s, p, now, feeRules, plans)),
    // Kits on sale (#424), each with its saving only when real.
    kits: publicKits(s, now, feeRules),
  };
}
export function trackingToken(orderId, checkoutKey, secret) {
  return createHmac("sha256", secret)
    .update(`store:${orderId}:${checkoutKey}`)
    .digest("base64url");
}
// The private link's token. New orders (#401) derive it from the stored
// checkout-key hash, so the server can rebuild it for emails and the short
// /o/<token> link; older orders used the checkout key itself, which only the
// buyer holds, and keep the link they were given.
export function orderLinkToken(o, secret) {
  const token = trackingToken(o.id, o.checkoutKeyHash, secret);
  return canTrack(o, token, secret) ? token : null;
}
// A guest order's short private link for emails: <store>/o/<token>, or null
// when the server can't rebuild the token (older or rotated links).
export function storeOrderLink(o, secret, storeUrl = "http://localhost:8083") {
  const token = !o.customerId && orderLinkToken(o, secret);
  return token ? `${String(storeUrl).replace(/\/$/, "")}/o/${token}` : null;
}
// The order a private link opens, from its token alone (the short link, #401).
export function trackedOrder(orders, token, secret) {
  if (typeof token !== "string" || token.length < 40) return null;
  const hash = hashSecret(token, secret);
  return orders.find((o) => typeof o.trackingHash === "string" && safeEqual(o.trackingHash, hash)) || null;
}
export function canTrack(o, token, secret) {
  return (
    typeof token === "string" &&
    token.length >= 40 &&
    safeEqual(o.trackingHash, hashSecret(token, secret))
  );
}
export function orderView(o, { admin = false, holdDays = DEFAULT_READY_HOLD_DAYS } = {}) {
  const p = o.payment;
  // When each step happened (#406): paid, made ready (prepared and tested), collected.
  const when = (action) => [...(o.history || [])].reverse().find((h) => h.action === action)?.at || null;
  const readyAt = ["ready", "collected"].includes(o.status) ? when("ready") : null;
  return {
    id: o.id,
    reference: o.reference,
    product: o.product,
    quantity: o.quantity,
    // A kit (#424): what it holds as sold, its Set up step and its first bundle.
    ...(o.kit ? { kit: { id: o.kit.id, name: o.kit.name, items: o.kit.items, setUp: o.kit.setUp,
      firstBundle: { id: o.kit.firstBundle.id, name: o.kit.firstBundle.name, accessType: o.kit.firstBundle.accessType, validityHours: o.kit.firstBundle.validityHours,
        deviceSlots: o.kit.firstBundle.accessType === "personal_unlimited" ? o.kit.firstBundle.deviceSlots : null } },
      setup: o.setup ? { status: o.setup.status, doneAt: o.setup.doneAt || null } : null, kitBundle: o.kitBundle || null } : {}),
    // The offer the order was placed at and its free bundle (#302).
    ...(o.promotion ? { promotion: { id: o.promotion.id, name: o.promotion.name, salePrice: o.promotion.salePrice, terms: o.promotion.terms },
      bonus: bonusView(o) } : {}),
    // amount is the price; fee and total are what the customer approves (#297).
    amount: p.amount,
    ...chargedAmounts(p),
    network: p.network || null,
    currency: "XAF",
    status: o.status,
    progress: { paidAt: p.confirmedAt || null, readyAt, collectedAt: o.status === "collected" ? when("collect") : null },
    holdUntil: o.status === "ready" && readyAt ? new Date(Date.parse(readyAt) + holdDays * 86400000).toISOString() : null,
    paymentStatus: p.status,
    paymentReview: p.review || null,
    refundStatus: p.refund?.status || null,
    receiptAvailable: Boolean(p.confirmedAt),
    receiptNumber: p.confirmedAt ? storeReceipt(o).number : null,
    expiresAt: o.expiresAt,
    createdAt: o.createdAt,
    pickup: o.pickup,
    returns: o.returns,
    hours: o.hours,
    collectionCode:
      p.status === "paid" &&
      !["review", "cancelled"].includes(o.status)
        ? o.collectionCode
        : undefined,
    serialNumbers: o.serialNumbers || "",
    ...(admin
      ? {
          version: o.version,
          contact: o.contact,
          customerId: o.customerId,
          stockState: o.stockState,
          notes: o.notes || "",
          returnStatus: o.returnStatus || "none",
          payment: {
            id: p.id,
            provider: p.provider,
            status: p.status,
            review: p.review,
            refund: p.refund,
            providerReference: p.providerReference,
          },
          history: o.history || [],
        }
      : {}),
  };
}
export function reserveOrder(
  s,
  input,
  { now, secret, customerId, provider, clientIp, feeRules = {}, plans = [] },
) {
  storeState(s);
  expireReservations(s, now);
  const checkoutKey = text(input.checkoutKey, 100, true);
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(checkoutKey))
    fail("Use a fresh checkout key.");
  // A kit (#424) is bought one at a time; its products come with it.
  const kit = input.kitId !== undefined;
  const quantity = kit ? 1 : integer(input.quantity, 1, 20),
    contact = {
      name: text(input.name, 120, true),
      phone: normalizeCameroonPhone(input.phone),
      email: text(input.email || "", 254),
    },
    payerPhone = normalizeCameroonPhone(input.payerPhone);
  if (!validCameroonPhone(contact.phone) || !validCameroonPhone(payerPhone))
    fail("Enter valid Cameroon contact and payment numbers.");
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email))
    fail("Enter a valid email.");
  if (!["mtn", "orange"].includes(input.network))
    fail("Choose MTN or Orange Money.");
  const fingerprint = hashSecret(
    JSON.stringify([
      input.productId,
      quantity,
      contact,
      payerPhone,
      input.network,
      customerId || null,
      provider,
      ...(kit ? [String(input.kitId)] : []),
    ]),
    secret,
  );
  const keyHash = hashSecret(checkoutKey, secret),
    existing = s.storeOrders.find((o) => o.checkoutKeyHash === keyHash);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      fail("This checkout key was already used for another purchase.", 409);
    return {
      order: existing,
      token: [trackingToken(existing.id, keyHash, secret), trackingToken(existing.id, checkoutKey, secret)]
        .find((token) => canTrack(existing, token, secret)),
      replayed: true,
    };
  }
  if (!s.storeSettings.open || !s.storeSettings.pickup)
    fail("The store is not accepting orders yet.", 409);
  if (kit) return reserveKitOrder(s, input, { now, secret, customerId, provider, clientIp, feeRules, checkoutKey, keyHash, fingerprint, contact, payerPhone });
  const product = s.storeProducts.find(
    (p) => p.id === input.productId && p.status === "published",
  );
  if (
    !product ||
    (product.categoryId &&
      !s.storeCategories.some((c) => c.id === product.categoryId && !c.hidden))
  )
    fail("Product unavailable.", 404);
  // A promotion (#302) sets the price and limits each phone number. The
  // checkout runs in one store transaction, so the stock and per-number
  // checks hold when buyers check out at the same time.
  const { promotion, error: offerError } = promotionForProduct(s, product.id, now);
  if (offerError) fail("This offer is being updated. Try again in a few minutes.", 409);
  const unitPrice = promotion ? promotion.salePrice : product.price;
  if (!Number.isSafeInteger(unitPrice) || unitPrice < 1)
    fail("Price is not confirmed. This product cannot be purchased yet.", 409);
  if (input.expectedPrice !== unitPrice)
    fail("The price changed. Reload the product before paying.", 409);
  if (promotion) {
    if (quantity > promotion.perNumberLimit)
      fail(promotion.perNumberLimit === 1 ? "The offer is limited to one per phone number." : `The offer is limited to ${promotion.perNumberLimit} per phone number.`, 409);
    if (numberAlreadyUsed(s, promotion, { payerPhone, contactPhone: contact.phone, customerId }))
      fail("This phone number already has an order at the offer price.", 409);
  }
  if (available(s, product, now) < quantity)
    fail("Not enough stock is available.", 409);
  const id = randomUUID(),
    token = trackingToken(id, keyHash, secret),
    at = now.toISOString();
  const { cost, stock, images, ...snapshot } = product;
  snapshot.warranty = {
    en: product.warranty?.en || s.storeSettings.warranty.en,
    fr: product.warranty?.fr || s.storeSettings.warranty.fr,
  };
  // The fee and total shown at checkout; `amount` stays the price sent to the provider.
  const quote = quotePayment(unitPrice * quantity, input.network, provider === "flutterwave" ? {} : feeRules);
  const order = {
    id,
    reference: `NS-${id.slice(0, 8).toUpperCase()}`,
    version: 1,
    productId: product.id,
    product: structuredClone(snapshot),
    quantity,
    unitPrice,
    // The offer as it stood: later edits to the promotion never change it.
    // The free bundle's plan is copied too: it is given at collection, and
    // catalogue changes in between never change what was sold (#423).
    ...(promotion ? { promotion: { id: promotion.id, name: promotion.name, terms: promotion.terms, salePrice: promotion.salePrice,
      bonus: promotion.bonus && bonusTerms(promotion.bonus, plans.find((plan) => plan.id === promotion.bonus.planId)),
      endsAt: promotion.endedEarlyAt || promotion.endsAt } } : {}),
    seller: { name: s.storeSettings.name, contact: s.storeSettings.contact },
    contact,
    customerId: customerId || null,
    fingerprint,
    checkoutKeyHash: keyHash,
    trackingHash: hashSecret(token, secret),
    collectionCode: newCollectionCode(s),
    pickup: s.storeSettings.pickup,
    hours: s.storeSettings.hours,
    returns: structuredClone(s.storeSettings.returns),
    createdAt: at,
    expiresAt: new Date(+now + 10 * 60000).toISOString(),
    status: "awaiting_payment",
    stockState: "reserved",
    history: [],
    payment: {
      id: `store-${id}`,
      provider,
      amount: unitPrice * quantity,
      fee: quote.fee,
      total: quote.total,
      currency: "XAF",
      payerPhone,
      network: input.network,
      email: contact.email || undefined,
      customerName: contact.name,
      clientIp,
      status: "pending",
      creationState: "reserved",
      createdAt: at,
    },
  };
  s.storeOrders.unshift(order);
  return { order, token, replayed: false };
}
// A kit order (#424): the kit at its price, each product reserved, and a copy
// of what was sold. The rest is an ordinary store order.
function reserveKitOrder(s, input, { now, secret, customerId, provider, clientIp, feeRules, checkoutKey, keyHash, fingerprint, contact, payerPhone }) {
  const sale = kitSale(s, input, { customerId, now, settings: s.storeSettings });
  const id = randomUUID(), token = trackingToken(id, keyHash, secret), at = now.toISOString();
  const quote = quotePayment(sale.unitPrice, input.network, provider === "flutterwave" ? {} : feeRules);
  const order = {
    id, reference: `NS-${id.slice(0, 8).toUpperCase()}`, version: 1,
    productId: null, ...sale, quantity: 1,
    seller: { name: s.storeSettings.name, contact: s.storeSettings.contact },
    contact, customerId, fingerprint, checkoutKeyHash: keyHash, trackingHash: hashSecret(token, secret), collectionCode: newCollectionCode(s),
    pickup: s.storeSettings.pickup, hours: s.storeSettings.hours, returns: structuredClone(s.storeSettings.returns),
    createdAt: at, expiresAt: new Date(+now + 10 * 60000).toISOString(), status: "awaiting_payment", stockState: "reserved", history: [],
    payment: { id: `store-${id}`, provider, amount: sale.unitPrice, fee: quote.fee, total: quote.total, currency: "XAF", payerPhone, network: input.network,
      email: contact.email || undefined, customerName: contact.name, clientIp, status: "pending", creationState: "reserved", createdAt: at },
  };
  s.storeOrders.unshift(order);
  return { order, token, replayed: false };
}
export function movement(s, p, delta, reason, actor, now, operationKey) {
  if (!Number.isSafeInteger(delta))
    fail("Enter a whole-number stock adjustment.");
  integer(Math.abs(delta), 1, 1000000);
  const reserved = p.stock - available(s, p, now);
  if (p.stock + delta < reserved || p.stock + delta < 0)
    fail("Stock cannot fall below reserved quantities.", 409);
  p.stock += delta;
  p.version++;
  p.updatedAt = now.toISOString();
  s.storeMovements.unshift({
    id: randomUUID(),
    productId: p.id,
    delta,
    balance: p.stock,
    reason,
    actor,
    at: now.toISOString(),
    operationKey,
  });
}
// Change payment (PhoneCheckout, #397; owner 26 Nov): the customer cancels an
// order whose payment isn't confirmed, so its device goes back into stock and
// they can send a fresh request. The provider is still checked afterwards: a
// payment approved anyway goes to review for a refund (settleOrder), as a late
// payment on an expired order does. Cancelling again changes nothing, and a
// paid order stays as it is (the screen then shows it placed).
export function cancelUnpaidOrder(o, now) {
  if (o.payment.confirmedAt || o.payment.status === "paid") return { cancelled: false };
  if (["cancelled", "expired"].includes(o.status)) return { cancelled: false };
  if (o.status !== "awaiting_payment") fail("This order can no longer be changed.", 409);
  o.status = "cancelled";
  if (o.stockState === "reserved") o.stockState = "released";
  (o.history ||= []).push({ action: "payment_changed", actor: "customer", at: now.toISOString() });
  o.version++;
  return { cancelled: true };
}
export function settleOrder(s, o, verified, now) {
  storeState(s);
  expireReservations(s, now);
  const p = o.payment;
  if (p.confirmedAt || p.refund) return;
  if (
    verified.transactionReference !== p.id ||
    Number(verified.amount) !== p.amount ||
    verified.currency !== p.currency ||
    !verified.providerReference ||
    (p.providerReference &&
      String(p.providerReference) !== String(verified.providerReference))
  )
    fail("Provider payment details do not match.", 409);
  if (
    s.storeOrders.some(
      (other) =>
        other.id !== o.id &&
        other.payment.provider === p.provider &&
        String(other.payment.providerReference) ===
          String(verified.providerReference),
    )
  )
    fail("Duplicate provider reference.", 409);
  p.providerReference = String(verified.providerReference);
  // Before the receipt is frozen, so it carries the fee actually charged.
  const feeMismatch = recordProviderCharge(p, verified);
  if (verified.status === "paid") {
    p.status = "paid";
    p.confirmedAt = now.toISOString();
    o.receipt ??= storeReceipt(o);
    const lines = orderLines(o).map((line) => ({ ...line, product: s.storeProducts.find((x) => x.id === line.productId) }));
    if (o.stockState !== "reserved" || o.status === "cancelled" || lines.some((line) => !line.product)) {
      p.review = "late_payment";
      o.status = "review";
      o.stockState = "released";
    } else {
      // This order's reservation already occupies its quantity.
      o.stockState = "consumed";
      for (const line of lines) movement(s, line.product, -line.quantity, o.kit ? "Paid kit order" : "Paid order", "payment-provider", now);
      o.status = "preparing";
    }
  } else if (verified.status === "failed") {
    p.status = "failed";
    o.status = "cancelled";
    o.stockState = "released";
  } else if (verified.status !== "pending")
    fail("Unrecognized provider status.");
  o.version++;
  return feeMismatch ? { feeMismatch } : undefined;
}
