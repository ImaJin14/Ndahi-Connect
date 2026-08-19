import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { migrateVoucherCodes } from "../lib/voucher-migration.mjs";
import { VOUCHER_PATTERN } from "../lib/security.mjs";

const legacyVoucher = (id, code, status) => ({
  id,
  code,
  status,
  customerId: `customer-${id}`,
  paymentId: `payment-${id}`,
  planId: "weekly",
  usedBytes: 123456,
  quotaBytes: 5_000_000_000,
  activatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-08T00:00:00.000Z",
  deviceLimit: 2,
});

test("voucher migration changes only legacy codes and preserves relationships and status", () => {
  const state = {
    vouchers: [
      legacyVoucher("active", "NC-ABCDEF0123456789", "active"),
      legacyVoucher("expired", "NC-OLD-CODE", "expired"),
      legacyVoucher("used", "NC-WXYZ-9876", "exhausted"),
    ],
  }, before = structuredClone(state.vouchers);
  const result = migrateVoucherCodes(state);
  assert.equal(result.migrated, 2);
  assert.equal(new Set(state.vouchers.map((voucher) => voucher.code)).size, 3);
  assert.ok(state.vouchers.every((voucher) => VOUCHER_PATTERN.test(voucher.code)));
  for (let i = 0; i < state.vouchers.length; i++) {
    assert.deepEqual(
      { ...state.vouchers[i], code: before[i].code },
      before[i],
    );
  }
  assert.equal(state.vouchers[1].status, "expired");
  assert.equal(state.vouchers[2].status, "exhausted");
});

test("voucher migration retries collisions and rejects an unrecoverable allocation", () => {
  const state = { vouchers: [legacyVoucher("one", "legacy-one", "active"), legacyVoucher("two", "legacy-two", "active")] };
  const generated = ["NC-ABCD-2345", "NC-ABCD-2345", "NC-WXYZ-9876"];
  migrateVoucherCodes(state, { generate: () => generated.shift() });
  assert.deepEqual(state.vouchers.map((voucher) => voucher.code), ["NC-ABCD-2345", "NC-WXYZ-9876"]);
  assert.throws(() => migrateVoucherCodes({ vouchers: [legacyVoucher("bad", "legacy", "active")] }, { generate: () => "invalid" }));
});

test("local store transactions roll back voucher changes on migration failure", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((state) => state.vouchers.push(legacyVoucher("one", "legacy", "expired")));
  await assert.rejects(store.transaction((state) => {
    state.vouchers[0].code = "NC-ABCD-2345";
    throw new Error("migration failed");
  }));
  assert.equal((await store.snapshot()).vouchers[0].code, "legacy");
});
