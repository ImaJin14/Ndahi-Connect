import { createHmac } from "node:crypto";
import { hashSecret, safeEqual } from "./security.mjs";

export const matchingProtocol = 3;
export const matchingStatus = "awaiting_confirmation";
export const pairingRequestId = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value || "");
export const pairingReviewPath = id => pairingRequestId(id) ? "/pair-review.html?request=" + id : null;
const reference = (p, secret) => String(Number.parseInt(createHmac("sha256", secret).update(JSON.stringify(["wifi-request-reference-v3", p.id, p.referenceNonce])).digest("hex").slice(0, 8), 16) % 1000000).padStart(6, "0");
export function setPairingReference(p, nonce, secret) {
  p.referenceNonce = nonce;
  p.referenceHash = hashSecret(reference(p, secret), secret);
}
// A reference identifies one pending request. It is never a login/redemption
// credential. Old APIs cannot approve this protocol's distinct pending state.
export function pairingReference(p, secret, previous = "") {
  if (p.protocol !== matchingProtocol || p.status !== matchingStatus || !p.referenceNonce) return null;
  for (const key of [secret, previous].filter(Boolean)) {
    const value = reference(p, key);
    if (safeEqual(p.referenceHash || "", hashSecret(value, key))) return value;
  }
  return null;
}
