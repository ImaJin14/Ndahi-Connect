import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";

async function fixture(t, options = {}) {
  const f = await pairingFixture({ now: new Date(), ...options });
  t.after(f.close);
  const post = (path, input, address = "203.0.113.10") =>
    f.call(path, input, { session: "", controller: "", address });
  return { ...f, post };
}

const login = "/api/account/login/pin";
const begin = "/api/account/access/begin";
const owner = "670050001";
const code = "NC-AAAA-1111";

test("failed PIN attempts by other customers on the same network do not block a valid sign-in", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const phone = `67006000${i}`;
    assert.equal((await f.post(login, { phone, pin: "0000" })).status, 401);
  }
  assert.equal((await f.post(login, { phone: owner, pin: "2468" })).status, 200);
});

test("failed voucher access by other customers on the same network does not block valid access", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const phone = `67006000${i}`;
    assert.equal((await f.post(begin, { phone, code: "NC-XXXX-9999" })).status, 401);
  }
  assert.equal((await f.post(begin, { phone: owner, code })).status, 200);
});

test("repeated failures still protect the affected account even from a different address", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const result = await f.post(login, { phone: owner, pin: "0000" }, `203.0.113.${10 + i}`);
    assert.ok([401, 429].includes(result.status));
    f.advance(65);
  }
  assert.equal((await f.post(login, { phone: owner, pin: "2468" }, "203.0.113.20")).status, 429);
});

test("repeated voucher guesses still limit the affected phone across addresses", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.post(begin, { phone: owner, code: "NC-XXXX-9999" }, `203.0.113.${10 + i}`)).status, 401);
  }
  assert.equal((await f.post(begin, { phone: owner, code }, "203.0.113.20")).status, 429);
});

test("the shared IP authentication edge budget still limits high-volume requests", async (t) => {
  const f = await fixture(t, { env: { AUTH_EDGE_CUSTOMER_MAX: "8" } });
  for (let i = 0; i < 8; i++) {
    assert.equal((await f.post(login, { phone: `67006000${i}`, pin: "0000" })).status, 401);
  }
  assert.equal((await f.post(login, { phone: owner, pin: "2468" })).status, 429);
  assert.equal((await f.post(login, { phone: owner, pin: "2468" }, "203.0.113.20")).status, 200);
});

test("the higher failure limit for a shared address remains enforced", async (t) => {
  const cases = [
    ["customer.pin.failed", login, { phone: owner, pin: "2468" }],
    ["customer.access.failed", begin, { phone: owner, code }],
    ["customer.claim.failed", "/api/account/claim/check", { phone: owner, code }],
  ];
  for (const [type, path, input] of cases) {
    const f = await fixture(t);
    await f.store.transaction((s) => {
      for (let i = 0; i < 100; i++) s.securityEvents.push({
        id: `${type}-${i}`, type, ip: "203.0.113.10", at: f.now().toISOString(),
        meta: { phone: `67006${String(i).padStart(4, "0")}` },
      });
    });
    assert.equal((await f.post(path, input)).status, 429, type);
    assert.notEqual((await f.post(path, input, "203.0.113.20")).status, 429, type);
  }
});

test("a reserved voucher can be claimed after unrelated shared-network failures", async (t) => {
  const f = await fixture(t);
  const claim = "/api/account/claim/check", phone = "670050099", giftCode = "NC-BBBB-2222";
  await f.store.transaction((s) => s.vouchers.push({
    id: "gift", customerId: null, status: "available", planId: "weekly", code: giftCode,
    reservation: { phone, status: "waiting", expiresAt: new Date(+f.now() + 86400000).toISOString() },
  }));
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.post(claim, { phone: `67006000${i}`, code: "NC-XXXX-9999" })).status, 401);
  }
  assert.equal((await f.post(claim, { phone, code: giftCode })).status, 200);
});

