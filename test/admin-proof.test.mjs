import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import argon2 from "argon2";
import { adminProofOptions, verifyAdminProof } from "../lib/admin-proof.mjs";

const password = "Correct administrator password 81!";
const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const rpID = "admin.example.test", origin = `https://${rpID}`, type = "authentication_migration", target = "retained-methods";
const sha256 = (value) => createHash("sha256").update(value).digest();

function fixture() {
  let now = new Date("2030-01-01T12:00:00Z");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  // COSE EC2 / ES256 / P-256 with the real generated public coordinates.
  const cose = Buffer.concat([Buffer.from("a5010203262001215820", "hex"), Buffer.from(jwk.x, "base64url"),
    Buffer.from("225820", "hex"), Buffer.from(jwk.y, "base64url")]);
  const key = { id: randomBytes(32).toString("base64url"), publicKey: cose.toString("base64url"), counter: 0,
    transports: ["internal"], createdAt: now.toISOString() };
  const user = { id: "administrator-81", username: "owner", active: true, role: "owner", passwordHash, passkeys: [key] };
  const session = { tokenHash: "hashed-admin-cookie-81", userId: user.id, role: user.role, expiresAt: new Date(+now + 3600000).toISOString() };
  const s = { adminUsers: [user], adminSessions: [session], adminPasskeyChallenges: [] };
  const base = { s, user, session, type, target, rpID, origin, clock: () => now };
  const options = (extra = {}) => adminProofOptions({ ...base, ...extra });
  const verify = (input, extra = {}) => verifyAdminProof({ ...base, input, ...extra });
  function assertion(options, { counter = 1, flags = 5, clientOrigin = origin, clientChallenge = options.challenge,
    clientType = "webauthn.get", signedRpID = rpID, signingKey = privateKey } = {}) {
    const client = Buffer.from(JSON.stringify({ type: clientType, challenge: clientChallenge, origin: clientOrigin, crossOrigin: false }));
    const count = Buffer.alloc(4); count.writeUInt32BE(counter);
    const authenticatorData = Buffer.concat([sha256(signedRpID), Buffer.from([flags]), count]);
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(client)]), signingKey);
    return { id: key.id, rawId: key.id, type: "public-key", clientExtensionResults: {}, response: {
      clientDataJSON: client.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"), userHandle: null,
    } };
  }
  return { ...base, key, options, verify, assertion, advance: (ms) => { now = new Date(+now + ms); } };
}

test("fresh admin proof verifies Argon2 PIN or password and accepts currentPin and pin", async () => {
  const f = fixture();
  assert.deepEqual(await f.verify({ pin: password }), { verified: true, method: "pin" });
  assert.deepEqual(await f.verify({ currentPin: password }), { verified: true, method: "pin" });
  assert.deepEqual(await f.verify({ currentPassword: password }), { verified: true, method: "password" });
  assert.deepEqual(await f.verify({ password }), { verified: true, method: "password" });
  assert.equal(f.user.adminProofFailures, undefined);
  f.user.passwordHash = "not-an-argon2-hash";
  assert.equal((await f.verify({ password })).verified, false);
});

test("fresh admin proof rejects malformed proof inputs without throwing", async () => {
  const f = fixture();
  for (const input of [null, password, [password], { pin: "wrong-pin" }]) assert.equal((await f.verify(input)).verified, false);
  assert.equal((await f.verify({ password })).verified, true);
});

test("fresh admin password proof locks after five bounded failures for 15 minutes without extending on retry", async () => {
  const f = fixture();
  for (let attempt = 1; attempt <= 4; attempt++) assert.equal((await f.verify({ password: "wrong" })).throttle, undefined);
  const locked = await f.verify({ password: "wrong" });
  assert.deepEqual(locked.throttle, { locked: true, retryAfterSeconds: 900 });
  assert.equal(f.user.adminProofFailures.count, 5);
  const until = f.user.adminProofFailures.lockedUntil;
  f.advance(1001);
  assert.equal((await f.verify({ password })).verified, false);
  assert.equal((await f.verify({ password })).throttle.retryAfterSeconds, 899);
  assert.equal(f.user.adminProofFailures.count, 5);
  assert.equal(f.user.adminProofFailures.lockedUntil, until);
  f.advance(899000);
  assert.equal((await f.verify({ password })).verified, true);
  assert.equal(f.user.adminProofFailures, undefined);
});

