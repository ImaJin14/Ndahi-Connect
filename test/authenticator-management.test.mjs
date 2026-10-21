import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { totpSecret, totpCode, hashSecret } from "../lib/security.mjs";

const root = "/api/account/security/mfa";
async function fixture(t, { enrolled = true, ...options } = {}) {
  const f = await pairingFixture(options); t.after(f.close);
  const secret = totpSecret();
  if (enrolled) await f.store.transaction((s) => { s.customers[0].totpSecret = secret; });
  return { ...f, secret, code: () => totpCode(secret, +f.now()), replace: (input = {}, options) => f.call(root + "/replace", { pin: "2468", otp: totpCode(secret, +f.now()), requestKey: "a".repeat(32), ...input }, options) };
}

test("new authenticator setup remains optional, session-bound and confirmed before enabling", async (t) => {
  const f = await fixture(t, { enrolled: false });
  const setup = await f.call(root + "/enroll", {});
  assert.equal(setup.status, 200); assert.match(setup.body.qrCode, /^data:image\/png;base64,/);
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, undefined);
  assert.equal((await f.call(root + "/confirm", { code: totpCode(setup.body.secret, +f.now()) })).status, 400, "confirmation requires the exact setup intent");
  assert.equal((await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: totpCode(setup.body.secret, +f.now()) }, { session: "secondary" })).status, 400);
  assert.equal((await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: totpCode(setup.body.secret, +f.now()) })).status, 200);
});

test("replacement keeps the old app valid until new confirmation and never returns the enrolled key", async (t) => {
  const f = await fixture(t), setup = await f.replace();
  assert.equal(setup.status, 200); assert.equal(setup.body.replacement, true);
  assert.notEqual(setup.body.secret, f.secret);
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, f.secret);
  assert.equal((await f.call(root + "/check", { otp: f.code() })).status, 200);
  const status = await f.call(root + "/status");
  assert.equal(status.body.pending.challengeId, setup.body.challengeId);
  assert.doesNotMatch(JSON.stringify(status.body), new RegExp(f.secret + "|" + setup.body.secret));
  const confirm = await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: totpCode(setup.body.secret, +f.now()) });
  assert.equal(confirm.status, 200); assert.equal(confirm.body.replaced, true);
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, setup.body.secret);
  assert.equal((await f.call(root + "/check", { otp: f.code() })).status, 401);
  assert.equal((await f.call("/api/account/login/pin", { phone: "670050001", pin: "2468" })).status, 200);
});

test("existing enrollment cannot be replaced by a session or PIN alone, and CSRF/isolation remain enforced", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.replace({ otp: "", pin: "2468" })).status, 401);
  f.advance(3);
  assert.equal((await f.replace({ pin: "0000" })).status, 401);
  assert.equal((await f.replace({}, { csrf: "wrong" })).status, 403);
  assert.equal((await f.call(root + "/enroll", {})).status, 409);
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, f.secret);
});

test("lost replacement and confirmation replies recover the same bounded intent without replaying a proof", async (t) => {
  const f = await fixture(t), first = await f.replace();
  assert.equal(first.status, 200);
  const repeated = await f.replace();
  assert.equal(repeated.status, 200); assert.equal(repeated.body.secret, first.body.secret);
  const input = { challengeId: first.body.challengeId, code: totpCode(first.body.secret, +f.now()) };
  assert.equal((await f.call(root + "/confirm", input)).status, 200);
  assert.equal((await f.call(root + "/confirm", input)).status, 200);
  const s = await f.store.snapshot();
  assert.equal(s.securityAlerts.filter((n) => n.kind === "authenticator_replaced").length, 1);
  assert.equal((await f.call(root + "/status")).body.completedChallengeId, first.body.challengeId);
});

test("a consumed recovery code cannot start a second replacement but a pending setup can be resumed with owner proof", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.customers[0].recoveryCodes = [{ id: "legacy", hash: hashSecret("ABCD-2345", "pairing-tests") }]; });
  const setup = await f.replace({ otp: "", recoveryCode: "abcd 2345" });
  assert.equal(setup.status, 200);
  assert.ok((await f.store.snapshot()).customers[0].recoveryCodes[0].usedAt);
  const resume = await f.call(root + "/resume", { challengeId: setup.body.challengeId, pin: "2468" });
  assert.equal((await f.call(root + "/resume", { pin: "2468" })).status, 400);
  assert.equal(resume.status, 200); assert.equal(resume.body.secret, setup.body.secret);
  assert.equal((await f.call(root + "/resume", { challengeId: setup.body.challengeId, pin: "2468" }, { session: "secondary" })).status, 400);
  assert.equal((await f.replace({ requestKey: "b".repeat(32), otp: "", recoveryCode: "ABCD-2345" })).status, 401);
});

test("confirmation atomically invalidates old recovery codes and login challenges while preserving passkeys", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.customers[0].passkeys = [{ id: "retained-key" }]; s.customers[0].recoveryCodes = [{ id: "old-code", hash: "old" }]; });
  const login = await f.call("/api/account/login/request-authenticator", { phone: "670050001" });
  const setup = await f.replace();
  assert.equal((await f.store.snapshot()).otpChallenges.some((x) => x.id === login.body.challengeId), true);
  await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: totpCode(setup.body.secret, +f.now()) });
  const s = await f.store.snapshot();
  assert.equal(s.customers[0].recoveryCodes, undefined); assert.equal(s.otpChallenges.some((x) => x.id === login.body.challengeId), false);
  assert.equal(s.customers[0].passkeys[0].id, "retained-key");
});

