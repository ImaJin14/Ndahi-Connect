import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, publicRoot, ownerRoot, guestMac } from "./helpers/wifi-pairing-fixture.mjs";

// Pairing codes (#407): the owner's phone issues a 6-digit code; the new device
// sends its request with it (no account number or voucher code); the owner
// still compares the reference and approves. Once only, 10 minutes, and wrong
// codes are limited per address.
async function fixture(t, options) { const f = await pairingFixture(options); t.after(f.close); return f; }
const ask = (f, code, overrides = {}, options = {}) => f.call(publicRoot + "/request", { pairingCode: code, key: "b".repeat(32), mac: guestMac, address: "10.20.0.30", ...overrides }, { session: "", controller: "", ...options });

test("a pairing code from the owner's phone sends one request for the owner to approve", async (t) => {
  const f = await fixture(t);
  const issued = await f.call(ownerRoot + "/code", {});
  assert.equal(issued.status, 201); assert.match(issued.body.code, /^\d{6}$/);
  assert.ok(Date.parse(issued.body.expiresAt) - Date.now() > 9 * 60_000);
  assert.equal(JSON.stringify((await f.store.snapshot()).customers).includes(issued.body.code), false, "stored hashed");
  const r = await ask(f, issued.body.code.slice(0, 3) + " " + issued.body.code.slice(3));
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.request.protocol, 3); assert.equal(r.body.request.status, "awaiting_confirmation");
  assert.match(r.body.request.comparisonCode, /^\d{6}$/, "the owner compares the reference as before");
  const stored = (await f.store.snapshot()).wifiPairingRequests.find((p) => p.id === r.body.request.id);
  assert.equal(stored.viaPairingCode, true);
  // Once only.
  const again = await ask(f, issued.body.code, { key: "c".repeat(32), mac: "AA:BB:CC:DD:EE:07", address: "10.20.0.31" });
  assert.equal(again.status, 401); assert.equal(again.body.code, "PAIRING_CODE_WRONG");
});

test("wrong pairing codes are refused and limited, and the format is checked", async (t) => {
  const f = await fixture(t, { env: { COVERAGE_ALLOWED_IPS: "203.0.113.10,203.0.113.77" } });
  assert.equal((await ask(f, "12345")).body.code, "PAIRING_CODE_INVALID");
  for (let i = 0; i < 5; i++) assert.equal((await ask(f, String(100000 + i))).status, 401);
  const locked = await ask(f, "999999");
  assert.equal(locked.status, 429); assert.equal(locked.body.code, "PAIRING_CODE_LOCKED");
  // Another address isn't locked out.
  assert.equal((await ask(f, "999998", {}, { address: "203.0.113.77" })).status, 401);
});

test("only a signed-in account with a running shared bundle gets a code", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call(ownerRoot + "/code", {}, { session: "" })).status, 401);
  await f.store.transaction((s) => { for (const v of s.vouchers) v.status = "expired"; });
  const none = await f.call(ownerRoot + "/code", {});
  assert.equal(none.status, 409); assert.equal(none.body.code, "NO_ACTIVE_BUNDLE");
});
