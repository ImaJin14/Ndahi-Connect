import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import argon2 from "argon2";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { createServer, createStore } from "../server.mjs";
import { hashSecret, totpSecret, totpCode } from "../lib/security.mjs";

const origin = "http://customer.test", secret = "retirement-customer-secret", pepper = "retirement-proof-pepper";
const at = new Date("2030-01-01T12:00:00Z"), hashing = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const pinHash = await argon2.hash("2468", hashing), backupCode = "NC-REC-synthetic-retirement-account-backup", backupHash = await argon2.hash(backupCode, hashing);
function passkey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = publicKey.export({ format: "jwk" });
  const cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]])));
  return { privateKey, cose, record: { id: randomBytes(32).toString("base64url"), publicKey: cose.toString("base64url"), counter: 0, transports: ["internal"], label: "Test passkey" } };
}
function response(key, options, { uv = true, counter = 1, registration = false } = {}) {
  const client = Buffer.from(JSON.stringify({ type: registration ? "webauthn.create" : "webauthn.get", challenge: options.challenge, origin })),
    auth = Buffer.alloc(37); createHash("sha256").update("customer.test").digest().copy(auth); auth[32] = 1 | (uv ? 4 : 0) | (registration ? 64 : 0); auth.writeUInt32BE(counter, 33);
  const base = { id: key.record.id, rawId: key.record.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform" };
  if (registration) {
    const id = Buffer.from(key.record.id, "base64url"), length = Buffer.alloc(2); length.writeUInt16BE(id.length);
    const authData = Buffer.concat([auth, Buffer.alloc(16), length, id, key.cose]);
    return { ...base, response: { clientDataJSON: client.toString("base64url"), transports: ["internal"], attestationObject: Buffer.from(isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]))).toString("base64url") } };
  }
  const signature = sign("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), key.privateKey);
  return { ...base, response: { clientDataJSON: client.toString("base64url"), authenticatorData: auth.toString("base64url"), signature: signature.toString("base64url"), userHandle: null } };
}
async function fixture(t, { retired = true, pin = true } = {}) {
  let current = new Date(at);
  const store = createStore({ persistent: false }), key = passkey(), legacy = totpSecret(), deliveries = [];
  await store.transaction((s) => {
    if (retired) s.zone.authenticatorRetirement = { version: 1, retiredAt: at.toISOString() };
    s.customers.push({ id: "c1", phone: "670050001", email: "old@example.test", emailVerifiedAt: at.toISOString(), ...(pin ? { pinHash } : {}), passkeys: [key.record], totpSecret: legacy,
      recoveryCodes: [{ id: "legacy", hash: hashSecret("LEGACY-CODE", pepper) }], accountBackupCodes: [{ id: "backup", hash: backupHash }] }, { id: "c2", phone: "670050002", pinHash });
    for (const [id, customerId] of [["main", "c1"], ["other", "c1"], ["outsider", "c2"]]) s.dashboardSessions.push({ id, customerId, tokenHash: hashSecret(id, secret), csrfToken: "csrf", expiresAt: "2030-01-02T12:00:00Z" });
    s.otpChallenges.push({ id: "old-login", customerId: "c1", phone: "670050001", used: false, attempts: 0, expiresAt: "2030-01-02T12:00:00Z", createdAt: at.toISOString() });
    s.customerMfaChallenges.push({ id: "old-enrollment", customerId: "c1", sessionId: "main", secret: legacy, expiresAt: "2030-01-02T12:00:00Z" });
    s.customerPasskeyChallenges.push({ id: "old-registration", customerId: "c1", type: "registration", challenge: "old-registration", expiresAt: "2030-01-02T12:00:00Z" });
    s.vouchers.push({ id: "v1", customerId: "c1", code: "NC-AAAA-1111", status: "active", planId: "weekly", quotaBytes: null, usedBytes: 0, deviceLimit: 2, expiresAt: "2030-01-02T12:00:00Z" });
  });
  const server = createServer({ store, now: () => current, validateConfig: false, email: { configured: () => true, sendVerification: async (job) => { deliveries.push(job); return {}; }, sendPinReset: async () => ({}) }, env: {
    NODE_ENV: "production", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: origin, CUSTOMER_RP_ID: "customer.test", SECRET_PEPPER: pepper, CUSTOMER_SESSION_SECRET: secret,
    ADMIN_MFA_ENABLED: "true", ADMIN_MFA_CODE: "123456",
  } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  let cookie = "customer_session=main";
  const call = async (path, input, { session, csrf } = {}) => {
    const chosenCookie = session === undefined ? cookie : session ? `customer_session=${session}` : "", token = chosenCookie.split("=")[1] || "";
    const securityToken = csrf ?? (await store.snapshot()).dashboardSessions.find((row) => row.tokenHash === hashSecret(token, secret))?.csrfToken ?? "";
    const res = await fetch(`http://127.0.0.1:${server.address().port}` + path, { method: input === undefined ? "GET" : "POST", headers: { origin, cookie: chosenCookie, "x-csrf-token": securityToken, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (session === undefined && res.headers.get("set-cookie")) cookie = res.headers.get("set-cookie").split(";")[0];
    const text = await res.text(); return { status: res.status, body: JSON.parse(text), text, headers: res.headers };
  };
  return { store, key, legacy, call, deliveries, worker:server.listeners("request")[0].transactionalEmails, advance: (seconds) => { current = new Date(+current + seconds * 1000); } };
}

test("retirement rejects every old authenticator route and outstanding challenge without exposing a secret", async (t) => {
  const f = await fixture(t), before = await f.store.snapshot();
  for (const [path, input] of [["/api/account/login/request-authenticator", { phone: "670050001" }],
    ["/api/account/login/verify-authenticator", { challengeId: "old-login", otp: totpCode(f.legacy, +at) }],
    ["/api/account/login/verify-authenticator", { challengeId: "old-login", recoveryCode: "LEGACY-CODE" }],
    ["/api/account/security/mfa/status", undefined], ...["enroll", "replace", "resume", "options", "check", "confirm", "cancel"].map((action) => [`/api/account/security/mfa/${action}`, { challengeId: "old-enrollment", code: totpCode(f.legacy, +at), pin: "2468", otp: totpCode(f.legacy, +at) }]),
    ["/api/account/security/recovery-codes/generate", { pin: "2468", otp: totpCode(f.legacy, +at) }]]) {
    const result = await f.call(path, input); assert.equal(result.status, 410, path); assert.equal(result.body.code, "AUTHENTICATOR_RETIRED", path);
    assert.equal(result.headers.get("cache-control"), "no-store"); assert.doesNotMatch(result.text, /otpauth:|data:image|LEGACY-CODE/); assert.ok(!result.text.includes(f.legacy));
  }
  assert.equal((await f.store.snapshot()).dashboardSessions.length, before.dashboardSessions.length);
  const dashboard = await f.call("/api/account/dashboard"), security = await f.call("/api/account/security");
  assert.equal(dashboard.body.customer.authenticatorEnrolled, false); assert.equal(security.body.authenticatorEnrolled, false);
  assert.deepEqual(security.body.supportedSignInMethods, ["pin", "passkey"]); assert.equal(security.body.authenticatorRetired, true);
});

test("retired profile changes use fresh PIN/passkey while email confirmation remains independent", async (t) => {
  const f = await fixture(t);
  const email = await f.call("/api/account/profile/email", { email: "new@example.test", pin: "2468" }); assert.equal(email.status, 202);
  assert.equal(f.deliveries.length,0); await f.worker.run();
  assert.equal((await f.store.snapshot()).customers[0].email, "old@example.test"); assert.equal(f.deliveries.length, 1);
  assert.equal((await f.call("/api/account/profile/email/confirm", { code: "000000" })).status, 400);
  assert.equal((await f.call("/api/account/profile/email/confirm", { code: f.deliveries[0].code })).status, 200);
  const changed = await f.call("/api/account/profile/phone", { phone: "670050003", pin: "2468" }); assert.equal(changed.status, 200);
  const pin = await f.call("/api/account/security/pin", { currentPin: "2468", newPin: "3579", confirmPin: "3579" }); assert.equal(pin.status, 200);
  assert.equal((await f.call("/api/account/login/pin", { phone: "670050003", pin: "3579" }, { session: "" })).status, 200);
});

test("independent account backup codes still recover PIN but retired authenticator recovery codes do not", async (t) => {
  const f = await fixture(t);
  const bad = await f.call("/api/account/pin-reset/backup", { phone: "670050001", backupCode: "LEGACY-CODE", newPin: "3579", confirmPin: "3579" }, { session: "" }); assert.equal(bad.status, 401);
  const result = await f.call("/api/account/pin-reset/backup", { phone: "670050001", backupCode, newPin: "3579", confirmPin: "3579" }, { session: "" }); assert.equal(result.status, 200);
  const state = await f.store.snapshot(); assert.equal((state.customers[0].accountBackupCodes || []).length, 0); assert.equal(state.dashboardSessions.filter((s) => s.customerId === "c1").length, 0);
  assert.equal((await f.call("/api/account/login/pin", { phone: "670050001", pin: "3579" }, { session: "" })).status, 200);
});

test("retired passkey enrollment requires fresh proof and session/version-bound single-use registration", async (t) => {
  const f = await fixture(t), next = passkey();
  assert.equal((await f.call("/api/account/passkeys/options", {})).status, 401); f.advance(2);
  assert.equal((await f.call("/api/account/passkeys/options", { pin: "2468" }, { csrf: "wrong" })).status, 403);
  assert.equal((await f.call("/api/account/passkeys/verify", { challengeId: "old-registration", response: {} })).status, 400);
  const options = await f.call("/api/account/passkeys/options", { pin: "2468" }); assert.equal(options.status, 200);
  const signed = response(next, options.body.options, { registration: true, counter: 0 });
  assert.equal((await f.call("/api/account/passkeys/verify", { challengeId: options.body.challengeId, response: signed }, { session: "other" })).status, 400);
  const fresh = await f.call("/api/account/passkeys/options", { pin: "2468" });
  const enrolled = await f.call("/api/account/passkeys/verify", { challengeId: fresh.body.challengeId, response: response(next, fresh.body.options, { registration: true, counter: 0 }) });
  assert.equal(enrolled.status, 200); assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 2);
  assert.equal((await f.call("/api/account/passkeys/verify", { challengeId: fresh.body.challengeId, response: signed })).status, 400);
  const stale = await f.call("/api/account/passkeys/options", { pin: "2468" });
  await f.store.transaction((s) => { s.customers[0].pinHash = "changed-password-hash"; });
  assert.equal((await f.call("/api/account/passkeys/verify", { challengeId: stale.body.challengeId, response: response(passkey(), stale.body.options, { registration: true }) })).status, 400);
});

test("signed UV proofs enforce action/session/target binding and cannot remove the only remaining credential", async (t) => {
  const f = await fixture(t, { pin: false });
  const options = await f.call("/api/account/passkeys/proof/options", { purpose: "passkey_remove", passkeyId: f.key.record.id }); assert.equal(options.status, 200); assert.equal(options.body.options.userVerification, "required");
  const signed = response(f.key, options.body.options);
  assert.equal((await f.call("/api/account/passkeys/remove", { passkeyId: f.key.record.id, challengeId: options.body.challengeId, response: signed })).status, 409);
  const badUV = await f.call("/api/account/passkeys/proof/options", { purpose: "passkey_add" });
  assert.equal((await f.call("/api/account/passkeys/options", { challengeId: badUV.body.challengeId, response: response(f.key, badUV.body.options, { uv: false, counter: 2 }) })).status, 401);
  const otherSession = await f.call("/api/account/passkeys/proof/options", { purpose: "passkey_add" });
  assert.equal((await f.call("/api/account/passkeys/options", { challengeId: otherSession.body.challengeId, response: response(f.key, otherSession.body.options, { counter: 2 }) }, { session: "other" })).status, 401);
  const wrongPurpose = await f.call("/api/account/passkeys/proof/options", { purpose: "passkey_add" });
  assert.equal((await f.call("/api/account/passkeys/remove", { passkeyId: f.key.record.id, challengeId: wrongPurpose.body.challengeId, response: response(f.key, wrongPurpose.body.options, { counter: 2 }) })).status, 401);
  const correct = await f.call("/api/account/passkeys/proof/options", { purpose: "passkey_add" });
  const accepted = await f.call("/api/account/passkeys/options", { challengeId: correct.body.challengeId, response: response(f.key, correct.body.options, { counter: 2 }) }); assert.equal(accepted.status, 200);
  assert.equal((await f.call("/api/account/passkeys/options", { challengeId: correct.body.challengeId, response: response(f.key, correct.body.options, { counter: 3 }) })).status, 401);
});

test("fresh PIN can remove a passkey and failed commits never claim successful enrollment/removal", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/account/passkeys/remove", { passkeyId: f.key.record.id })).status, 401); f.advance(2);
  const transaction = f.store.transaction.bind(f.store); let fail = true;
  f.store.transaction = (fn, options) => transaction(async (s) => { const result = await fn(s); if (fail) { fail = false; throw Error("Synthetic passkey commit rollback"); } return result; }, options);
  const rolledBack = await f.call("/api/account/passkeys/remove", { passkeyId: f.key.record.id, pin: "2468" }); assert.ok(rolledBack.status >= 400); assert.notEqual(rolledBack.body.removed, true);
  assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 1);
  const result = await f.call("/api/account/passkeys/remove", { passkeyId: f.key.record.id, pin: "2468" }); assert.equal(result.status, 200); assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 0);
});


test("retirement cannot redirect a PIN-less account back to leftover authenticator factors", async (t) => {
  const f = await fixture(t, { pin: false });
  const login = await f.call("/api/account/login/pin", { phone: "670050001", pin: "2468" }, { session: "" });
  assert.equal(login.status, 401); assert.notEqual(login.body.authenticatorRequired, true); assert.doesNotMatch(login.body.error, /authenticator/i);
});

test("account backup generation requires a fresh supported credential and ignores leftover TOTP only after cutover", async (t) => {
  const f = await fixture(t);
  const wrong = await f.call("/api/account/security/account-backup/generate", { currentPin: "0000", otp: totpCode(f.legacy, +at) });
  assert.equal(wrong.status, 401); assert.doesNotMatch(wrong.body.error, /authenticator/i); f.advance(2);
  const generated = await f.call("/api/account/security/account-backup/generate", { currentPin: "2468" });
  assert.equal(generated.status, 200); assert.equal(generated.body.codes.length, 5); assert.equal(generated.headers.get("cache-control"), "no-store");
  const state = await f.store.snapshot();
  assert.ok(state.customers[0].accountBackupCodes.every((code) => code.hash.startsWith("$argon2id$") && !generated.body.codes.some((plain) => code.hash === plain)));
  assert.ok(state.securityAlerts.every((notice) => !JSON.stringify(notice.lines).includes("authenticator verification")));
});

test("passkey management rejects wrong target/account, expired proofs and suspended owners", async (t) => {
  const f = await fixture(t), otherKey = passkey();
  await f.store.transaction((s) => { s.customers[0].passkeys.push(otherKey.record); });
  const target = await f.call("/api/account/passkeys/proof/options", { purpose: "passkey_remove", passkeyId: f.key.record.id });
  assert.equal((await f.call("/api/account/passkeys/remove", { passkeyId: otherKey.record.id, challengeId: target.body.challengeId, response: response(f.key, target.body.options) })).status, 401);
  const crossAccount = await f.call("/api/account/passkeys/proof/options", { purpose: "passkey_add" });
  assert.equal((await f.call("/api/account/passkeys/options", { challengeId: crossAccount.body.challengeId, response: response(f.key, crossAccount.body.options) }, { session: "outsider" })).status, 401);
  const expiry = await f.call("/api/account/passkeys/proof/options", { purpose: "passkey_add" }); f.advance(301);
  assert.equal((await f.call("/api/account/passkeys/options", { challengeId: expiry.body.challengeId, response: response(f.key, expiry.body.options) })).status, 401);
  await f.store.transaction((s) => { s.customers[0].status = "suspended"; });
  for (const [path, input] of [["/api/account/passkeys/proof/options", { purpose: "passkey_add" }], ["/api/account/passkeys/options", { pin: "2468" }], ["/api/account/passkeys/remove", { passkeyId: f.key.record.id, pin: "2468" }]]) assert.equal((await f.call(path, input)).status, 403);
  assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 2);
});

