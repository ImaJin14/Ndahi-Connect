import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import argon2 from "argon2";
import { authenticationReadiness, readinessDigest, recordVerifiedMethod } from "../lib/authentication-migration.mjs";
import { AuthenticatorRetirementError, retireAuthenticatorState } from "../lib/authenticator-retirement.mjs";
import { parseRetirementArguments, runAuthenticatorRetirement } from "../scripts/authenticator-retirement.mjs";
import { blank, createStore } from "../lib/api/state.mjs";

const pepper = "retirement-unit-fixture-pepper", now = new Date("2030-01-01T12:00:00Z");
const hashing = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const pinHash = await argon2.hash("2468", hashing), passwordHash = await argon2.hash("retained administrator password", hashing);
const backupHash = await argon2.hash("NC-REC-independent-pin-backup", hashing);
const proof = (s) => authenticationReadiness(s, { pepper, now });
const apply = (s, options = {}) => retireAuthenticatorState(s, { pepper, now, expectedDigest: proof(s).digest, ...options });

function fixture() {
  const s = blank();
  s.customers.push({ id: "customer-1", phone: "670019999", name: "Retirement Customer", status: "active", pinHash,
    passkeys: [{ id: "retained-passkey", publicKey: "retained-public-key-material", counter: 0 }],
    totpSecret: "FACTOR-SECRET-MUST-NOT-LEAK", totpEnrolledAt: "2029-01-01T00:00:00Z",
    recoveryCodes: [{ id: "factor-recovery", argon2Hash: "legacy-factor-recovery-hash" }],
    authenticatorRecoveryPermit: { tokenHash: "factor-support-permit" }, mfaProofs: [{ hash: "factor-replay-hash" }],
    mfaCompletion: { id: "completed-factor-setup" }, mfaCheck: { attempts: 2 },
    accountBackupCodes: [{ id: "account-backup", hash: backupHash }], backupCodesGeneratedAt: "2029-12-31T00:00:00Z",
    pendingEmail: { email: "new@example.test", codeHash: "email-verification-hash" },
    wifiMainDevice: { mac: "AA:BB:CC:DD:EE:01", id: "main-device" } });
  s.adminUsers.push({ id: "owner-1", username: "owner", active: true, role: "owner", passwordHash,
    passkeys: [{ id: "admin-retained-key", publicKey: "admin-retained-public-key", counter: 0 }] });
  s.adminProfile = { displayName: "Retained administrator settings", mfaEnabled: true, totpSecret: "ADMIN-FACTOR-SECRET", mfaCodeHash: "legacy-static-factor-hash" };
  s.dashboardSessions.push({ id: "customer-session", customerId: "customer-1", csrfToken: "retained-csrf", currentWifi: { mac: "AA:BB:CC:DD:EE:01" },
    mfaRecoveryGrant: { token: "factor-generation-grant" }, authMigrationIntent: { hash: "pending-factor-derived-pin" } });
  s.adminSessions.push({ tokenHash: "retained-admin-session", userId: "owner-1", mfaRecoveryGrant: { token: "old-factor-grant" } });
  s.customerMfaChallenges.push({ id: "factor-enrollment", customerId: "customer-1", secret: "PENDING-FACTOR-SECRET" });
  s.otpChallenges.push({ id: "factor-login", customerId: "customer-1", attempts: 0 });
  s.adminMfaChallenges.push({ id: "admin-factor-enrollment", secret: "ADMIN-PENDING-FACTOR" });
  s.adminLoginChallenges.push({ id: "issued-admin-factor-login", userId: "owner-1" });
  s.customerPasskeyChallenges.push(...["authenticator_replace", "authenticator_resume", "migration_enroll_pin", "migration_confirm", "registration", "login", "email_change", "phone_change", "pin_change", "account_backup"].map(type => ({ id: `customer-${type}`, type })));
  s.adminPasskeyChallenges.push(...["sensitive:migration_confirm", "sensitive:auth_cutover_attestation", "registration", "login", "sensitive:admin_password_change"].map(type => ({ id: `admin-${type}`, type })));
  s.pinResetChallenges.push({ id: "pin-reset", phone: "670019999", codeHash: "pin-email-code" });
  s.customerAccessChallenges.push({ id: "voucher-admission", voucherId: "voucher-1", tokenHash: "access-challenge-hash" });
  s.wifiPairingRequests.push({ id: "pair-request", codeHash: "main-device-access-code", status: "awaiting_code" });
  s.wifiDeviceGrants.push({ id: "wifi-grant", customerId: "customer-1", mac: "AA:BB:CC:DD:EE:01", state: "approved" });
  s.vouchers.push({ id: "voucher-1", customerId: "customer-1", code: "NC-AAAA-1111", status: "active", wifiDevices: [{ mac: "AA:BB:CC:DD:EE:01" }] });
  s.sessions.push({ id: "router-session", customerId: "customer-1", status: "online" });
  s.payments.push({ id: "payment-1", customerId: "customer-1", status: "successful" });
  s.routerCommands.push({ id: "router-command", action: "sync_usage" });
  s.wifiAppAssociations = [{ id: "installed-app", customerId: "customer-1", mac: "AA:BB:CC:DD:EE:01" }];
  recordVerifiedMethod(s.customers[0], "pin", null, pepper, now);
  recordVerifiedMethod(s.adminUsers[0], "password", null, pepper, now);
  review(s);
  return s;
}

