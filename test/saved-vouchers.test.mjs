import test from "node:test";
import assert from "node:assert/strict";
import { savedVoucher } from "../customer-app-v2/voucher-delivery.js";

// Saved vouchers on desktop (#356, canvas DesktopInternet; owner 27 Nov).
const now = Date.parse("2026-11-27T12:00:00Z");
const v = (id, status, extra = {}) => ({ id, code: "NC-" + id.toUpperCase().padEnd(4, "X").slice(0, 4) + "-0000", status, createdAt: "2026-11-01T00:00:00Z", ...extra });

test("the voucher page opens any of the account's own saved codes by id, and nothing else", () => {
  const result = { vouchers: [v("new1", "available"), v("live", "active", { activatedAt: "2026-11-25T00:00:00Z" }), v("gone", "revoked"), { id: "nocode", status: "available" }] };
  assert.equal(savedVoucher(result, "new1").id, "new1");
  assert.equal(savedVoucher(result, "live").id, "live");
  assert.equal(savedVoucher(result, "gone"), null, "a revoked code doesn't open");
  assert.equal(savedVoucher(result, "nocode"), null);
  assert.equal(savedVoucher(result, "someone-else"), null, "only codes in this account's dashboard");
});

test("the list: codes not used yet, then the one in use, then the latest used, five in all", async () => {
  const { savedVoucherRows } = await import("../shared-app/voucher-history.js");
  const used = Array.from({ length: 6 }, (_, n) => v("u" + n, n % 2 ? "expired" : "exhausted", { activatedAt: new Date(now - (n + 2) * 864e5).toISOString() }));
  const rows = savedVoucherRows([...used, v("new1", "available", { createdAt: "2026-11-20T00:00:00Z" }), v("new2", "available", { createdAt: "2026-11-26T00:00:00Z" }),
    v("live", "active", { activatedAt: "2026-11-25T00:00:00Z", expiresAt: "2026-12-02T00:00:00Z" }), v("never", "revoked")], now);
  assert.deepEqual(rows.map((r) => r.id), ["new2", "new1", "live", "u0", "u1"]);
  // An active code past its end reads as used.
  const ended = savedVoucherRows([v("late", "active", { activatedAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-08T00:00:00Z" })], now);
  assert.equal(ended[0].displayStatus, "expired");
});
