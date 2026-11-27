// Pairing codes (#407, owner 27 Nov): the owner's phone shows a 6-digit code
// (Devices → "Show a pairing code"); the new device types it to send its access
// request instead of the account's number and a voucher code. The code only
// names the account: the owner still compares the reference and approves on the
// main device. It lasts 10 minutes, is stored hashed, works once, and a wrong
// code counts against the address (5 in 15 minutes).
import { randomInt, randomUUID } from "node:crypto";
import { hashSecret, safeEqual } from "./security.mjs";

export const PAIRING_CODE_MS = 10 * 60_000;
const WINDOW_MS = 15 * 60_000, WRONG_LIMIT = 5;
export const normalizePairingCode = (value) => { const digits = String(value ?? "").replace(/\D/g, ""); return digits.length === 6 ? digits : null; };
const live = (c, now) => c.pairingCode && Date.parse(c.pairingCode.expiresAt) > +now;

// A new code for this customer, unique among the codes in use now.
export function issuePairingCode(s, customer, now, pepper) {
  const taken = new Set(s.customers.filter((c) => c.id !== customer.id && live(c, now)).map((c) => c.pairingCode.hash));
  let code, hash;
  do { code = String(randomInt(0, 1_000_000)).padStart(6, "0"); hash = hashSecret(code, pepper); } while (taken.has(hash));
  customer.pairingCode = { hash, createdAt: new Date(now).toISOString(), expiresAt: new Date(+now + PAIRING_CODE_MS).toISOString() };
  return { code, expiresAt: customer.pairingCode.expiresAt };
}
// The customer whose live code this is, or null.
export function customerForPairingCode(s, value, now, pepper, previousPepper) {
  const code = normalizePairingCode(value);
  if (!code) return null;
  return s.customers.find((c) => live(c, now) && [pepper, previousPepper].filter(Boolean).some((key) => safeEqual(c.pairingCode.hash, hashSecret(code, key)))) || null;
}
export function pairingCodeLocked(s, address, now) {
  return (s.rateLimitEvents || []).filter((e) => e.scope === "pairing_code" && e.ip === address && +now - Date.parse(e.at) < WINDOW_MS).length >= WRONG_LIMIT;
}
export function recordWrongPairingCode(s, address, now) {
  s.rateLimitEvents ??= [];
  s.rateLimitEvents.push({ id: randomUUID(), scope: "pairing_code", ip: address, at: new Date(now).toISOString() });
}
