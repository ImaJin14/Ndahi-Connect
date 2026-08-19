import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const hashSecret = (value, pepper = "") =>
  createHash("sha256").update(`${pepper}:${value}`).digest("hex");
export const secureToken = (bytes = 32) =>
  randomBytes(bytes).toString("base64url");
export const VOUCHER_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const VOUCHER_PATTERN = /^NC-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;
export const activationCode = () => {
  let symbols = "";
  while (symbols.length < 8) {
    for (const byte of randomBytes(8 - symbols.length)) {
      if (byte < 248) symbols += VOUCHER_ALPHABET[byte % 31];
    }
  }
  return `NC-${symbols.slice(0, 4)}-${symbols.slice(4)}`;
};
export const normalizeActivationCode = (value) => {
  const compact = String(value || "").toUpperCase().replace(/[^0-9A-Z]/g, "")
    .replace(/^NC/, "");
  return compact.length === 8
    ? `NC-${compact.slice(0, 4)}-${compact.slice(4)}`
    : String(value || "").trim().toUpperCase();
};
export const otpCode = () =>
  String(Number.parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000)
    .padStart(6, "0");

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function totpSecret(bytes = 20) {
  const input = randomBytes(bytes);
  let bits = "", output = "";
  for (const byte of input) bits += byte.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) {
    output += BASE32[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

function decodeBase32(value) {
  let bits = "";
  for (const char of String(value).replace(/=+$/g, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Invalid TOTP secret");
    bits += index.toString(2).padStart(5, "0");
  }
  return Buffer.from(
    (bits.match(/.{8}/g) || []).map((byte) => Number.parseInt(byte, 2)),
  );
}

export function totpCode(secret, timestamp = Date.now(), period = 30) {
  const counter = Math.floor(timestamp / 1000 / period),
    buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(buffer)
      .digest(),
    offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)
    .padStart(6, "0");
}

export function verifyTotp(secret, code, timestamp = Date.now(), window = 1) {
  if (!secret || !/^\d{6}$/.test(String(code || ""))) return false;
  for (let step = -window; step <= window; step++) {
    if (safeEqual(totpCode(secret, timestamp + step * 30_000), code)) {
      return true;
    }
  }
  return false;
}

export const totpUri = (
  secret,
  account = "administrator",
  issuer = "NDAHI Connect",
) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${
    encodeURIComponent(account)
  }?secret=${secret}&issuer=${
    encodeURIComponent(issuer)
  }&algorithm=SHA1&digits=6&period=30`;

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyHmac(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  return safeEqual(
    createHmac("sha256", secret).update(rawBody).digest("hex"),
    String(signature).replace(/^sha256=/, ""),
  );
}
