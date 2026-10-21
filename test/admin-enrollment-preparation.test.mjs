import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import argon2 from "argon2";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";
import { authenticationReadiness } from "../lib/authentication-migration.mjs";

const password = "Existing administrator password 81!", secret = "pairing-tests", origin = "http://customer.test", rpID = "customer.test";
const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const profile = "/api/admin/profile", hash = value => createHash("sha256").update(value).digest();
function keyFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = publicKey.export({ format: "jwk" });
  const publicCose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]]));
  const idBytes = randomBytes(32), id = idBytes.toString("base64url"); let counter = 0;
  const client = (options, type) => Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false }));
  return {
    key: { id, publicKey: Buffer.from(publicCose).toString("base64url"), counter: 0, transports: ["internal"] },
    assertion(options, flags = 5) {
      const data = client(options, "webauthn.get"), count = Buffer.alloc(4); count.writeUInt32BE(++counter);
      const auth = Buffer.concat([hash(rpID), Buffer.from([flags]), count]);
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: {
        clientDataJSON: data.toString("base64url"), authenticatorData: auth.toString("base64url"),
        signature: sign("sha256", Buffer.concat([auth, hash(data)]), privateKey).toString("base64url"),
      } };
    },
    registration(options) {
      const length = Buffer.alloc(2); length.writeUInt16BE(idBytes.length);
      const auth = Buffer.concat([hash(rpID), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, idBytes, Buffer.from(publicCose)]);
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { transports: ["internal"],
        clientDataJSON: client(options, "webauthn.create").toString("base64url"),
        attestationObject: Buffer.from(isoCBOR.encode(new Map([["fmt", "none"], ["authData", new Uint8Array(auth)], ["attStmt", new Map()]]))).toString("base64url"),
      } };
    },
  };
}

