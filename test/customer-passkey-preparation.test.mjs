import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret, totpCode, totpSecret } from "../lib/security.mjs";

const root = "/api/account/passkeys", origin = "http://customer.test";
function credential() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = publicKey.export({ format: "jwk" });
  const cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]])));
  return { privateKey, cose, record: { id: randomBytes(32).toString("base64url"), publicKey: cose.toString("base64url"), counter: 0, transports: ["internal"], label: "Existing owner key" } };
}
function signed(key, options, { registration = false, uv = true, counter = 1 } = {}) {
  const client = Buffer.from(JSON.stringify({ type: registration ? "webauthn.create" : "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
  const auth = Buffer.alloc(37); createHash("sha256").update("customer.test").digest().copy(auth); auth[32] = 1 | (uv ? 4 : 0) | (registration ? 64 : 0); auth.writeUInt32BE(counter, 33);
  const base = { id: key.record.id, rawId: key.record.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform" };
  if (registration) {
    const id = Buffer.from(key.record.id, "base64url"), length = Buffer.alloc(2); length.writeUInt16BE(id.length);
    const data = Buffer.concat([auth, Buffer.alloc(16), length, id, key.cose]);
    return { ...base, response: { clientDataJSON: client.toString("base64url"), transports: ["internal"], attestationObject: Buffer.from(isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(data)]]))).toString("base64url") } };
  }
  return { ...base, response: { clientDataJSON: client.toString("base64url"), authenticatorData: auth.toString("base64url"), signature: sign("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), key.privateKey).toString("base64url"), userHandle: null } };
}
async function fixture(t) { const f = await pairingFixture({ origin, liveClock: true, now: new Date() }); t.after(f.close); return f; }

test("preparation enrollment rejects a dashboard session without a fresh existing credential", async (t) => {
  const f = await fixture(t);
  const denied = await f.call(root + "/options", {});
  assert.equal(denied.status, 401); assert.equal(denied.body.code, "VERIFICATION_FAILED");
  const s = await f.store.snapshot();
  assert.equal(s.customerPasskeyChallenges.filter((row) => row.type === "registration").length, 0);
  assert.equal(s.customers[0].authMigration, undefined);
});

test("fresh PIN authorizes a single actual user-verified registration bound to this browser", async (t) => {
  const f = await fixture(t), key = credential(), created = await f.call(root + "/options", { pin: "2468" });
  assert.equal(created.status, 200);
  const challenge = (await f.store.snapshot()).customerPasskeyChallenges.find((row) => row.id === created.body.challengeId);
  assert.equal(challenge.sessionId, "main"); assert.equal(challenge.authorizationVersion, 1); assert.match(challenge.credentialVersion, /^[a-f0-9]{64}$/);
  const input = { challengeId: created.body.challengeId, response: signed(key, created.body.options, { registration: true }) };
  assert.equal((await f.call(root + "/verify", input)).status, 200);
  assert.equal((await f.call(root + "/verify", input)).status, 400);
  assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 1);
});

test("a legacy PIN-less account cannot use an authenticator to enroll supported credentials", async (t) => {
  const f = await fixture(t), secret = totpSecret();
  await f.store.transaction(s => { delete s.customers[0].pinHash; s.customers[0].totpSecret = secret; });
  assert.equal((await f.call(root + "/options", { otp: totpCode(secret,+f.now()) })).status,401);
  assert.equal((await f.call("/api/account/authentication-migration/pin/start", {newPin:"5830",confirmPin:"5830",otp:totpCode(secret,+f.now())})).status,401);
  assert.equal((await f.store.snapshot()).customers[0].pinHash,undefined);
});

test("existing passkey authorizes enrollment only with a fresh server-verified UV assertion", async (t) => {
  const f = await fixture(t), key = credential();
  await f.store.transaction((s) => { delete s.customers[0].pinHash; s.customers[0].passkeys = [key.record]; });
  const challenge = await f.call(root + "/proof/options", { purpose: "passkey_add" });
  assert.equal(challenge.status, 200); assert.equal(challenge.body.options.userVerification, "required");
  const proof = { challengeId: challenge.body.challengeId, response: signed(key, challenge.body.options) };
  assert.equal((await f.call(root + "/options", proof)).status, 200);
  assert.equal((await f.call(root + "/options", proof)).status, 401);
  const unverified = await f.call(root + "/proof/options", { purpose: "passkey_add" });
  assert.equal((await f.call(root + "/options", { challengeId: unverified.body.challengeId, response: signed(key, unverified.body.options, { uv: false, counter: 2 }) })).status, 401);
});

test("registration rejects old unbound challenges, wrong sessions, rotated credentials and missing UV", async (t) => {
  const f = await fixture(t), key = credential();
  await f.store.transaction((s) => { s.customerPasskeyChallenges.push({ id: "legacy-unbound", customerId: "c1", type: "registration", challenge: "legacy-challenge", expiresAt: new Date(+f.now() + 300000).toISOString() }); });
  assert.equal((await f.call(root + "/verify", { challengeId: "legacy-unbound", response: signed(key, { challenge: "legacy-challenge" }, { registration: true }) })).status, 400);
  for (const mode of ["session", "version", "uv"]) {
    const created = await f.call(root + "/options", { pin: "2468" }); assert.equal(created.status, 200);
    if (mode === "version") await f.store.transaction((s) => { s.customers[0].passkeys = [credential().record]; });
    const input = { challengeId: created.body.challengeId, response: signed(key, created.body.options, { registration: true, uv: mode !== "uv" }) };
    assert.equal((await f.call(root + "/verify", input, mode === "session" ? { session: "secondary" } : {})).status, 400);
    assert.equal((await f.store.snapshot()).customers[0].passkeys?.some((entry) => entry.id === key.record.id) || false, false);
  }
});

test("proof options and owner assertions preserve CSRF, purpose, session and attempted-proof replay fencing", async (t) => {
  const f = await fixture(t), key = credential(); await f.store.transaction((s) => { s.customers[0].passkeys = [key.record]; });
  assert.equal((await f.call(root + "/proof/options", { purpose: "passkey_add" }, { csrf: "wrong" })).status, 403);
  for (const mode of ["purpose", "session", "expired"]) {
    const f = await fixture(t), key = credential();
    await f.store.transaction((s) => { s.customers[0].passkeys = [key.record]; });
    const challenge = await f.call(root + "/proof/options", { purpose: mode === "purpose" ? "passkey_remove" : "passkey_add", passkeyId: key.record.id });
    assert.equal(challenge.status, 200);
    if (mode === "expired") f.advance(301);
    const proof = { challengeId: challenge.body.challengeId, response: signed(key, challenge.body.options) };
    assert.equal((await f.call(root + "/options", proof, mode === "session" ? { session: "secondary" } : {})).status, 401);
    assert.equal((await f.store.snapshot()).customerPasskeyChallenges.some((row) => row.id === challenge.body.challengeId), false);
    assert.equal((await f.call(root + "/options", proof)).status, 401);
  }
});

test("registration challenges and existing-key proof cannot cross account boundaries or survive suspension", async (t) => {
  const f = await fixture(t), key = credential();
  const created = await f.call(root + "/options", { pin: "2468" });
  const input = { challengeId: created.body.challengeId, response: signed(key, created.body.options, { registration: true }) };
  assert.equal((await f.call(root + "/verify", input, { session: "other" })).status, 400);
  await f.store.transaction((s) => { s.customers[0].status = "suspended"; });
  assert.equal((await f.call(root + "/options", { pin: "2468" })).status, 403);
  assert.equal((await f.call(root + "/verify", input)).status, 403);
});

test("failed PIN proofs throttle and an uncommitted registration challenge never reports success", async (t) => {
  const f = await fixture(t);
  for (let count = 0; count < 5; count++) { f.advance(60); const result = await f.call(root + "/options", { pin: "1111" }); assert.ok([401, 429].includes(result.status)); }
  assert.equal((await f.call(root + "/options", { pin: "2468" })).status, 429);
  f.advance(901);
  const transaction = f.store.transaction;
  f.store.transaction = (fn, options) => transaction.call(f.store, async (s) => { const result = await fn(s); if (s.customerPasskeyChallenges.some((entry) => entry.type === "registration")) throw Error("Synthetic registration commit rollback"); return result; }, options);
  const response = await f.call(root + "/options", { pin: "2468" });
  assert.notEqual(response.status, 200);
  assert.equal((await f.store.snapshot()).customerPasskeyChallenges.some((entry) => entry.type === "registration"), false);
});

test("preparation passkey removal requires fresh proof and keeps a verified supported replacement", async (t) => {
  const f = await fixture(t), key = credential();
  await f.store.transaction((s) => { s.customers[0].passkeys = [key.record]; });
  assert.equal((await f.call(root + "/remove", { passkeyId: key.record.id })).status, 401);
  f.advance(2);
  assert.equal((await f.call(root + "/remove", { passkeyId: key.record.id, pin: "2468" })).status, 200);
  assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 0);
  await f.store.transaction((s) => { delete s.customers[0].pinHash; s.customers[0].totpSecret = totpSecret(); s.customers[0].passkeys = [key.record]; });
  const challenge = await f.call(root + "/proof/options", { purpose: "passkey_remove", passkeyId: key.record.id });
  assert.equal(challenge.status, 200);
  assert.equal((await f.call(root + "/remove", { passkeyId: key.record.id, challengeId: challenge.body.challengeId, response: signed(key, challenge.body.options) })).status, 409);
  assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 1);
});

