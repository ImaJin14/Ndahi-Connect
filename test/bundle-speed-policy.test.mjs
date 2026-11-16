import test from "node:test";
import assert from "node:assert/strict";
import { snapshotBundleSpeeds, voucherBundleSpeeds, routerSpeedBits } from "../lib/bundle-speed-policy.mjs";

test("speed snapshots are independent of subsequent plan edits", () => {
  const plan = { downloadMbps: 12.5, uploadMbps: 2 };
  const snapshot = snapshotBundleSpeeds(plan);
  plan.downloadMbps = 1;
  assert.deepEqual(snapshot, { downloadMbps: 12.5, uploadMbps: 2 });
  assert.deepEqual(voucherBundleSpeeds({ speedSnapshot: snapshot }, null), snapshot);
  assert.deepEqual(routerSpeedBits(snapshot), { uploadBps: 2000000, downloadBps: 12500000 });
});

test("payment evidence is bound to the voucher and old snapshots stay unlimited", () => {
  const voucher = { paymentId: "p", planId: "daily" };
  assert.equal(voucherBundleSpeeds(voucher, { id: "p", planId: "daily", planSnapshot: { name: "legacy" } }), null);
  assert.deepEqual(voucherBundleSpeeds(voucher, { id: "p", planId: "daily", planSnapshot: { uploadMbps: 0.001 } }),
    { downloadMbps: null, uploadMbps: 0.001 });
  assert.throws(() => voucherBundleSpeeds(voucher, { id: "other", planId: "daily", planSnapshot: {} }), /does not match/);
  assert.throws(() => voucherBundleSpeeds(voucher, { id: "p", planId: "other", planSnapshot: {} }), /does not match/);
});

test("invalid rates fail closed and unlimited directions are explicit", () => {
  for (const value of [0, -1, 0.0001, 10000.001, "5", true, Infinity, NaN]) {
    assert.throws(() => snapshotBundleSpeeds({ downloadMbps: value }), RangeError, String(value));
  }
  assert.deepEqual(routerSpeedBits({ downloadMbps: 10000, uploadMbps: null }), { uploadBps: 0, downloadBps: 10000000000 });
  assert.equal(voucherBundleSpeeds({ planId: "daily" }, null), null);
});
