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

test("retired admin pin/passkey login ignores stale TOTP flags and old challenges", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => s.adminLoginChallenges.push({ id: "unexpired-old-challenge", userId: "owner", ip: "127.0.0.1", attempts: 0, used: false,
    expiresAt: new Date(+f.now() + 300000).toISOString() }));
  assert.equal((await f.call("/api/admin/login", { username: "owner", pin: "wrong-pin" })).status, 401);
  const login = await f.call("/api/admin/login", { username: "owner", pin: password });
  assert.equal(login.status, 200); assert.equal(login.body.authenticated, true); assert.equal(login.body.mfaEnabled, false);
  assert.match(login.headers.get("set-cookie"), /admin_session=/);
  for (const path of ["/api/admin/login/mfa", profile + "/mfa", profile + "/mfa/enroll", profile + "/mfa/confirm"]) {
    const retired = await f.call(path, { challengeId: "unexpired-old-challenge", mfaCode: "123456", enabled: true, code: "123456" });
    assert.equal(retired.status, 410); assert.equal(retired.body.code, "AUTHENTICATOR_RETIRED");
  }
  assert.equal((await f.call(profile + "/proof/options", { purpose: "legacy_mfa", action: "enroll" })).status, 410);
  const options = await f.call("/api/admin/passkey/options", { username: "owner" });
  const response = f.keys.owner.assertion(options.body.options);
  const verified = await f.call("/api/admin/passkey/verify", { challengeId: options.body.challengeId, response });
  assert.equal(verified.status, 200); assert.equal(verified.body.authenticated, true);
  assert.equal((await f.call("/api/admin/passkey/verify", { challengeId: options.body.challengeId, response })).status, 401);
  assert.equal((await f.store.snapshot()).adminLoginChallenges[0].used, false);
});

test("retired staff creation needs distinct current-owner proof and never authenticates using the new employee password", async t => {
  const f = await fixture(t), input = { username: "new-operator", displayName: "New Operator", role: "operator", password: newPassword };
  assert.equal((await f.call("/api/admin/users", input)).status, 401);
  assert.equal((await f.call("/api/admin/users", { ...input, password })).status, 401);
  assert.equal((await f.call("/api/admin/users", { ...input, currentPassword: "incorrect" })).status, 401);
  const created = await f.call("/api/admin/users", { ...input, currentPassword: password });
  assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.user.role, "operator");
  const added = (await f.store.snapshot()).adminUsers.find(user => user.username === input.username);
  assert.equal(await argon2.verify(added.passwordHash, newPassword), true);
  assert.equal((await f.call("/api/admin/users", { ...input, username: "denied", currentPassword: password }, { token: "operator" })).status, 403);
});

test("staff creation passkey proof binds canonical staff fields and a private slow-hashed password intent", async t => {
  const f = await fixture(t), input = { username: "  NEW-STAFF  ", displayName: "New Staff", role: "auditor", password: newPassword };
  const proof = await f.proof("staff_create", input);
  const state = await f.store.snapshot();
  assert.doesNotMatch(JSON.stringify(state.adminPasskeyChallenges), new RegExp(newPassword));
  const intent = state.adminPasskeyChallenges.find(ch => ch.id === proof.challengeId).staffPasswordIntent;
  assert.match(intent.passwordHash, /^\$argon2id\$/);
  assert.equal(await argon2.verify(intent.passwordHash, newPassword), true);
  assert.equal((await f.call("/api/admin/users", { ...input, role: "owner", ...proof })).status, 401);
  const fresh = await f.proof("staff_create", input);
  const created = await f.call("/api/admin/users", { ...input, username: "new-staff", ...fresh });
  assert.equal(created.status, 201); assert.equal(created.body.user.username, "new-staff");
});

test("staff creation rejects a different proposed password and consumes the exact sensitive intent", async t => {
  const f = await fixture(t), input = { username: "password-intent-staff", role: "auditor", password: newPassword };
  const signed = await f.proof("staff_create", input);
  assert.equal((await f.call("/api/admin/users", { ...input, password: "A different proposed password 82!", ...signed })).status, 401);
  const after = await f.store.snapshot();
  assert.equal(after.adminUsers.length, 4);
  assert.equal(after.adminUsers[0].passkeys[0].counter, 0);
  assert.equal(after.adminUsers[0].adminProofFailures.count, 1);
  assert.equal(after.adminPasskeyChallenges.some(ch => ch.id === signed.challengeId), false);
  assert.equal((await f.call("/api/admin/users", { ...input, ...signed })).status, 401);
});