test("a valid legacy registration without owner authorization cannot cross the cutover boundary", async (t) => {
  const f = await fixture(t, { retired: false }), next = passkey();
  assert.equal((await f.call("/api/account/passkeys/options", {})).status, 401, "preparation requires existing owner proof");
  f.advance(2); // Respect the shared PIN failure backoff before a correct retry.
  const before = await f.call("/api/account/passkeys/options", { pin: "2468" }); assert.equal(before.status, 200);
  // Model an old server's already-issued session-only challenge. Keep its valid
  // WebAuthn challenge/signature; only the missing legacy authority is distinct.
  await f.store.transaction((s) => {
    const challenge = s.customerPasskeyChallenges.find(c => c.id === before.body.challengeId);
    challenge.authorizationVersion = 0; delete challenge.sessionId; delete challenge.credentialVersion;
    s.zone.authenticatorRetirement = { version: 1, retiredAt: at.toISOString() };
  });
  const rejected = await f.call("/api/account/passkeys/verify", { challengeId: before.body.challengeId, response: response(next, before.body.options, { registration: true }) });
  assert.equal(rejected.status, 400); assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 1);
});

test("fresh owner-authorized supported registration remains usable across retirement", async (t) => {
  const f = await fixture(t, { retired: false }), next = passkey();
  const before = await f.call("/api/account/passkeys/options", { pin: "2468" }); assert.equal(before.status, 200);
  await f.store.transaction(s => { s.zone.authenticatorRetirement = { version: 1, retiredAt: at.toISOString() }; });
  const enrolled = await f.call("/api/account/passkeys/verify", { challengeId: before.body.challengeId, response: response(next, before.body.options, { registration: true }) });
  assert.equal(enrolled.status, 200); assert.equal((await f.store.snapshot()).customers[0].passkeys.length, 2);
});