function review(s, extra = {}) {
  s.zone.authenticationMigrationReview = { version: 1, digest: readinessDigest(s, pepper), rollbackRevision: "a".repeat(40),
    evidenceReference: "STAGING-RECOVERY-AUTH-PILOT-82", supportRecoveryVerified: true, authenticationPilotVerified: true,
    at: now.toISOString(), ...extra };
}

test("retirement removes only inventoried authenticator material and preserves supported credentials/account/Wi-Fi state", async () => {
  const s = fixture(), before = structuredClone(s), digest = proof(s).digest;
  assert.equal(proof(s).ready, true);
  const result = apply(s);
  assert.equal(result.applied, true);
  assert.equal(s.zone.authenticatorRetirement.version, 1);
  assert.equal(s.zone.authenticatorRetirement.readinessDigest, digest);
  assert.equal(s.zone.authenticatorRetirement.rollbackRevision, "a".repeat(40));
  assert.equal(s.zone.authenticatorRetirement.evidenceReference, "STAGING-RECOVERY-AUTH-PILOT-82");
  const customer = s.customers[0];
  for (const field of ["totpSecret", "totpEnrolledAt", "recoveryCodes", "authenticatorRecoveryPermit", "mfaProofs", "mfaCompletion", "mfaCheck"]) assert.equal(Object.hasOwn(customer, field), false, field);
  for (const field of ["totpSecret", "mfaEnabled", "mfaCodeHash"]) assert.equal(Object.hasOwn(s.adminProfile, field), false, field);
  assert.equal(s.adminProfile.displayName, before.adminProfile.displayName);
  assert.equal(await argon2.verify(customer.pinHash, "2468"), true);
  assert.equal(await argon2.verify(s.adminUsers[0].passwordHash, "retained administrator password"), true);
  assert.deepEqual(customer.passkeys, before.customers[0].passkeys);
  assert.deepEqual(s.adminUsers[0].passkeys, before.adminUsers[0].passkeys);
  assert.deepEqual(customer.accountBackupCodes, before.customers[0].accountBackupCodes);
  assert.equal(await argon2.verify(customer.accountBackupCodes[0].hash, "NC-REC-independent-pin-backup"), true);
  assert.deepEqual(customer.pendingEmail, before.customers[0].pendingEmail);
  assert.deepEqual(customer.wifiMainDevice, before.customers[0].wifiMainDevice);
  for (const key of ["pinResetChallenges", "customerAccessChallenges", "wifiPairingRequests", "wifiDeviceGrants", "wifiAppAssociations", "sessions", "vouchers", "payments", "routerCommands"]) assert.deepEqual(s[key], before[key], key);
  assert.deepEqual(s.dashboardSessions[0].currentWifi, before.dashboardSessions[0].currentWifi);
  assert.equal(s.dashboardSessions[0].csrfToken, before.dashboardSessions[0].csrfToken);
  assert.equal(s.adminSessions[0].tokenHash, before.adminSessions[0].tokenHash);
  assert.doesNotMatch(JSON.stringify(result), /FACTOR-SECRET|FACTOR-SECRET|670019999|legacy-factor-recovery-hash|factor-generation-grant|NC-AAAA|\$argon2/);
});

test("all issued factor grants/challenges and factor-specific passkey proofs are invalidated without erasing unrelated proofs", () => {
  const s = fixture(); apply(s);
  for (const collection of ["customerMfaChallenges", "otpChallenges", "adminMfaChallenges", "adminLoginChallenges"]) assert.deepEqual(s[collection], [], collection);
  for (const row of [...s.dashboardSessions, ...s.adminSessions]) {
    assert.equal(Object.hasOwn(row, "mfaRecoveryGrant"), false);
    assert.equal(Object.hasOwn(row, "authMigrationIntent"), false);
  }
  assert.deepEqual(s.customerPasskeyChallenges.map(ch => ch.type), ["registration", "login", "email_change", "phone_change", "pin_change", "account_backup"]);
  assert.deepEqual(s.adminPasskeyChallenges.map(ch => ch.type), ["registration", "login", "sensitive:admin_password_change"]);
});

