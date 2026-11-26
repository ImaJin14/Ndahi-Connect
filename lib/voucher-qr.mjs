import {
  secureToken,
  safeEqual,
  hashSecret,
  normalizeActivationCode,
} from "./security.mjs";
import { profileCredentialVersion } from "./profile-proof.mjs";

const identityVersion = (voucher, customer) => hashSecret(JSON.stringify([voucher.id, customer.id, profileCredentialVersion(customer)]), "voucher-qr-version");

// This random locator identifies a voucher only. It never authenticates a customer.
export function voucherQrUrl(
  voucher,
  customer,
  origin,
  { rotate = false } = {},
) {
  const base = new URL(origin || "https://portal.ndahiconnect.net").origin;
  // A voucher reserved for a number opens its claim, the code filled in (#254).
  if (voucher.reservation?.status === "waiting" && voucher.status === "available" && !voucher.customerId)
    return `${base}/login?claim=${encodeURIComponent(voucher.code)}`;
  if (!customer || !voucher.customerId || voucher.status === "available")
    return `${base}/onboarding.html?action=connect&code=${encodeURIComponent(voucher.code)}`;
  const version = identityVersion(voucher, customer);
  if (
    rotate ||
    !voucher.qrConnectToken ||
    voucher.qrConnectVersion !== version
  ) {
    voucher.qrConnectToken = secureToken(32);
    voucher.qrConnectVersion = version;
  }
  return `${base}/voucher-connect.html?action=connect#qr=${encodeURIComponent(voucher.qrConnectToken)}`;
}
export const qrIdentityValid = (v, c) =>
  Boolean(
    v?.qrConnectToken &&
      c &&
      v.customerId === c.id &&
      v.qrConnectVersion === identityVersion(v, c),
  );
export function findQrVoucher(s, { qr, legacyCode } = {}) {
  if (/^[A-Za-z0-9_-]{32,128}$/.test(String(qr || "")))
    return s.vouchers.find((v) => safeEqual(v.qrConnectToken || "", qr));
  if (legacyCode) {
    const code = normalizeActivationCode(legacyCode);
    return s.vouchers.find((v) => safeEqual(v.code, code));
  }
  return null;
}
export function qrGrantTarget(input) {
  return JSON.stringify([
    String(input.mac || "").toUpperCase(),
    String(input.address || ""),
    String(input.key || ""),
  ]);
}
export function consumeQrGrant(
  s,
  token,
  customer,
  voucher,
  input,
  now,
  pepper,
  previousPepper = "",
) {
  const row = s.customerAccessChallenges.find(
    (ch) =>
      ch.type === "qr_connect_grant" &&
      !ch.used &&
      [pepper, previousPepper]
        .filter(Boolean)
        .some((key) =>
          safeEqual(ch.tokenHash, hashSecret(String(token || ""), key)),
        ),
  );
  if (!row) return null;
  row.used = true;
  // The QR checked is the one scanned; the bundle connected may be the same
  // account's current one when the scanned bundle has ended (#412).
  const scanned = row.scannedVoucherId
    ? s.vouchers.find((v) => v.id === row.scannedVoucherId && v.customerId === customer.id)
    : voucher;
  if (
    !scanned ||
    row.customerId !== customer.id ||
    row.voucherId !== voucher.id ||
    !(Date.parse(row.expiresAt) > +now) ||
    row.target !== qrGrantTarget(input) ||
    !qrIdentityValid(scanned, customer) ||
    !safeEqual(row.qrHash, hashSecret(scanned.qrConnectToken, pepper))
  )
    return null;
  return { qrHash: row.qrHash, qrVoucherId: scanned.id };
}
