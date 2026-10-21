import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import argon2 from "argon2";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";

const secret = "pairing-tests", origin = "http://customer.test", rpID = "customer.test";
const password = "Current administrator password 82!", newPassword = "New staff member password 82!";
const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const sha = value => createHash("sha256").update(value).digest();
const profile = "/api/admin/profile", roles = ["owner", "operator", "reseller", "auditor"];

function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = publicKey.export({ format: "jwk" });
  const publicCose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]]));
  const idBytes = randomBytes(32), id = idBytes.toString("base64url"); let counter = 0;
  const key = { id, publicKey: Buffer.from(publicCose).toString("base64url"), counter: 0, transports: ["internal"], createdAt: "2029-01-01T00:00:00Z" };
  const client = (options, type) => Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false }));
  return { key,
    assertion(options, { flags = 5 } = {}) {
      const data = client(options, "webauthn.get"), count = Buffer.alloc(4); count.writeUInt32BE(++counter);
      const authData = Buffer.concat([sha(rpID), Buffer.from([flags]), count]);
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: {
        clientDataJSON: data.toString("base64url"), authenticatorData: authData.toString("base64url"),
        signature: sign("sha256", Buffer.concat([authData, sha(data)]), privateKey).toString("base64url"), userHandle: null,
      } };
    },
    registration(options, { flags = 0x45 } = {}) {
      const length = Buffer.alloc(2); length.writeUInt16BE(idBytes.length);
      const authData = Buffer.concat([sha(rpID), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), length, idBytes, Buffer.from(publicCose)]);
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: {
        clientDataJSON: client(options, "webauthn.create").toString("base64url"), transports: ["internal"],
        attestationObject: Buffer.from(isoCBOR.encode(new Map([["fmt", "none"], ["authData", new Uint8Array(authData)], ["attStmt", new Map()]]))).toString("base64url"),
      } };
    },
  };
}

async function fixture(t, { retired = true } = {}) {
  const f = await pairingFixture({ env: { ADMIN_APP_URL: origin, ALLOWED_ADMIN_ORIGINS: origin, ADMIN_SESSION_SECRET: secret,
    WEBAUTHN_RP_ID: rpID, ADMIN_MFA_ENABLED: "true", ADMIN_MFA_CODE: "123456" } }); t.after(f.close);
  const keys = Object.fromEntries(roles.map(role => [role, authenticator()]));
  await f.store.transaction(s => {
    for (const role of roles) {
      s.adminUsers.push({ id: role, username: role, role, active: true, passwordHash, passkeys: [keys[role].key] });
      s.adminSessions.push({ userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: "admin-csrf", expiresAt: new Date(+f.now() + 3600000).toISOString() });
    }
    if (retired) s.zone.authenticatorRetirement = { version: 1, retiredAt: f.now().toISOString() };
    s.adminProfile = { mfaEnabled: true, totpSecret: "LEGACYFACTOR", mfaCodeHash: hashSecret("123456", secret) };
    s.wifiDeviceGrants.push({ id: "retained-wifi-grant", customerId: "c1", mac: "AA:BB:CC:DD:EE:01", state: "approved" });
  });
  const call = async (path, input, { token = "owner", csrf = "admin-csrf" } = {}) => {
    const response = await fetch(f.api + path, { method: input === undefined ? "GET" : "POST", headers: {
      origin, "content-type": "application/json", cookie: `admin_session=${token}`, "x-csrf-token": csrf,
    }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const proof = async (purpose, input = {}, { token = "owner", flags } = {}) => {
    const result = await call(profile + "/proof/options", { ...input, purpose }, { token });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.options.userVerification, "required");
    return { challengeId: result.body.challengeId, response: keys[token].assertion(result.body.options, { flags }) };
  };
  return { ...f, keys, call, proof };
}

test("independent review: removing the last verified admin credential requires a verified replacement", async t => {
  const f = await fixture(t), spare = authenticator();
  await f.store.transaction(s => {
    const owner = s.adminUsers.find(u => u.id === "owner"); delete owner.passwordHash; owner.passkeys.push(spare.key);
  });
  const proof = await f.proof("passkey_remove", { credentialId: f.keys.owner.key.id });
  const result = await f.call(profile + "/passkeys/remove", { credentialId: f.keys.owner.key.id, ...proof });
  assert.equal(result.status, 409, "a merely configured, never-asserted spare is not a verified remaining sign-in method");
});

test("independent review: a read-only staff GET cannot mutate zone state", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => { s.zone.notes = "Preserve maintenance notice"; });
  const before = await f.store.snapshot(), result = await f.call("/api/admin/zone", undefined, { token: "auditor", csrf: "invalid" });
  assert.ok([403, 404, 405].includes(result.status), `GET returned ${result.status}`);
  assert.equal((await f.store.snapshot()).zone.notes, before.zone.notes);
});

test("independent review: zone update response omits private review and retirement markers", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => {
    s.zone.authenticationMigrationReview = { digest: "PRIVATE_REVIEW_DIGEST", evidenceReference: "PRIVATE_EVIDENCE" };
    s.zone.authenticatorRetirement.readinessDigest = "PRIVATE_RETIREMENT_DIGEST";
  });
  const result = await f.call("/api/admin/zone", { status: "online", notes: "Public notice" });
  assert.equal(result.status, 200);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|authenticationMigrationReview|authenticatorRetirement/);
  assert.equal((await f.store.snapshot()).zone.authenticatorRetirement.version, 1);
});