test("no configured credential alone, stale proof or unreviewed recovery can open the retirement gate", async (t) => {
  const cases = [
    ["customer unverified", s => { delete s.customers[0].authMigration; }],
    ["customer credential changed", s => { s.customers[0].pinHash = passwordHash; }],
    ["customer no retained credential", s => { delete s.customers[0].pinHash; s.customers[0].passkeys = []; }],
    ["admin unverified", s => { delete s.adminUsers[0].authMigration; }],
    ["admin changed password", s => { s.adminUsers[0].passwordHash = pinHash; }],
    ["no active owner", s => { s.adminUsers[0].active = false; }],
    ["recovery unreviewed", s => { s.zone.authenticationMigrationReview.supportRecoveryVerified = false; }],
    ["pilot unreviewed", s => { s.zone.authenticationMigrationReview.authenticationPilotVerified = false; }],
    ["rollback missing", s => { delete s.zone.authenticationMigrationReview.rollbackRevision; }],
    ["invalid rollback SHA", s => { s.zone.authenticationMigrationReview.rollbackRevision = "main"; }],
    ["review expired", s => { s.zone.authenticationMigrationReview.at = "2029-01-01T00:00:00Z"; }],
    ["review in future", s => { s.zone.authenticationMigrationReview.at = "2040-01-01T00:00:00Z"; }],
    ["review missing", s => { delete s.zone.authenticationMigrationReview; }],
  ];
  for (const [name, change] of cases) await t.test(name, () => {
    const s = fixture(); change(s); const before = structuredClone(s);
    assert.equal(proof(s).ready, false);
    assert.throws(() => apply(s), error => error instanceof AuthenticatorRetirementError && error.code === "READINESS_REQUIRED");
    assert.deepEqual(s, before);
  });
});

test("cutover requires the exact reviewed digest and changes nothing if inventory changed after a report", () => {
  const s = fixture(), digest = proof(s).digest;
  for (const expectedDigest of [undefined, "", "not-a-digest"]) assert.throws(() => apply(s, { expectedDigest }), { code: "EXPECTED_DIGEST_REQUIRED" });
  s.customers[0].pinHash = passwordHash;
  const before = structuredClone(s);
  assert.throws(() => apply(s, { expectedDigest: digest }), { code: "READINESS_CHANGED" });
  assert.deepEqual(s, before);
  assert.equal(s.zone.authenticatorRetirement, undefined);
});

test("retirement is idempotent and does not reuse an obsolete readiness report or alter newer account activity", () => {
  const s = fixture(), digest = proof(s).digest, first = apply(s);
  s.payments.push({ id: "post-retirement-payment" });
  const before = structuredClone(s), second = apply(s, { expectedDigest: digest, now: new Date(+now + 86400000) });
  assert.equal(second.applied, false); assert.equal(second.alreadyRetired, true);
  assert.equal(second.retiredAt, first.retiredAt);
  assert.deepEqual(s, before);
});

test("retirement handles absent/partial legacy factor fields and rejects unsupported future migration versions", () => {
  const s = fixture();
  delete s.customers[0].mfaProofs; delete s.adminProfile; delete s.customerMfaChallenges; delete s.adminMfaChallenges;
  s.adminUsers[0].totpSecret = "imported-factor-secret";
  assert.equal(apply(s).applied, true);
  assert.equal(s.adminUsers[0].totpSecret, undefined);
  const before = structuredClone(s);
  assert.equal(apply(s).alreadyRetired, true);
  assert.deepEqual(s, before);
  s.zone.authenticatorRetirement.version = 2;
  assert.throws(() => apply(s), { code: "UNSUPPORTED_RETIREMENT_VERSION" });
});

test("default runner is read-only and apply rechecks readiness inside the global committed transaction", async () => {
  let state = fixture(), snapshots = 0, transactions = 0;
  const digest = proof(state).digest;
  const store = { snapshot: async () => { snapshots++; return structuredClone(state); }, transaction: async fn => {
    transactions++; const draft = structuredClone(state), result = fn(draft); state = draft; return result;
  } };
  const report = await runAuthenticatorRetirement({ store, pepper, now: () => now });
  assert.equal(report.mode, "report"); assert.equal(report.readiness.ready, true);
  assert.equal(snapshots, 1); assert.equal(transactions, 0); assert.equal(state.customers[0].totpSecret, "FACTOR-SECRET-MUST-NOT-LEAK");
  state.adminUsers[0].passwordHash = pinHash;
  const before = structuredClone(state);
  await assert.rejects(runAuthenticatorRetirement({ store, pepper, now: () => now, apply: true, expectedDigest: digest }), { code: "READINESS_CHANGED" });
  assert.equal(transactions, 1); assert.deepEqual(state, before);
});