test("a stolen PIN-less passkey session cannot enroll an attacker authenticator and manufacture PIN readiness", async (t) => {
  const f = await fixture(t), key = credential();
  await f.store.transaction((s) => { delete s.customers[0].pinHash; s.customers[0].passkeys = [key.record]; });
  const denied = await f.call("/api/account/security/mfa/enroll", {});
  assert.equal(denied.status, 410); assert.equal(denied.body.code, "AUTHENTICATOR_RETIRED");
  assert.equal(denied.body.secret, undefined);
  assert.equal((await f.store.snapshot()).customerMfaChallenges.length, 0);
  const migration = await f.call("/api/account/authentication-migration/pin/start", { newPin: "5830", confirmPin: "5830", otp: "123456" });
  assert.equal(migration.status, 401);
  assert.equal((await f.store.snapshot()).customers[0].authMigration, undefined);
  assert.equal((await f.store.snapshot()).customers[0].pinHash, undefined);
});

test("an existing verified passkey establishes a new PIN only after session-bound confirmation",async t=>{
 const f=await fixture(t),key=credential();await f.store.transaction(s=>{delete s.customers[0].pinHash;s.customers[0].passkeys=[key.record];});
 const input={newPin:"5830",confirmPin:"5830"};
 const options=await f.call("/api/account/authentication-migration/options",{action:"pin",...input});assert.equal(options.status,200);
 const start=await f.call("/api/account/authentication-migration/pin/start",{...input,challengeId:options.body.challengeId,response:signed(key,options.body.options)});assert.equal(start.status,200);
 let state=await f.store.snapshot();assert.equal(state.customers[0].pinHash,undefined);assert.equal(state.dashboardSessions.find(s=>s.id==='main').authMigrationIntent.proofMethod,'passkey');
 assert.equal((await f.call("/api/account/authentication-migration/pin/confirm",{intentId:start.body.intentId,pin:"5830"},{session:"secondary"})).status,409);
 assert.equal((await f.call("/api/account/authentication-migration/pin/confirm",{intentId:start.body.intentId,pin:"wrong"})).status,401);
 assert.equal((await f.call("/api/account/authentication-migration/pin/confirm",{intentId:start.body.intentId,pin:"5830"})).status,200);
 assert.equal((await f.call("/api/account/login/pin",{phone:"670050001",pin:"5830"})).status,200);
});

test("pending intents issued under old authenticator proof cannot create a replacement PIN after runtime retirement",async t=>{
 const f=await fixture(t);await f.store.transaction(async s=>{delete s.customers[0].pinHash;s.customers[0].totpSecret=totpSecret();s.dashboardSessions.find(s=>s.id==='main').authMigrationIntent={id:'old-factor-intent',hash:'old-secret-hash',expiresAt:new Date(+f.now()+300000).toISOString()};});
 assert.equal((await f.call("/api/account/authentication-migration/pin/confirm",{intentId:'old-factor-intent',pin:'5830'})).status,409);
 assert.equal((await f.store.snapshot()).customers[0].pinHash,undefined);
 assert.equal((await f.call("/api/account/authentication-migration/status")).body.pendingPin,false);
});