test("fresh admin proof does not lock out users for failures older than the 15-minute window", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) await f.verify({ password: "wrong" });
  f.advance(900000);
  assert.equal((await f.verify({ password: "wrong" })).throttle, undefined);
  assert.equal(f.user.adminProofFailures.count, 1);
});

test("real signed admin passkey assertion requires user verification, updates its counter, and cannot replay", async () => {
  const f = fixture(), generated = await f.options();
  assert.equal(generated.options.userVerification, "required");
  assert.equal(generated.options.allowCredentials[0].id, f.key.id);
  assert.equal(f.s.adminPasskeyChallenges[0].type, `sensitive:${type}`);
  assert.equal(f.s.adminPasskeyChallenges[0].sessionTokenHash, f.session.tokenHash);
  const response = f.assertion(generated.options);
  assert.deepEqual(await f.verify({ challengeId: generated.challengeId, response }), { verified: true, method: "passkey", credentialId: f.key.id });
  assert.equal(f.key.counter, 1);
  assert.equal(f.s.adminPasskeyChallenges.length, 0);
  assert.equal((await f.verify({ challengeId: generated.challengeId, response })).verified, false);
  assert.equal(f.key.counter, 1);
});

test("invalid admin passkey signatures, UV, origin, RP, challenge, type and stale counters fail closed", async (t) => {
  const { privateKey: otherKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const invalid = [
    ["wrong signing key", { signingKey: otherKey }], ["no UV", { flags: 1 }], ["no UP", { flags: 4 }],
    ["wrong origin", { clientOrigin: "https://attacker.example.test" }], ["wrong RP", { signedRpID: "attacker.example.test" }],
    ["wrong challenge", { clientChallenge: "different-challenge" }], ["registration assertion", { clientType: "webauthn.create" }],
    ["stale counter", { counter: 1 }],
  ];
  for (const [name, overrides] of invalid) await t.test(name, async () => {
    const f = fixture();
    if (name === "stale counter") f.key.counter = 2;
    const before = f.key.counter, generated = await f.options();
    assert.equal((await f.verify({ challengeId: generated.challengeId, response: f.assertion(generated.options, overrides), password })).verified, false);
    assert.equal(f.key.counter, before);
    assert.equal(f.s.adminPasskeyChallenges.length, 0);
  });
});

test("admin passkey proof is bound to exact purpose, target, session and five-minute expiry", async (t) => {
  for (const change of ["purpose", "target", "session", "expired"]) await t.test(change, async () => {
    const f = fixture(), generated = await f.options(), response = f.assertion(generated.options);
    const extra = {};
    if (change === "purpose") extra.type = "unrelated_operation";
    if (change === "target") extra.target = "another-staff-account";
    if (change === "session") {
      extra.session = { ...f.session, tokenHash: "different-session" };
      f.s.adminSessions.push(extra.session);
    }
    if (change === "expired") f.advance(300000);
    assert.equal((await f.verify({ challengeId: generated.challengeId, response }, extra)).verified, false);
    assert.equal(f.key.counter, 0);
    assert.equal(f.s.adminPasskeyChallenges.length, 0);
  });
});

test("admin proof rejects revoked accounts, roles and expired or removed sessions with password or passkey", async (t) => {
  for (const change of ["deactivated", "deleted", "invalid-role", "demoted", "expired-session", "ended-session", "different-user"]) await t.test(change, async () => {
    const f = fixture(), generated = await f.options(), response = f.assertion(generated.options);
    if (change === "deactivated") f.user.active = false;
    if (change === "deleted") f.s.adminUsers = [];
    if (change === "invalid-role") f.user.role = "anything";
    if (change === "demoted") f.user.role = "auditor";
    if (change === "expired-session") f.session.expiresAt = f.clock().toISOString();
    if (change === "ended-session") f.s.adminSessions = [];
    if (change === "different-user") f.session.userId = "another-user";
    assert.equal((await f.verify({ password })).verified, false);
    assert.equal((await f.verify({ challengeId: generated.challengeId, response })).verified, false);
    await assert.rejects(f.options(), /verification is unavailable/);
    assert.equal(f.key.counter, 0);
  });
});

test("admin passkey proof rejects username, password, role or credential changes since challenge issuance", async (t) => {
  for (const change of ["username", "password", "role", "removed-key", "replaced-key", "added-key"]) await t.test(change, async () => {
    const f = fixture(), generated = await f.options(), response = f.assertion(generated.options);
    if (change === "username") f.user.username = "renamed-owner";
    if (change === "password") f.user.passwordHash = `${passwordHash}-changed`;
    if (change === "role") { f.user.role = "operator"; f.session.role = "operator"; }
    if (change === "removed-key") f.user.passkeys = [];
    if (change === "replaced-key") f.key.publicKey = `${f.key.publicKey}AA`;
    if (change === "added-key") f.user.passkeys.push({ ...f.key, id: "new-key" });
    assert.equal((await f.verify({ challengeId: generated.challengeId, response })).verified, false);
    assert.equal(f.key.counter, 0);
  });
});

test("admin sensitive proofs cannot consume or use registration or login challenges", async (t) => {
  for (const challengeType of [undefined, "registration", "login"]) await t.test(String(challengeType), async () => {
    const f = fixture(), generated = await f.options(), response = f.assertion(generated.options);
    f.s.adminPasskeyChallenges[0].type = challengeType;
    assert.equal((await f.verify({ challengeId: generated.challengeId, response })).verified, false);
    assert.equal(f.s.adminPasskeyChallenges.length, 1);
    assert.equal(f.key.counter, 0);
  });
});

test("admin sensitive challenge issuance bounds outstanding rows and expires old proofs without removing login rows", async () => {
  const f = fixture();
  f.s.adminPasskeyChallenges.push({ id: "preserved-login", userId: f.user.id, expiresAt: "1999-01-01T00:00:00Z" });
  for (let i = 0; i < 15; i++) await f.options({ target: `target-${i}` });
  assert.equal(f.s.adminPasskeyChallenges.length, 11);
  const one = await f.options();
  const two = await f.options();
  assert.notEqual(one.challengeId, two.challengeId);
  assert.equal(f.s.adminPasskeyChallenges.filter((ch) => ch.target === target).length, 1);
  assert.equal(f.s.adminPasskeyChallenges.length, 11);
  f.advance(300000);
  await f.options();
  assert.equal(f.s.adminPasskeyChallenges.length, 2);
  assert.equal(f.s.adminPasskeyChallenges[0].id, "preserved-login");
});

test("a fresh passkey proof clears prior failed attempts, and another legitimate counter advance stays safe", async () => {
  const f = fixture();
  await f.verify({ password: "incorrect" });
  const generated = await f.options();
  f.key.counter = 1;
  assert.equal((await f.verify({ challengeId: generated.challengeId, response: f.assertion(generated.options, { counter: 2 }) })).verified, true);
  assert.equal(f.key.counter, 2);
  assert.equal(f.user.adminProofFailures, undefined);
});

test("administrator password proof takes precedence over a stale legacy PIN alias",async()=>{
 const f=fixture();f.user.pinHash=await argon2.hash("1357");
 assert.equal((await f.verify({pin:"1357"})).verified,false,"a stale PIN alias cannot replace the existing password");
 assert.deepEqual(await f.verify({password,pin:"1357"}),{verified:true,method:"password"});
 assert.deepEqual(await f.verify({currentPassword:password,currentPin:"wrong"}),{verified:true,method:"password"});
 const options=await f.options();f.user.passwordHash=await argon2.hash("Rotated administrator password 82!");
 assert.equal((await f.verify({challengeId:options.challengeId,response:f.assertion(options.options)})).verified,false);
});
