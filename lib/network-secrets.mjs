import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(env) {
  const value = env.NETWORK_CONFIG_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw Error("Set NETWORK_CONFIG_KEY to a persistent 32-byte hexadecimal encryption key before saving network connections.");
  return Buffer.from(value, "hex");
}
export function seal(value, env) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(env), iv);
  cipher.setAAD(Buffer.from("ndahi-network-v1"));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}
export function unseal(value, env) {
  const cipher = createDecipheriv("aes-256-gcm", key(env), Buffer.from(value.iv, "base64"));
  cipher.setAAD(Buffer.from("ndahi-network-v1"));
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, "base64")), cipher.final()]).toString());
}

// Targets are deployment-approved origins, never arbitrary browser-supplied URLs.
export function allowedEndpoint(value, env) {
  let url;
  try { url = new URL(value); } catch { throw Error("Enter a valid HTTPS management URL."); }
  const allowed = String(env.NETWORK_ALLOWED_ORIGINS || "").split(",").map((v) => v.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !allowed.includes(url.origin)) {
    throw Error("Management URL must be an HTTPS origin listed in NETWORK_ALLOWED_ORIGINS on the server.");
  }
  return url.origin;
}
