import test from "node:test";
import assert from "node:assert/strict";
import { selectOutageCredits } from "../lib/outage-credit-selection.mjs";

const now = new Date("2026-11-16T10:00:00Z");
const outage = { startedAt: "2026-11-16T08:00:00Z", fixedAt: now.toISOString() };
const voucher = (id, customerId, status, activatedAt, expiresAt) => ({ id, customerId, status, activatedAt, expiresAt });
const old = () => voucher("old", "c", "expired", "2026-11-15T10:00:00Z", "2026-11-16T09:00:00Z");
const current = () => voucher("new", "c", "active", "2026-11-16T09:30:00Z", "2026-11-17T09:30:00Z");

test("replaced expired bundle is held for review instead of reviving alongside a new bundle", () => {
  const vouchers = [old(), current()], before = structuredClone(vouchers);
  const result = selectOutageCredits({ vouchers }, outage, now);
  assert.deepEqual(result.vouchers, []);
  assert.deepEqual(result.reviewCustomerIds, ["c"]);
  assert.deepEqual(vouchers, before);
});

test("a single unambiguous active or expired bundle is eligible", () => {
  const a = old(), b = voucher("active", "other", "active", "2026-11-16T07:00:00Z", "2026-11-17T07:00:00Z");
  const result = selectOutageCredits({ vouchers: [a, b] }, outage, now);
  assert.deepEqual(result.vouchers.map(v => v.id), ["old", "active"]);
  assert.deepEqual(result.reviewCustomerIds, []);
});

test("later replacements and multiple active allocations are held for review", () => {
  const late = voucher("late", "c", "exhausted", "2026-11-16T11:00:00Z", "2026-11-17T11:00:00Z");
  assert.deepEqual(selectOutageCredits({ vouchers: [old(), late] }, outage, now).reviewCustomerIds, ["c"]);
  const extra = voucher("another", "c", "active", "2026-11-16T11:00:00Z", "2026-11-17T11:00:00Z");
  assert.deepEqual(selectOutageCredits({ vouchers: [current(), extra] }, outage, now).reviewCustomerIds, ["c"]);
});

test("invalid outage intervals are rejected and unaffected vouchers are excluded", () => {
  assert.throws(() => selectOutageCredits({ vouchers: [] }, { ...outage, fixedAt: "invalid" }, now), RangeError);
  const before = voucher("before", "c", "expired", "2026-11-15T01:00:00Z", "2026-11-16T07:00:00Z");
  assert.deepEqual(selectOutageCredits({ vouchers: [before] }, outage, now), { vouchers: [], reviewCustomerIds: [] });
});