test("owner deactivation requires fresh target-bound proof and revokes the target's sessions", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/admin/users/deactivate", { userId: "operator" })).status, 401);
  const proof = await f.proof("staff_deactivate", { userId: "operator" });
  assert.equal((await f.call("/api/admin/users/deactivate", { userId: "reseller", ...proof })).status, 401);
  const approved = await f.proof("staff_deactivate", { userId: "operator" });
  const result = await f.call("/api/admin/users/deactivate", { userId: "operator", ...approved });
  assert.equal(result.status, 200); assert.equal(result.body.sessionsEnded, 1);
  assert.equal((await f.call("/api/admin/dashboard", undefined, { token: "operator" })).status, 401);
  assert.equal((await f.call("/api/admin/users/deactivate", { userId: "owner", currentPassword: password })).status, 409);
});

test("every valid admin role can enroll and remove a self passkey using fresh supported proof", async t => {
  const f = await fixture(t);
  for (const role of roles) {
    assert.equal((await f.call(profile + "/passkeys/options", {}, { token: role })).status, 401);
    const enrollment = await f.call(profile + "/passkeys/options", { currentPassword: password }, { token: role });
    assert.equal(enrollment.status, 200, role + JSON.stringify(enrollment.body));
    assert.equal(enrollment.body.options.authenticatorSelection.userVerification, "required");
    const added = authenticator(), input = { challengeId: enrollment.body.challengeId, response: added.registration(enrollment.body.options) };
    assert.equal((await f.call(profile + "/passkeys/verify", input, { token: role })).status, 200);
    assert.equal((await f.call(profile + "/passkeys/verify", input, { token: role })).status, 400);
    const remove = await f.call(profile + "/passkeys/remove", { credentialId: added.key.id, currentPassword: password }, { token: role });
    assert.equal(remove.status, 200, role + JSON.stringify(remove.body));
    assert.equal(remove.body.passkeys, 1);
  }
});

test("passkey enrollment can use a signed fresh passkey proof and rejects registration without UV", async t => {
  const f = await fixture(t), proof = await f.proof("passkey_add");
  const enrollment = await f.call(profile + "/passkeys/options", proof);
  assert.equal(enrollment.status, 200);
  const added = authenticator();
  assert.equal((await f.call(profile + "/passkeys/verify", { challengeId: enrollment.body.challengeId, response: added.registration(enrollment.body.options, { flags: 0x41 }) })).status, 400);
  assert.equal((await f.store.snapshot()).adminUsers[0].passkeys.length, 1);
  const second = await f.proof("passkey_add");
  const valid = await f.call(profile + "/passkeys/options", second);
  assert.equal((await f.call(profile + "/passkeys/verify", { challengeId: valid.body.challengeId, response: added.registration(valid.body.options) })).status, 200);
});

test("admin registration is session/current-credential bound and expires after five minutes", async t => {
  for (const mode of ["session", "password", "expired", "revoked"]) {
    const f = await fixture(t), added = authenticator();
    const enrollment = await f.call(profile + "/passkeys/options", { currentPassword: password });
    assert.equal(enrollment.status, 200);
    let token = "owner";
    if (mode === "session") { token = "owner-other"; await f.store.transaction(s => s.adminSessions.push({ ...s.adminSessions[0], tokenHash: hashSecret(token, secret) })); }
    if (mode === "password") await f.store.transaction(s => s.adminUsers[0].passwordHash += "changed");
    if (mode === "expired") f.advance(301);
    if (mode === "revoked") await f.store.transaction(s => { s.adminUsers[0].active = false; });
    const result = await f.call(profile + "/passkeys/verify", { challengeId: enrollment.body.challengeId, response: added.registration(enrollment.body.options) }, { token });
    assert.ok([400, 401].includes(result.status), mode + JSON.stringify(result));
    assert.equal((await f.store.snapshot()).adminUsers[0].passkeys.length, 1);
  }
});

test("removing the last usable administrator credential is blocked even after a valid passkey proof", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => { delete s.adminUsers[0].passwordHash; });
  const proof = await f.proof("passkey_remove", { credentialId: f.keys.owner.key.id });
  const result = await f.call(profile + "/passkeys/remove", { credentialId: f.keys.owner.key.id, ...proof });
  assert.equal(result.status, 409); assert.equal(result.body.code, "LAST_CREDENTIAL");
  assert.equal((await f.store.snapshot()).adminUsers[0].passkeys.length, 1);
});

test("an unverified second admin passkey cannot justify removing the only verified key; a fresh password can", async t => {
  const f = await fixture(t), unverified = authenticator();
  await f.store.transaction(s => { s.adminUsers[0].passkeys.push(unverified.key); });
  const proof = await f.proof("passkey_remove", { credentialId: f.keys.owner.key.id });
  const blocked = await f.call(profile + "/passkeys/remove", { credentialId: f.keys.owner.key.id, ...proof });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, "LAST_CREDENTIAL");
  assert.equal((await f.store.snapshot()).adminUsers[0].passkeys.length, 2);
  const passwordApproved = await f.call(profile + "/passkeys/remove", { credentialId: f.keys.owner.key.id, currentPassword: password });
  assert.equal(passwordApproved.status, 200);
  assert.equal((await f.store.snapshot()).adminUsers[0].passkeys[0].id, unverified.key.id);
});

