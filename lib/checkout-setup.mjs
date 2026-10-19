import { createHmac, randomUUID } from "node:crypto";
import { hashSecret, safeEqual } from "./security.mjs";
import { checkoutKeyActive, guestCheckoutDeadline } from "./billing.mjs";

export const checkoutSetupSeconds = 600;
export const checkoutSetupCookie = "checkout_setup";
export const checkoutSetupPath = "/api/account/setup";
const unavailable = () => ({ status: 404, body: { code: "SETUP_ACCESS_EXPIRED", error: "Checkout setup access is unavailable or expired. Sign in with your PIN or voucher, or contact support if money was deducted. Do not pay again to recover access." } });
const tokenFor = (p, secret) => createHmac("sha256", secret).update(JSON.stringify(["checkout-setup-v1", p.id, p.guestSetup.id])).digest("base64url");
function validToken(token, grant, secrets) {
  return typeof token === "string" && token.length > 0 && secrets.some((secret) => secret && safeEqual(hashSecret(token, secret), grant.tokenHash));
}
const ready = (s, p, now) => {
  const customer = p && s.customers.find((c) => c.id === p.customerId);
  const voucher = p && s.vouchers.find((v) => v.paymentId === p.id && v.customerId === p.customerId && ["active", "expired", "exhausted"].includes(v.status));
  return customer && !customer.pinHash && !customer.suspended && customer.status !== "suspended" && voucher && p.status === "paid" && p.fulfillmentStatus !== "needs_review" &&
    p.guestSetup && !p.guestSetup.usedAt && Date.parse(p.guestSetup.expiresAt) > +now ? { payment: p, customer, voucher } : null;
};
export function checkoutSetupFromCookie(s, value, now, secrets) {
  if (typeof value !== "string" || value.length > 180) return null;
  const [id, token, extra] = value.split(".");
  if (!id || !token || extra !== undefined) return null;
  const p = s.payments.find((p) => p.id === id), grant = p?.guestSetup;
  return grant && validToken(token, grant, secrets) ? ready(s, p, now) : null;
}
export function checkoutSetupView(p) {
  return { mode: "setup", paymentId: p.id, phone: p.guestCheckoutDetails?.phone || p.payerPhone, expiresAt: p.guestSetup.expiresAt };
}
// Retries reproduce the same opaque cookie without storing its plaintext or
// extending expiry. The old key is unusable for status/recovery after exchange;
// an idempotent exchange still requires it before the original request closes.
export function beginCheckoutSetup(s, input, now, secret, previousSecret = "") {
  if (!input || typeof input !== "object") return unavailable();
  const p = s.payments.find((p) => p.id === input.paymentId);
  if (!p || p.checkoutAudience === "account" || typeof input.requestKey !== "string" || input.requestKey.length < 32 ||
      !safeEqual(input.requestKey, p.requestKey) || !(+now < guestCheckoutDeadline(p)) || p.checkoutClosedAt || p.providerFailedAt || p.status !== "paid" || p.fulfillmentStatus === "needs_review") return unavailable();
  const customer = s.customers.find((c) => c.id === p.customerId);
  if (!customer || customer.suspended || customer.status === "suspended") return unavailable();
  if (customer.pinHash) { p.checkoutKeyRevokedAt ||= now.toISOString(); return { status: 200, body: { mode: "login" } }; }
  if (!s.vouchers.some((v) => v.paymentId === p.id && v.customerId === customer.id && ["active", "expired", "exhausted"].includes(v.status))) return unavailable();
  if (!p.guestSetup) {
    if (!checkoutKeyActive(p, customer, now)) return unavailable();
    p.guestSetup = { id: randomUUID(), createdAt: now.toISOString(), expiresAt: new Date(+now + checkoutSetupSeconds * 1000).toISOString() };
    p.guestSetup.tokenHash = hashSecret(tokenFor(p, secret), secret);
  }
  if (!ready(s, p, now)) return unavailable();
  const secrets = [secret, previousSecret], token = secrets.filter(Boolean).map((key) => tokenFor(p, key)).find((candidate) => validToken(candidate, p.guestSetup, secrets));
  if (!token) return unavailable();
  p.checkoutKeyRevokedAt ||= now.toISOString();
  return { status: 200, body: checkoutSetupView(p), cookie: `${p.id}.${token}`,
    maxAge: Math.max(0, Math.floor((Date.parse(p.guestSetup.expiresAt) - +now) / 1000)) };
}
