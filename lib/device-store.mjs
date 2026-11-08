import { storeReceipt } from "./store-receipt.mjs";
import { randomUUID, createHmac } from "node:crypto";
import { hashSecret, safeEqual } from "./security.mjs";
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
  };
  return s;
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
export function integer(value, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail("Enter a valid whole number.");
  return value;
}
export function image(value) {
  if (!value || typeof value !== "object") fail("Invalid image.");
  const data = text(value.data, 240000, true),
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
  return { data, alt: localized(value.alt || { en: "", fr: "" }, 180) };
}
export function productInput(s, input, old) {
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
  if (!Array.isArray(input.images) || input.images.length > 4)
    fail("Use at most four product images.");
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
    price: integer(input.price, 1),
    cost: integer(input.cost || 0),
    featured: input.featured === true,
    status: input.status,
    images: input.images.map(image),
  };
}
export function checkVersion(row, input) {
  if (row.version !== input.version)
    fail("This record changed. Reload before saving.", 409);
}
export function available(s, p, now) {
  const reserved = s.storeOrders
    .filter(
      (o) =>
        o.productId === p.id &&
        o.stockState === "reserved" &&
        Date.parse(o.expiresAt) > +now,
    )
    .reduce((sum, o) => sum + o.quantity, 0);
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
export function publicProduct(s, p, now) {
  const { cost, stock, ...safe } = p;
  return { ...safe, available: available(s, p, now) };
}
export function catalogue(s, now) {
  storeState(s);
  const categories = s.storeCategories
    .filter((c) => !c.hidden)
    .sort((a, b) => a.position - b.position);
  return {
    settings: s.storeSettings,
    categories,
    products: s.storeProducts
      .filter(
        (p) =>
          p.status === "published" &&
          (!p.categoryId || categories.some((c) => c.id === p.categoryId)),
      )
      .map((p) => publicProduct(s, p, now)),
  };
}
export function trackingToken(orderId, checkoutKey, secret) {
  return createHmac("sha256", secret)
    .update(`store:${orderId}:${checkoutKey}`)
    .digest("base64url");
}
export function canTrack(o, token, secret) {
  return (
    typeof token === "string" &&
    token.length >= 40 &&
    safeEqual(o.trackingHash, hashSecret(token, secret))
  );
}
export function orderView(o, { admin = false } = {}) {
  const p = o.payment;
  return {
    id: o.id,
    reference: o.reference,
    product: o.product,
    quantity: o.quantity,
    amount: p.amount,
    currency: "XAF",
    status: o.status,
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
  { now, secret, customerId, provider, clientIp },
) {
  storeState(s);
  expireReservations(s, now);
  const checkoutKey = text(input.checkoutKey, 100, true);
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(checkoutKey))
    fail("Use a fresh checkout key.");
  const quantity = integer(input.quantity, 1, 20),
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
      token: trackingToken(existing.id, checkoutKey, secret),
      replayed: true,
    };
  }
  if (!s.storeSettings.open || !s.storeSettings.pickup)
    fail("The store is not accepting orders yet.", 409);
  const product = s.storeProducts.find(
    (p) => p.id === input.productId && p.status === "published",
  );
  if (
    !product ||
    (product.categoryId &&
      !s.storeCategories.some((c) => c.id === product.categoryId && !c.hidden))
  )
    fail("Product unavailable.", 404);
  if (input.expectedPrice !== product.price)
    fail("The price changed. Reload the product before paying.", 409);
  if (available(s, product, now) < quantity)
    fail("Not enough stock is available.", 409);
  const id = randomUUID(),
    token = trackingToken(id, checkoutKey, secret),
    at = now.toISOString();
  const { cost, stock, images, ...snapshot } = product;
  snapshot.warranty = {
    en: product.warranty?.en || s.storeSettings.warranty.en,
    fr: product.warranty?.fr || s.storeSettings.warranty.fr,
  };
  const order = {
    id,
    reference: `NS-${id.slice(0, 8).toUpperCase()}`,
    version: 1,
    productId: product.id,
    product: structuredClone(snapshot),
    quantity,
    seller: { name: s.storeSettings.name, contact: s.storeSettings.contact },
    contact,
    customerId: customerId || null,
    fingerprint,
    checkoutKeyHash: keyHash,
    trackingHash: hashSecret(token, secret),
    collectionCode: randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase(),
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
      amount: product.price * quantity,
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
  if (verified.status === "paid") {
    p.status = "paid";
    p.confirmedAt = now.toISOString();
    o.receipt ??= storeReceipt(o);
    const product = s.storeProducts.find((x) => x.id === o.productId);
    if (o.stockState !== "reserved" || o.status === "cancelled" || !product) {
      p.review = "late_payment";
      o.status = "review";
      o.stockState = "released";
    } else {
      // This order's reservation already occupies its quantity.
      o.stockState = "consumed";
      movement(s, product, -o.quantity, "Paid order", "payment-provider", now);
      o.status = "preparing";
    }
  } else if (verified.status === "failed") {
    p.status = "failed";
    o.status = "cancelled";
    o.stockState = "released";
  } else if (verified.status !== "pending")
    fail("Unrecognized provider status.");
  o.version++;
}