const recovery = { customerId: "c1", purpose: "pin", caseReference: "SUPPORT-82", reason: "Customer identified in person for PIN recovery", verificationMethod: "in_person", confirmedIdentity: true };
test("audited PIN recovery accepts exact scoped current password/passkey and preserves Wi-Fi grants", async t => {
  const f = await fixture(t), before = await f.store.snapshot();
  assert.equal((await f.call("/api/admin/customers/recovery", { ...recovery, currentPassword: password, confirmedIdentity: false })).status, 400);
  assert.equal((await f.call("/api/admin/customers/recovery", recovery)).status, 400);
  const proof = await f.proof("support_recovery", { ...recovery, recoveryPurpose: "pin" });
  assert.equal((await f.call("/api/admin/customers/recovery", { ...recovery, caseReference: "OTHER-CASE", ...proof })).status, 400);
  const fresh = await f.proof("support_recovery", { ...recovery, recoveryPurpose: "pin" });
  const result = await f.call("/api/admin/customers/recovery", { ...recovery, ...fresh });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.ok(result.body.recoveryCode);
  const after = await f.store.snapshot(), stored = after.pinResetChallenges.find(row => row.source === "support");
  assert.equal(stored.tokenHash, hashSecret(result.body.recoveryCode, secret));
  assert.deepEqual(after.wifiDeviceGrants, before.wifiDeviceGrants);
  assert.deepEqual(after.customers[0].wifiMainDevice, before.customers[0].wifiMainDevice);
  assert.equal((await f.call("/api/admin/customers/recovery", { ...recovery, purpose: "authenticator", currentPassword: password })).status, 410);
  assert.equal((await f.call(profile + "/proof/options", { ...recovery, purpose: "support_recovery" }, { token: "operator" })).status, 403);
  const fallback = await fixture(t);
  assert.equal((await fallback.call("/api/admin/customers/recovery", { ...recovery, currentPassword: password, password: "ignored old field" })).status, 200);
});

test("supported sensitive proofs require current roles, CSRF and a genuine active account after retirement", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(profile + "/passkeys/options", { currentPassword: password }, { csrf: "wrong" })).status, 403);
  assert.equal((await f.call(profile + "/proof/options", { purpose: "staff_deactivate", userId: "auditor" }, { token: "auditor" })).status, 403);
  for (const mode of ["deleted", "inactive", "unknown-role", "unbound"]) {
    const g = await fixture(t);
    await g.store.transaction(s => {
      if (mode === "deleted") s.adminUsers = s.adminUsers.filter(user => user.id !== "owner");
      if (mode === "inactive") s.adminUsers[0].active = false;
      if (mode === "unknown-role") s.adminUsers[0].role = "superuser";
      if (mode === "unbound") delete s.adminSessions[0].userId;
    });
    assert.equal((await g.call("/api/admin/dashboard")).status, 401, mode);
    assert.equal((await g.call(profile + "/passkeys/options", { currentPassword: password })).status, 401, mode);
  }
  const prepared = await fixture(t, { retired: false });
  await prepared.store.transaction(s => { s.adminUsers = []; delete s.adminSessions[0].userId; });
  assert.equal((await prepared.call("/api/admin/dashboard")).status, 200);
});

test("compatible runtime also closes session-only credential enrollment and staff creation before cutover", async t => {
  const f = await fixture(t, { retired: false });
  assert.equal((await f.call(profile + "/passkeys/options", {})).status, 401);
  assert.equal((await f.call("/api/admin/users", { username: "session-only-owner", role: "owner", password: newPassword })).status, 401);
  assert.equal((await f.call("/api/admin/users/deactivate", { userId: "operator" })).status, 401);
  const state = await f.store.snapshot();
  assert.equal(state.adminUsers.length, 4); assert.equal(state.adminUsers[1].active, true);
  assert.equal(state.adminProfile.totpSecret, "LEGACYFACTOR");
});

test("retired administrator mutations reject an empty stored CSRF token even when the submitted token is also empty", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => { delete s.adminSessions[0].csrfToken; });
  const result = await f.call(profile + "/passkeys/options", { currentPassword: password }, { csrf: "" });
  assert.equal(result.status, 403);
  assert.equal((await f.store.snapshot()).adminPasskeyChallenges.length, 0);
});