async function fixture(t) {
  const f = await pairingFixture({ env: { ADMIN_APP_URL: origin, ALLOWED_ADMIN_ORIGINS: origin, ADMIN_SESSION_SECRET: secret, WEBAUTHN_RP_ID: rpID } }); t.after(f.close);
  const existing = keyFixture();
  await f.store.transaction(s => {
    s.adminUsers.push({ id: "owner-81", username: "owner", active: true, role: "owner", passwordHash, passkeys: [existing.key] });
    s.adminSessions.push({ userId: "owner-81", tokenHash: hashSecret("owner-81", secret), role: "owner", csrfToken: "admin-csrf", expiresAt: new Date(+f.now() + 3600000).toISOString() });
    s.adminProfile = { totpSecret: "PRESERVED-LEGACY-FACTOR", mfaEnabled: true };
  });
  const call = async (path, input, token = "owner-81", csrf = "admin-csrf") => {
    const response = await fetch(f.api + path, { method: input === undefined ? "GET" : "POST", headers: {
      origin, "content-type": "application/json", cookie: `admin_session=${token}`, "x-csrf-token": csrf,
    }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, call, existing };
}

test("preparation cannot enroll an attacker's passkey or manufacture readiness from a stolen session alone", async t => {
  const f = await fixture(t), attacker = keyFixture();
  const denied = await f.call(profile + "/passkeys/options", {});
  assert.equal(denied.status, 401); assert.equal(denied.body.code, "VERIFICATION_FAILED");
  const state = await f.store.snapshot();
  assert.equal(state.adminPasskeyChallenges.length, 0);
  assert.equal(state.adminUsers[0].passkeys.some(key => key.id === attacker.key.id), false);
  assert.equal(state.adminUsers[0].authMigration, undefined);
  assert.equal(authenticationReadiness(state, { pepper: secret, now: f.now() }).administrators.unverified, 1);
  assert.equal((await f.call("/api/admin/authentication-migration/confirm", { challengeId: "fabricated", response: attacker.assertion({ challenge: "fabricated" }) })).status, 401);
  assert.equal((await f.store.snapshot()).adminUsers[0].authMigration, undefined);
});

test("old unbound registration challenges are rejected before they can add an attacker replacement", async t => {
  const f = await fixture(t), attacker = keyFixture(), challenge = randomBytes(32).toString("base64url");
  await f.store.transaction(s => s.adminPasskeyChallenges.push({ id: "old-registration", type: "registration", userId: "owner-81", challenge,
    expiresAt: new Date(+f.now() + 300000).toISOString() }));
  const denied = await f.call(profile + "/passkeys/verify", { challengeId: "old-registration", response: attacker.registration({ challenge }) });
  assert.equal(denied.status, 400); assert.equal((await f.store.snapshot()).adminUsers[0].passkeys.length, 1);
  assert.equal((await f.store.snapshot()).adminUsers[0].authMigration, undefined);
});

test("fresh existing password permits bound registration while preserving the existing authenticator", async t => {
  const f = await fixture(t), added = keyFixture();
  assert.equal((await f.call(profile + "/passkeys/options", { currentPassword: "wrong" })).status, 401);
  const options = await f.call(profile + "/passkeys/options", { currentPassword: password });
  assert.equal(options.status, 200);
  const enrolled = await f.call(profile + "/passkeys/verify", { challengeId: options.body.challengeId, response: added.registration(options.body.options) });
  assert.equal(enrolled.status, 200);
  const state = await f.store.snapshot();
  assert.equal(state.adminUsers[0].passkeys.length, 2);
  assert.equal(state.adminProfile.totpSecret, "PRESERVED-LEGACY-FACTOR");
  assert.equal(state.zone.authenticatorRetirement, undefined);
  assert.equal(state.adminUsers[0].authMigration.methods.password.method, "password");
});

test("fresh existing passkey must have required UV and its sensitive challenge is single-use", async t => {
  const f = await fixture(t);
  const request = () => f.call(profile + "/proof/options", { purpose: "passkey_add" });
  const first = await request(); assert.equal(first.status, 200); assert.equal(first.body.options.userVerification, "required");
  const bad = { challengeId: first.body.challengeId, response: f.existing.assertion(first.body.options, 1) };
  assert.equal((await f.call(profile + "/passkeys/options", bad)).status, 401);
  const second = await request(), proof = { challengeId: second.body.challengeId, response: f.existing.assertion(second.body.options) };
  assert.equal((await f.call(profile + "/passkeys/options", proof)).status, 200);
  assert.equal((await f.call(profile + "/passkeys/options", proof)).status, 401);
});

test("prepared admin registration is tied to one session, current credentials, role, expiry and one attempt", async t => {
  for (const mode of ["session", "password", "role", "expiry"]) {
    const f = await fixture(t), added = keyFixture(), options = await f.call(profile + "/passkeys/options", { currentPassword: password });
    let token = "owner-81";
    await f.store.transaction(s => {
      if (mode === "session") { token = "owner-other"; s.adminSessions.push({ ...s.adminSessions[0], tokenHash: hashSecret(token, secret) }); }
      if (mode === "password") s.adminUsers[0].passwordHash += "changed";
      if (mode === "role") { s.adminUsers[0].role = "operator"; s.adminSessions[0].role = "operator"; }
    });
    if (mode === "expiry") f.advance(301);
    const result = await f.call(profile + "/passkeys/verify", { challengeId: options.body.challengeId, response: added.registration(options.body.options) }, token);
    assert.ok([400, 401].includes(result.status), mode + JSON.stringify(result));
    assert.equal((await f.store.snapshot()).adminUsers[0].passkeys.length, 1);
  }
});

test("preparation enrollment challenges and verification metadata are not returned before a failed commit", async t => {
  const f = await fixture(t), before = await f.store.snapshot(), transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (fn, ...args) => transaction(async s => { const result = await fn(s); if (s.adminPasskeyChallenges.length) throw Error("Synthetic preparation enrollment rollback"); return result; }, ...args);
  const result = await f.call(profile + "/passkeys/options", { currentPassword: password });
  assert.ok(result.status >= 400); assert.equal(result.body.challengeId, undefined);
  const after = await f.store.snapshot();
  assert.deepEqual(after.adminUsers, before.adminUsers); assert.deepEqual(after.adminPasskeyChallenges, before.adminPasskeyChallenges);
});

test("preparation cannot mint or deactivate durable staff credentials from an owner session alone", async t => {
  const f = await fixture(t), input = { username: "attacker-owner", role: "owner", password: "attacker chosen password 81" };
  const denied = await f.call("/api/admin/users", input);
  assert.equal(denied.status, 401);
  assert.equal((await f.store.snapshot()).adminUsers.length, 1);
  const approved = await f.call("/api/admin/users", { ...input, currentPassword: password });
  assert.equal(approved.status, 201);
  assert.equal((await f.call("/api/admin/users/deactivate", { userId: approved.body.user.id })).status, 401);
  assert.equal((await f.store.snapshot()).adminUsers.find(user => user.id === approved.body.user.id).active, true);
  assert.equal((await f.call("/api/admin/users/deactivate", { userId: approved.body.user.id, currentPassword: password })).status, 200);
});

test("production preparation refuses missing stored and submitted CSRF tokens", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => { delete s.adminSessions[0].csrfToken; });
  const denied = await f.call(profile + "/passkeys/options", { currentPassword: password }, "owner-81", "");
  assert.equal(denied.status, 403);
  assert.equal((await f.store.snapshot()).adminPasskeyChallenges.length, 0);
});
