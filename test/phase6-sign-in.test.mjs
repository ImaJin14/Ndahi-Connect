// Phase 6 sign-in (docs/redesign/decisions.md): staff sign in with email + PIN,
// then confirm with a passkey; an administrator without one adds it to finish
// (offered before the cutover, required after); owners remove lost passkeys.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import argon2 from "argon2";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";

const pin = "482913", secret = "pairing-tests", origin = "http://customer.test", rpID = "customer.test";
const pinHash = await argon2.hash(pin, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const hash = (value) => createHash("sha256").update(value).digest();
function keyFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), jwk = publicKey.export({ format: "jwk" });
  const publicCose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]]));
  const idBytes = randomBytes(32), id = idBytes.toString("base64url"); let counter = 0;
  const client = (options, type) => Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false }));
  return {
    key: { id, publicKey: Buffer.from(publicCose).toString("base64url"), counter: 0, transports: ["internal"] },
    assertion(options) {
      const data = client(options, "webauthn.get"), count = Buffer.alloc(4); count.writeUInt32BE(++counter);
      const auth = Buffer.concat([hash(rpID), Buffer.from([5]), count]);
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

async function fixture(t, { retired = false } = {}) {
  const f = await pairingFixture({ env: { ADMIN_APP_URL: origin, ALLOWED_ADMIN_ORIGINS: origin, ADMIN_SESSION_SECRET: secret, WEBAUTHN_RP_ID: rpID } }); t.after(f.close);
  const owner = keyFixture(), staff = keyFixture();
  await f.store.transaction((s) => {
    s.adminUsers.push(
      { id: "owner-6", username: "owner", email: "owner@ndahi.test", active: true, role: "owner", pinHash, passwordHash: pinHash, passkeys: [owner.key] },
      { id: "staff-6", username: "brenda", active: true, role: "operator", pinHash, passwordHash: pinHash, passkeys: [staff.key] },
      { id: "new-6", username: "eric", email: "eric@ndahi.test", active: true, role: "operator", pinHash, passwordHash: pinHash, passkeys: [] },
    );
    s.adminSessions.push(
      { userId: "owner-6", tokenHash: hashSecret("owner-6", secret), role: "owner", csrfToken: "admin-csrf", expiresAt: new Date(+f.now() + 3600000).toISOString() },
      { userId: "staff-6", tokenHash: hashSecret("staff-6", secret), role: "operator", csrfToken: "staff-csrf", expiresAt: new Date(+f.now() + 3600000).toISOString() },
    );
    if (retired) s.zone = { ...(s.zone || {}), authenticatorRetirement: { version: 1, retiredAt: f.now().toISOString() } };
  });
  const request = async (path, input, headers = {}) => {
    const response = await fetch(f.api + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") || "" };
  };
  const call = (path, input, token = "owner-6", csrf = "admin-csrf") => request(path, input, { cookie: `admin_session=${token}`, "x-csrf-token": csrf });
  // A sensitive change confirmed with the acting administrator's passkey.
  const prove = async (purpose, input, key = owner, token = "owner-6", csrf = "admin-csrf") => {
    const options = await call("/api/admin/profile/proof/options", { ...input, purpose }, token, csrf);
    assert.equal(options.status, 200, JSON.stringify(options.body));
    return { challengeId: options.body.challengeId, response: key.assertion(options.body.options) };
  };
  return { ...f, request, call, prove, owner, staff };
}

test("email + PIN leads to the passkey step, and only the passkey opens a session", async (t) => {
  const f = await fixture(t);
  const first = await f.request("/api/admin/login", { email: "Owner@NDAHI.test", pin });
  assert.equal(first.status, 200);
  assert.equal(first.body.authenticated, false);
  assert.equal(first.body.step, "passkey");
  assert.equal(first.cookie, "", "no session after the PIN alone");
  const wrong = await f.request("/api/admin/login/passkey", { challengeId: first.body.challengeId, stepToken: "not-the-token", response: f.owner.assertion(first.body.options) });
  assert.equal(wrong.status, 401);
  // The step is single use: a failed attempt ends it.
  const replay = await f.request("/api/admin/login/passkey", { challengeId: first.body.challengeId, stepToken: first.body.stepToken, response: f.owner.assertion(first.body.options) });
  assert.equal(replay.status, 401);
  const again = await f.request("/api/admin/login", { username: "owner", pin });
  const done = await f.request("/api/admin/login/passkey", { challengeId: again.body.challengeId, stepToken: again.body.stepToken, response: f.owner.assertion(again.body.options) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.authenticated, true);
  assert.match(done.cookie, /admin_session=/);
  const wrongPin = await f.request("/api/admin/login", { email: "owner@ndahi.test", pin: "000000" });
  assert.equal(wrongPin.status, 401);
});

test("before the cutover a PIN-only administrator signs in and is offered a passkey; after it, adds one to finish", async (t) => {
  const before = await fixture(t);
  const open = await before.request("/api/admin/login", { email: "eric@ndahi.test", pin });
  assert.equal(open.status, 200);
  assert.equal(open.body.authenticated, true);
  assert.equal(open.body.passkeySetup, "recommended");
  const after = await fixture(t, { retired: true });
  const setup = await after.request("/api/admin/login", { email: "eric@ndahi.test", pin });
  assert.equal(setup.body.step, "passkey_setup");
  assert.equal(setup.cookie, "");
  const fresh = keyFixture();
  const done = await after.request("/api/admin/login/passkey-setup", { challengeId: setup.body.challengeId, stepToken: setup.body.stepToken, response: fresh.registration(setup.body.options) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.cookie, /admin_session=/);
  assert.equal((await after.store.snapshot()).adminUsers.find((user) => user.id === "new-6").passkeys.length, 1);
  // After the cutover a passkey confirms the PIN; it no longer signs in alone.
  const alone = await after.request("/api/admin/passkey/options", { username: "owner" });
  assert.equal(alone.status, 409);
  assert.equal(alone.body.code, "PIN_STEP_REQUIRED");
});

test("staff set their own sign-in email, unique across administrators", async (t) => {
  const f = await fixture(t);
  const proof = await f.prove("email_change", { email: "brenda@ndahi.test" }, f.staff, "staff-6", "staff-csrf");
  const set = await f.call("/api/admin/profile/email", { email: "Brenda@NDAHI.test", ...proof }, "staff-6", "staff-csrf");
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.email, "brenda@ndahi.test");
  const taken = await f.call("/api/admin/profile/email", { email: "owner@ndahi.test" }, "staff-6", "staff-csrf");
  assert.equal(taken.status, 409);
  assert.equal((await f.request("/api/admin/login", { email: "brenda@ndahi.test", pin })).body.step, "passkey");
});

test("an owner removes a staff member's lost passkeys and signs them out", async (t) => {
  const f = await fixture(t);
  const denied = await f.call("/api/admin/users/passkeys/remove", { userId: "owner-6" }, "staff-6", "staff-csrf");
  assert.equal(denied.status, 403);
  const self = await f.call("/api/admin/users/passkeys/remove", { userId: "owner-6" });
  assert.equal(self.status, 409);
  const proof = await f.prove("staff_passkeys_remove", { userId: "staff-6" });
  const removed = await f.call("/api/admin/users/passkeys/remove", { userId: "staff-6", ...proof });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.removed, 1);
  const s = await f.store.snapshot();
  assert.equal(s.adminUsers.find((user) => user.id === "staff-6").passkeys.length, 0);
  assert.equal(s.adminSessions.some((session) => session.userId === "staff-6"), false);
  assert.ok(s.auditLogs.some((entry) => entry.action === "admin.user_passkeys_removed" || entry.event === "admin.user_passkeys_removed" || JSON.stringify(entry).includes("admin.user_passkeys_removed")));
});

test("support removes a customer's lost passkeys after the recorded identity check", async (t) => {
  const f = await fixture(t), customerKey = keyFixture();
  await f.store.transaction((s) => { s.customers[0].passkeys = [customerKey.key]; });
  const customerId = (await f.store.snapshot()).customers[0].id;
  const fields = { customerId, caseReference: "CASE-2026-61", reason: "Phone lost; customer verified at the office.", verificationMethod: "in_person", confirmedIdentity: true };
  const missing = await f.call("/api/admin/customers/recovery", { customerId, purpose: "passkeys" });
  assert.equal(missing.status, 400, "the case and identity check are required");
  const proof = await f.prove("support_recovery", { ...fields, recoveryPurpose: "passkeys" });
  const removed = await f.call("/api/admin/customers/recovery", { ...fields, purpose: "passkeys", ...proof });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.removed, 1);
  const s = await f.store.snapshot(), customer = s.customers.find((c) => c.id === customerId);
  assert.equal(customer.passkeys.length, 0);
  assert.ok(customer.pinHash, "the PIN stays, so the customer can sign in");
  assert.equal(s.dashboardSessions.some((session) => session.customerId === customerId), false);
  assert.ok(JSON.stringify(s).includes("Passkeys were removed from your NDAHI account"));
});