test("sensitive passkey proofs cannot become login, cross purposes/sessions, omit UV or survive stale account authority", async t => {
  const f = await fixture(t), target = { userId: "operator" };
  const proof = await f.proof("staff_deactivate", target);
  const login = await f.call("/api/admin/passkey/verify", proof); assert.equal(login.status, 401); assert.equal(login.headers.get("set-cookie"), null);
  assert.equal((await f.call(profile + "/passkeys/options", proof)).status, 401);
  const missingUV = await f.proof("staff_deactivate", target, { flags: 1 });
  assert.equal((await f.call("/api/admin/users/deactivate", { ...target, ...missingUV })).status, 401);
  const changed = await f.proof("staff_deactivate", target);
  await f.store.transaction(s => { s.adminUsers[0].username = "renamed-owner"; });
  assert.equal((await f.call("/api/admin/users/deactivate", { ...target, ...changed })).status, 401);
});

test("sensitive admin actions reject another sign-in and an expired proof without changing their target", async t => {
  for (const mode of ["session", "expired"]) {
    const f = await fixture(t), input = { userId: "operator" }, proof = await f.proof("staff_deactivate", input);
    let token = "owner";
    if (mode === "session") {
      token = "owner-other";
      await f.store.transaction(s => s.adminSessions.push({ ...s.adminSessions[0], tokenHash: hashSecret(token, secret) }));
    } else f.advance(301);
    assert.equal((await f.call("/api/admin/users/deactivate", { ...input, ...proof }, { token })).status, 401);
    assert.equal((await f.store.snapshot()).adminUsers.find(user => user.id === "operator").active, true);
  }
});

test("admin passkey login rejects changed roles and malformed expiry without issuing a session", async t => {
  for (const mode of ["role", "expiry"]) {
    const f = await fixture(t), options = await f.call("/api/admin/passkey/options", { username: "owner" });
    const before = (await f.store.snapshot()).adminSessions.length;
    await f.store.transaction(s => {
      if (mode === "role") s.adminUsers[0].role = "operator";
      else s.adminPasskeyChallenges.find(ch => ch.id === options.body.challengeId).expiresAt = "invalid";
    });
    const result = await f.call("/api/admin/passkey/verify", { challengeId: options.body.challengeId, response: f.keys.owner.assertion(options.body.options) });
    assert.equal(result.status, 401); assert.equal(result.headers.get("set-cookie"), null);
    assert.equal((await f.store.snapshot()).adminSessions.length, before);
  }
});

test("fresh administrator failures lock at five attempts with a bounded retry-after", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) assert.equal((await f.call(profile + "/passkeys/options", { currentPassword: "wrong" })).status, 401);
  const lock = await f.call(profile + "/passkeys/options", { currentPassword: "wrong" });
  assert.equal(lock.status, 429); assert.equal(lock.headers.get("retry-after"), "900");
  assert.equal((await f.call(profile + "/passkeys/options", { currentPassword: password })).status, 429);
  f.advance(901);
  assert.equal((await f.call(profile + "/passkeys/options", { currentPassword: password })).status, 200);
});

test("administrator mutation/challenge/recovery responses wait for commit and roll back credentials and returned tokens", async t => {
  for (const mode of ["staff", "registration", "removal", "recovery"]) {
    const f = await fixture(t), before = await f.store.snapshot(), transaction = f.store.transaction.bind(f.store);
    f.store.transaction = (fn, ...args) => transaction(async s => { const value = await fn(s);
      if (mode === "staff" && s.adminUsers.length > before.adminUsers.length || mode === "registration" && s.adminPasskeyChallenges.length ||
        mode === "removal" && s.adminUsers[0].passkeys.length < before.adminUsers[0].passkeys.length || mode === "recovery" && s.pinResetChallenges.length) throw Error("Synthetic admin commit rollback");
      return value;
    }, ...args);
    let result;
    if (mode === "staff") result = await f.call("/api/admin/users", { username: "rolled-back", role: "operator", password: newPassword, currentPassword: password });
    if (mode === "registration") result = await f.call(profile + "/passkeys/options", { currentPassword: password });
    if (mode === "removal") result = await f.call(profile + "/passkeys/remove", { credentialId: f.keys.owner.key.id, currentPassword: password });
    if (mode === "recovery") result = await f.call("/api/admin/customers/recovery", { ...recovery, currentPassword: password });
    assert.ok(result.status >= 400, mode + JSON.stringify(result));
    assert.equal(result.body.challengeId, undefined); assert.equal(result.body.recoveryCode, undefined); assert.equal(result.body.removed, undefined);
    const after = await f.store.snapshot();
    assert.deepEqual(after.adminUsers, before.adminUsers); assert.deepEqual(after.adminPasskeyChallenges, before.adminPasskeyChallenges);
    assert.deepEqual(after.pinResetChallenges, before.pinResetChallenges);
  }
});
