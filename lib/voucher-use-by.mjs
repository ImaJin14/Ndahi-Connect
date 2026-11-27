// How long a code made in Admin can wait to be used (owner, 26 Nov 2026, on
// #344 and #368): batches and single vouchers made from now on can be used
// for 90 days, like reserved codes and gifts bought for someone. After that
// the code stops working. Codes made before carry no date and keep working.
// A code reserved for a number keeps its own claim window (reservations.mjs).
export const USE_BY_DAYS = 90;
const DAY = 864e5;

export const useByFrom = (at) => new Date(+new Date(at) + USE_BY_DAYS * DAY).toISOString();

// True when an unused code's use-by date has passed.
export const pastUseBy = (v, now) => v?.status === "available" && Boolean(v.useBy) && !(Date.parse(v.useBy) > +new Date(now));

// Expires one unused code whose date has passed. Returns true when it did.
export function expireUnusedCode(v, now) {
  if (!pastUseBy(v, now)) return false;
  v.status = "expired";
  v.expiredUnusedAt = new Date(now).toISOString();
  return true;
}

// Housekeeping: every unused code past its use-by date expires.
export function expireUnusedCodes(s, now) {
  const expired = [];
  for (const v of s.vouchers || []) if (expireUnusedCode(v, now)) expired.push(v.id);
  return expired;
}
