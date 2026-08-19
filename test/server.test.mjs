import test from "node:test";
import assert from "node:assert/strict";
import { plans } from "../server.mjs";
import { totpCode, totpSecret, totpUri, verifyTotp } from "../lib/security.mjs";
test("student catalogue is complete", () => {
  assert.deepEqual(plans.map((p) => p.price), [
    100,
    500,
    2000,
    3000,
    4000,
    5500,
    10000,
    12500,
    15000,
    30000,
  ]);
  assert.equal(plans.find((p) => p.id === "connect30").quotaGb, 30);
  assert.equal(plans.find((p) => p.id === "connect75").quotaGb, 75);
});
test("daily is one device and other plans have their intended limits", () => {
  assert.equal(plans.find((p) => p.id === "daily").deviceLimit, 1);
  assert.equal(plans.find((p) => p.id === "connect20").deviceLimit, 2);
  assert.equal(plans.find((p) => p.id === "family").deviceLimit, 3);
  assert.equal(plans.find((p) => p.id === "max").deviceLimit, 4);
  assert.equal(plans.find((p) => p.id === "unlimited").deviceLimit, 6);
});
test("all plans use direct hotspot voucher access", () => {
  assert.ok(plans.every((p) => !p.accessMode || p.accessMode === "hotspot"));
});
test("TOTP uses RFC-compatible six-digit authenticator codes", () => {
  const knownSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(knownSecret, 59_000), "287082");
  assert.equal(verifyTotp(knownSecret, "287082", 59_000), true);
  assert.equal(verifyTotp(knownSecret, "000000", 59_000), false);
  const generated = totpSecret();
  assert.match(generated, /^[A-Z2-7]{32}$/);
  assert.match(totpUri(generated), /^otpauth:\/\/totp\//);
});
