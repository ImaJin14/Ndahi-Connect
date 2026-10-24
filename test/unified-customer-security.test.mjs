import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { securityKey, securityAssertion } from "./helpers/customer-security-key.mjs";
const pin = "/api/account/security/pin", backup = "/api/account/security/account-backup", passkeys = "/api/account/passkeys";
const actionId = "a".repeat(32), receipt = "/api/account/security/actions/" + actionId;
const change = { currentPin: "2468", newPin: "5830", confirmPin: "5830", operationId: actionId };
async function fixture(t) { const f = await pairingFixture(); t.after(f.close); return f; }
const token = response => response.headers.get("set-cookie").match(/customer_session=([^;]+)/)[1];

test("unified PIN change verifies current proof, hashes the PIN, rotates sessions and confirms only to the new session", async t => {
  const f = await fixture(t), before = await f.store.snapshot();
  await f.store.transaction(s => { s.customers[0].accountBackupCodes = [{ hash: "old" }]; });
  assert.equal((await f.call(pin, change, { csrf: "wrong" })).status, 403);
  assert.equal((await f.call(pin, { ...change, currentPin: "1111" })).status, 401); f.advance(2);
  const result = await f.call(pin, change); assert.equal(result.status, 200);
  const s = await f.store.snapshot(), c = s.customers[0];
  assert.equal(await argon2.verify(c.pinHash, "5830"), true); assert.match(c.pinHash, /^\$argon2id\$/);
  assert.notEqual(c.pinHash, before.customers[0].pinHash); assert.equal(c.accountBackupCodes, undefined);
  assert.equal(s.dashboardSessions.filter(x => x.customerId === c.id).length, 1);
  assert.deepEqual(s.vouchers, before.vouchers); assert.deepEqual(c.wifiMainDevice, before.customers[0].wifiMainDevice);
  assert.equal((await f.call(receipt)).status, 401);
  const confirmed = await f.call(receipt, undefined, { session: token(result) });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.action, "pin_change");
  assert.deepEqual(Object.keys(confirmed.body).sort(), ["action", "completed", "completedAt"]);
});

test("security receipts are bounded, expire, require the initiating session and contain no proof or backup codes", async t => {
  const f = await fixture(t), generated = await f.call(backup + "/generate", { currentPin: "2468", operationId: actionId });
  assert.equal(generated.status, 200); assert.equal(generated.body.codes.length, 5);
  assert.equal((await f.call(receipt, undefined, { session: "secondary" })).status, 404);
  assert.equal((await f.call(receipt, undefined, { session: "other" })).status, 404);
  const status = await f.call(receipt); assert.equal(status.headers.get("cache-control"), "no-store"); assert.equal(status.body.action, "backup_generate");
  assert.ok(generated.body.codes.every(code => !JSON.stringify(status.body).includes(code)));
  f.advance(601); assert.equal((await f.call(receipt)).status, 404);
});

test("backup codes retain one-use PIN recovery and cannot substitute for current proof in settings", async t => {
  const f = await fixture(t), generated = await f.call(backup + "/generate", { currentPin: "2468" }), code = generated.body.codes[0];
  assert.equal((await f.call(pin, { ...change, currentPin: undefined, backupCode: code })).status, 401);
  const input = { phone: "670050001", backupCode: code, newPin: "5830", confirmPin: "5830" };
  assert.equal((await f.call("/api/account/pin-reset/backup", input, { session: "" })).status, 200);
  assert.equal((await f.call("/api/account/pin-reset/backup", input, { session: "" })).status, 401);
  const s = await f.store.snapshot(); assert.equal(s.customers[0].accountBackupCodes, undefined); assert.equal(s.dashboardSessions.some(x => x.customerId === "c1"), false);
});

test("wrong PIN proofs are rate limited without changing the credential", async t => {
  const f = await fixture(t), initial = (await f.store.snapshot()).customers[0].pinHash;
  for (let i = 0; i < 5; i++) { f.advance(60); assert.ok([401,429].includes((await f.call(pin, { ...change, currentPin: "1111" })).status)); }
  assert.equal((await f.call(pin, change)).status, 429); assert.equal((await f.store.snapshot()).customers[0].pinHash, initial);
});

for (const mode of ["target", "session", "purpose", "expiry", "origin", "rp", "uv", "credential"]) test(`PIN passkey proof rejects ${mode} mismatch and consumes the attempted challenge`, async t => {
  const f = await fixture(t), key = securityKey(); await f.store.transaction(s => { s.customers[0].passkeys = [key.record]; });
  const options = await f.call(mode === "purpose" ? backup + "/options" : pin + "/options", { newPin: "5830", confirmPin: "5830" }); assert.equal(options.status, 200);
  if (mode === "expiry") f.advance(301);
  if (mode === "credential") await f.store.transaction(s => { s.customers[0].pinHash = "changed-credential"; });
  const input = { ...change, currentPin: undefined, challengeId: options.body.challengeId, response: securityAssertion(key, options.body.options, { origin: mode === "origin" ? "https://attacker.test" : undefined, rpID: mode === "rp" ? "attacker.test" : undefined, uv: mode !== "uv" }) };
  if (mode === "target") input.newPin = input.confirmPin = "1357";
  const result = await f.call(pin, input, mode === "session" ? { session: "secondary" } : {}); assert.equal(result.status, 401);
  const s = await f.store.snapshot(); assert.equal(s.customerPasskeyChallenges.some(x => x.id === options.body.challengeId), false);
  assert.equal(s.customers[0].pinFailures, undefined, "a failed passkey must not lock PIN sign-in");
  assert.equal((await f.call(pin, input)).status, 401); assert.equal((await f.call(receipt)).status, 404);
});

test("a PIN-less passkey owner can establish a new PIN through fresh action-bound UV proof", async t => {
  const f = await fixture(t), key = securityKey(); await f.store.transaction(s => { delete s.customers[0].pinHash; s.customers[0].passkeys = [key.record]; });
  const options = await f.call(pin + "/options", { newPin: "5830", confirmPin: "5830" });
  const result = await f.call(pin, { ...change, currentPin: undefined, challengeId: options.body.challengeId, response: securityAssertion(key, options.body.options) });
  assert.equal(result.status, 200); assert.equal(await argon2.verify((await f.store.snapshot()).customers[0].pinHash, "5830"), true);
});

test("failed commit cannot publish a successful credential change or receipt", async t => {
  const f = await fixture(t), original = f.store.transaction.bind(f.store), initial = (await f.store.snapshot()).customers[0].pinHash;
  f.store.transaction = (fn, opts) => original(async s => { const result = await fn(s); if (s.customers[0].pinHash !== initial) throw Error("Synthetic credential commit failure"); return result; }, opts);
  assert.notEqual((await f.call(pin, change)).status, 200); assert.equal((await f.store.snapshot()).customers[0].pinHash, initial);
  assert.equal((await f.call(receipt)).status, 404);
});

test("invalid operation IDs reject before mutation and suspended accounts cannot inspect receipts", async t => {
  const f = await fixture(t); assert.equal((await f.call(pin, { ...change, operationId: "invalid" })).status, 400);
  await f.call(backup + "/generate", { currentPin: "2468", operationId: actionId });
  await f.store.transaction(s => { s.customers[0].status = "suspended"; }); assert.equal((await f.call(receipt)).status, 403);
});