test("expiry, cancellation, PIN rotation and attempt exhaustion leave the existing authenticator intact", async (t) => {
  for (const mode of ["cancel", "expiry", "pin", "attempts"]) {
    const f = await fixture(t), setup = await f.replace();
    if (mode === "cancel") await f.call(root + "/cancel", { challengeId: setup.body.challengeId });
    if (mode === "expiry") f.advance(601);
    if (mode === "pin") await f.store.transaction((s) => { s.customers[0].pinHash = "changed"; });
    if (mode === "attempts") for (let i = 0; i < 5; i++) await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: "not-a-code" });
    const result = await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: totpCode(setup.body.secret, +f.now()) });
    assert.equal(result.status, 400, mode);
    assert.equal((await f.store.snapshot()).customers[0].totpSecret, f.secret);
  }
});

test("existing sessions cannot mint recovery proofs without the old factor, but fresh enrollment can issue its first batch", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/account/security/recovery-codes/generate", {})).status, 401);
  const generated = await f.call("/api/account/security/recovery-codes/generate", { otp: f.code() });
  assert.equal(generated.status, 200); assert.equal(generated.body.codes.length, 10);
  const setup = await f.replace({ otp: "", recoveryCode: generated.body.codes[0] });
  assert.equal(setup.status, 200);
  await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: totpCode(setup.body.secret, +f.now()) });
  assert.equal((await f.call("/api/account/security/recovery-codes/generate", {})).status, 200);
});

test("private management and support-recovery fields never appear in the customer dashboard", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.customers[0].authenticatorRecoveryPermit = { tokenHash: "private-permit" }; });
  await f.replace();
  const dashboard = await f.call("/api/account/dashboard");
  assert.doesNotMatch(JSON.stringify(dashboard.body), /private-permit|mfaProofs|authenticatorRecoveryPermit|originalVersion|mfaCompletion/);
});

test("replacement confirmation does not report success or change enrollment when storage commit rolls back", async (t) => {
  const f = await fixture(t), setup = await f.replace();
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (fn, ...args) => transaction(async (s) => {
    const out = await fn(s);
    if (s.customers[0].totpSecret !== f.secret) throw Error("Synthetic commit failure");
    return out;
  }, ...args);
  const response = await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: totpCode(setup.body.secret, +f.now()) });
  assert.notEqual(response.status, 200);
  assert.notEqual(response.body.mfaEnabled, true);
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, f.secret);
  f.store.transaction = transaction;
  assert.equal((await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: totpCode(setup.body.secret, +f.now()) })).status, 200);
});

test("support replacement requires an owner, fresh administrator proof and recorded identity verification without resetting the app", async (t) => {
  const f = await fixture(t, { env: { ADMIN_SESSION_SECRET: "pairing-tests", ADMIN_APP_URL: "http://customer.test", ALLOWED_ADMIN_ORIGINS: "http://customer.test" } });
  await f.store.transaction((s) => {
    for (const role of ["owner", "operator"]) {
      s.adminUsers.push({ id: role, username: role, role, active: true, passwordHash: s.customers[0].pinHash });
      s.adminSessions.push({ userId: role, role, tokenHash: hashSecret(role, "pairing-tests"), csrfToken: "admin-csrf", expiresAt: new Date(+f.now() + 3600000).toISOString() });
    }
  });
  const issue = async (role, input = {}) => {
    const response = await fetch(f.api + "/api/admin/customers/recovery", { method: "POST", headers: { origin: "http://customer.test", "content-type": "application/json", cookie: "admin_session=" + role, "x-csrf-token": "admin-csrf" },
      body: JSON.stringify({ customerId: "c1", purpose: "authenticator", caseReference: "CASE-MFA-60", reason: "Customer identity verified at the support desk", verificationMethod: "in_person", confirmedIdentity: true, password: "2468", ...input }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await issue("operator")).status, 403);
  assert.equal((await issue("owner", { confirmedIdentity: false })).status, 400);
  assert.equal((await issue("owner", { password: "incorrect" })).status, 400);
  assert.equal((await f.store.snapshot()).dashboardSessions.length, 3);
  const support = await issue("owner");
  assert.equal(support.status, 200); assert.equal(support.body.purpose, "authenticator");
  let s = await f.store.snapshot();
  assert.equal(s.customers[0].totpSecret, f.secret);
  assert.equal(s.dashboardSessions.some((a) => a.customerId === "c1"), false);
  assert.doesNotMatch(JSON.stringify(s.customers[0]), new RegExp(support.body.recoveryCode));
  const login = await f.call("/api/account/login/pin", { phone: "670050001", pin: "2468" });
  assert.equal(login.status, 200);
  const session = login.headers.get("set-cookie").split(";")[0].slice("customer_session=".length);
  const dashboard = await f.call("/api/account/dashboard", undefined, { session });
  const options = { session, csrf: dashboard.body.csrfToken };
  const setup = await f.call(root + "/replace", { pin: "2468", supportCode: support.body.recoveryCode, requestKey: "b".repeat(32) }, options);
  assert.equal(setup.status, 200);
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, f.secret);
  assert.equal((await f.call(root + "/replace", { pin: "2468", supportCode: support.body.recoveryCode, requestKey: "c".repeat(32) }, options)).status, 401);
  assert.equal((await f.call(root + "/confirm", { challengeId: setup.body.challengeId, code: totpCode(setup.body.secret, +f.now()) }, options)).status, 200);
  s = await f.store.snapshot();
  assert.equal(s.customers[0].totpSecret, setup.body.secret);
  assert.ok(s.auditLogs.some((entry) => entry.action === "customer.authenticator_recovery.approved"));
});