test("retirement emits no successful result on commit rollback and later succeeds atomically", async () => {
  const store = createStore({ persistent: false });
  await store.transaction(s => Object.assign(s, fixture()));
  const before = await store.snapshot(), original = store.transaction.bind(store);
  store.transaction = fn => original(async s => { await fn(s); throw Error("Synthetic commit failure"); });
  await assert.rejects(runAuthenticatorRetirement({ store, pepper, now: () => now, apply: true, expectedDigest: proof(before).digest }), /Synthetic commit failure/);
  assert.deepEqual(await store.snapshot(), before);
  store.transaction = original;
  const result = await runAuthenticatorRetirement({ store, pepper, now: () => now, apply: true, expectedDigest: proof(before).digest });
  assert.equal(result.applied, true);
  assert.equal((await store.snapshot()).zone.authenticatorRetirement.version, 1);
});

test("queued credential rotation wins before cutover and invalidates the earlier readiness report", async () => {
  const store = createStore({ persistent: false });
  await store.transaction(s => Object.assign(s, fixture()));
  const digest = proof(await store.snapshot()).digest;
  let allowRotation, entered;
  const waiting = new Promise(resolve => { allowRotation = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const rotation = store.transaction(async s => { entered(); await waiting; s.customers[0].pinHash = passwordHash; });
  await started;
  const cutover = runAuthenticatorRetirement({ store, pepper, now: () => now, apply: true, expectedDigest: digest });
  const denied = assert.rejects(cutover, { code: "READINESS_CHANGED" });
  allowRotation(); await rotation; await denied;
  const current = await store.snapshot();
  assert.equal(current.customers[0].pinHash, passwordHash);
  assert.equal(current.customers[0].totpSecret, "FACTOR-SECRET-MUST-NOT-LEAK");
  assert.equal(current.zone.authenticatorRetirement, undefined);
});

test("CLI arguments require explicit apply and an exact expected digest", () => {
  assert.deepEqual(parseRetirementArguments([]), { apply: false });
  for (const args of [["--apply"], ["--apply", "--expected-digest", "bad"], ["--file"], ["--force"], ["--file", "a", "--file", "b"]]) assert.throws(() => parseRetirementArguments(args), AuthenticatorRetirementError);
  assert.deepEqual(parseRetirementArguments(["--file", "state.json", "--apply", "--expected-digest", "a".repeat(64)]), { file: "state.json", apply: true, expectedDigest: "a".repeat(64) });
});

test("CLI defaults to an aggregate read-only file report and fails closed without readiness or matching digest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ndahi-retirement-cli-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "db.json"), initial = fixture();
  // Real CLI time differs from deterministic tests; a current owner attestation
  // is required rather than weakening the expiry gate for a CLI fixture.
  const actualNow = new Date();
  recordVerifiedMethod(initial.customers[0], "pin", null, pepper, actualNow);
  recordVerifiedMethod(initial.adminUsers[0], "password", null, pepper, actualNow);
  review(initial, { at: actualNow.toISOString() });
  const serialized = JSON.stringify(initial); await writeFile(file, serialized);
  const call = args => spawnSync(process.execPath, ["scripts/authenticator-retirement.mjs", "--file", file, ...args], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env, SECRET_PEPPER: pepper },
  });
  const report = call([]); assert.equal(report.status, 0, report.stderr);
  assert.ok(report.stdout.length, JSON.stringify({ status: report.status, signal: report.signal, stderr: report.stderr, error: report.error?.code }));
  const body = JSON.parse(report.stdout); assert.equal(body.mode, "report"); assert.equal(body.readiness.ready, true);
  assert.equal(await readFile(file, "utf8"), serialized);
  assert.doesNotMatch(report.stdout, /FACTOR-SECRET|670019999|NC-AAAA|\$argon2|new@example.test/);
  const noDigest = call(["--apply"]); assert.equal(noDigest.status, 1); assert.equal(JSON.parse(noDigest.stderr).code, "EXPECTED_DIGEST_REQUIRED");
  assert.equal(await readFile(file, "utf8"), serialized);
  const stale = call(["--apply", "--expected-digest", "a".repeat(64)]); assert.equal(stale.status, 1); assert.equal(JSON.parse(stale.stderr).code, "READINESS_CHANGED");
  assert.equal(await readFile(file, "utf8"), serialized);
  const success = call(["--apply", "--expected-digest", body.readiness.digest]); assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).applied, true);
  const migrated = JSON.parse(await readFile(file, "utf8")); assert.equal(migrated.customers[0].totpSecret, undefined);
  assert.equal(migrated.zone.authenticatorRetirement.version, 1);
  const repeated = call(["--apply", "--expected-digest", body.readiness.digest]); assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).alreadyRetired, true);
});
