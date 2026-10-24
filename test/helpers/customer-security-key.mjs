import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
export function securityKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = publicKey.export({ format: "jwk" });
  const cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]])));
  return { privateKey, cose, record: { id: randomBytes(32).toString("base64url"), publicKey: cose.toString("base64url"), counter: 0, transports: ["internal"], label: "Owner key", createdAt: new Date().toISOString() } };
}
export function securityAssertion(key, options, { origin = "http://customer.test", rpID = "customer.test", uv = true, counter = 1, registration = false } = {}) {
  const client = Buffer.from(JSON.stringify({ type: registration ? "webauthn.create" : "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
  const auth = Buffer.alloc(37); createHash("sha256").update(rpID).digest().copy(auth); auth[32] = 1 | (uv ? 4 : 0) | (registration ? 64 : 0); auth.writeUInt32BE(counter, 33);
  const base = { id: key.record.id, rawId: key.record.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform" };
  if (registration) {
    const id = Buffer.from(key.record.id, "base64url"), length = Buffer.alloc(2); length.writeUInt16BE(id.length);
    const data = Buffer.concat([auth, Buffer.alloc(16), length, id, key.cose]);
    return { ...base, response: { clientDataJSON: client.toString("base64url"), transports: ["internal"], attestationObject: Buffer.from(isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(data)]]))).toString("base64url") } };
  }
  return { ...base, response: { clientDataJSON: client.toString("base64url"), authenticatorData: auth.toString("base64url"), signature: sign("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), key.privateKey).toString("base64url"), userHandle: null } };
}
