export const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
export const validEmail = (value) => typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
// Existing linked addresses remain usable. New signup addresses need confirmation.
export const linkedEmail = (customer) => validEmail(customer?.email) &&
  (customer.emailVerificationRequired !== true || Boolean(customer.emailVerifiedAt)) ? customer.email : "";
