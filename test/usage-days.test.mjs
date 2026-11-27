import test from "node:test";
import assert from "node:assert/strict";
import { recordUsageDay, usedLastDays } from "../lib/usage-days.mjs";
import { bundleStatus } from "../lib/bundle-status.mjs";
import { blank } from "../server.mjs";

// "Used this week" on desktop Home (#354, owner 27 Nov: record daily usage).
// Each reading's increase goes to its day in Douala time; 8 days are kept; the
// week is today and the 6 days before; nothing recorded yet is null.
const at = (iso) => new Date(iso);
test("each reading's increase goes to its Douala day, and only 8 days are kept", () => {
  const v = {};
  assert.equal(usedLastDays(v, 7, at("2026-11-27T10:00:00Z")), null, "nothing recorded yet");
  recordUsageDay(v, 5e8, at("2026-11-27T10:00:00Z"));
  recordUsageDay(v, 2e8, at("2026-11-27T22:30:00Z")); // 23:30 in Douala, same day
  recordUsageDay(v, 1e8, at("2026-11-27T23:30:00Z")); // 00:30 on the 28th in Douala
  recordUsageDay(v, 0, at("2026-11-27T10:00:00Z")); recordUsageDay(v, -5, at("2026-11-27T10:00:00Z"));
  assert.deepEqual(v.usageDays, { "2026-11-27": 7e8, "2026-11-28": 1e8 });
  for (let d = 1; d <= 10; d++) recordUsageDay(v, 1e6, at(`2026-12-${String(d).padStart(2, "0")}T10:00:00Z`));
  assert.equal(Object.keys(v.usageDays).length, 8);
  assert.equal(Object.keys(v.usageDays)[0], "2026-12-03");
});

test("the week is today and the six days before it", () => {
  const v = { usageDays: { "2026-11-18": 9e9, "2026-11-20": 1e9, "2026-11-21": 2e8, "2026-11-26": 3e8, "2026-11-27": 4e8 } };
  assert.equal(usedLastDays(v, 7, at("2026-11-27T10:00:00Z")), 1e9 * 0 + 2e8 + 3e8 + 4e8);
  assert.equal(usedLastDays(v, 7, at("2026-11-26T10:00:00Z")), 1e9 + 2e8 + 3e8);
});

test("the bundle status gives the week's recorded usage", () => {
  const s = blank(), now = at("2026-11-27T10:00:00Z");
  s.customers.push({ id: "c1", phone: "670001245" });
  s.vouchers.push({ id: "v1", customerId: "c1", status: "active", accessType: "personal_unlimited", quotaBytes: null, usedBytes: 3e9, deviceSlots: 2, deviceLimit: 2,
    activatedAt: "2026-11-23T10:00:00Z", expiresAt: "2026-11-30T10:00:00Z", usageDays: { "2026-11-26": 1e9, "2026-11-27": 8e8 } });
  assert.equal(bundleStatus(s, s.customers[0], now).bundle.usedThisWeek, 1.8e9);
  delete s.vouchers[0].usageDays;
  assert.equal(bundleStatus(s, s.customers[0], now).bundle.usedThisWeek, null);
});
