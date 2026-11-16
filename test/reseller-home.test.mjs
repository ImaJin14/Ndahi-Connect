import test from "node:test";
import assert from "node:assert/strict";
import { createAdminResellersRoutes } from "../lib/api/admin-resellers.mjs";
import { blank } from "../lib/api/state.mjs";
import { computeResellerRow } from "../lib/reseller-ledger.mjs";

const time = new Date("2026-11-16T10:00:00Z");
const route = createAdminResellersRoutes({ clock: () => time });
const key = "operation-1234567890";
function fixture() {
  const s = blank();
  s.adminUsers = [{ id: "r1", role: "reseller", username: "seller", commissionPercent: 10 },
    { id: "r2", role: "reseller", username: "other", commissionPercent: 20 },
    { id: "owner", role: "owner", username: "owner" }];
  s.vouchers = [
    { id: "v1", code: "NC-AAAA-BBBB", assignedResellerId: "r1", status: "available", planId: "daily", faceValue: 500, saleType: "sold", commissionPercent: 10 },
    { id: "v2", code: "NC-CCCC-DDDD", assignedResellerId: "r2", status: "available", planId: "daily", faceValue: 500, saleType: "sold" },
  ];
  return s;
}
async function call(s, userId, path, body) {
  const user = s.adminUsers.find(u => u.id === userId), response = {
    setHeader() {}, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); },
  };
  await route({ method: body ? "POST" : "GET", headers: {}, adminActor: user.username }, response,
    new URL(path, "http://test"), { s, i: body || {}, administrator: { userId }, adminUser: user, role: user.role });
  return response;
}

test("cash received records one scoped, immutable sale without activating the voucher", async () => {
  const s = fixture();
  const first = await call(s, "r1", "/api/admin/resellers/cash-sale", { voucherId: "v1", operationKey: key, amount: 1 });
  assert.equal(first.status, 201);
  assert.equal(first.body.sale.amount, 500);
  assert.equal(s.vouchers[0].status, "available");
  assert.equal(s.vouchers[0].activatedAt, undefined);
  assert.equal(first.body.reseller.cashCollected, 500);
  assert.equal(first.body.reseller.commissionEarned, 50);
  assert.equal(first.body.reseller.unsoldVouchers, 0);
  const home = await call(s, "r1", "/api/admin/resellers/ledger?view=home");
  assert.equal(home.body.salesThisWeek, 1);
  assert.equal(home.body.weeklyCollected, 500);
  assert.equal(home.body.weeklyCommission, 50);
  const replay = await call(s, "r1", "/api/admin/resellers/cash-sale", { voucherId: "v1", operationKey: key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(s.auditLogs.filter(a => a.action === "reseller.cash_sale_recorded").length, 1);
  s.vouchers[0].activatedAt = time.toISOString();
  s.vouchers[0].saleType = "gift";
  s.vouchers[0].saleAmount = 1;
  s.vouchers[0].settledCommissionPercent = 99;
  const row = computeResellerRow(s, s.adminUsers[0]);
  assert.equal(row.cashCollected, 500);
  assert.equal(row.commissionEarned, 50);
  assert.equal(row.outstandingBalance, 450);
  s.vouchers[0].assignedResellerId = "r2";
  assert.equal(computeResellerRow(s, s.adminUsers[0]).cashCollected, 500);
  assert.equal(computeResellerRow(s, s.adminUsers[1]).cashCollected, 0);
});

test("cash sale rejects other stock, duplicate sales and operation-key collisions", async () => {
  const s = fixture();
  assert.equal((await call(s, "r1", "/api/admin/resellers/cash-sale", { voucherId: "v2", operationKey: key })).status, 404);
  assert.equal((await call(s, "owner", "/api/admin/resellers/cash-sale", { voucherId: "v1", operationKey: key })).status, 403);
  assert.equal((await call(s, "r1", "/api/admin/resellers/cash-sale", { voucherId: "v1", operationKey: key })).status, 201);
  assert.equal((await call(s, "r1", "/api/admin/resellers/cash-sale", { voucherId: "v1", operationKey: "different-key-123456" })).status, 409);
  assert.equal((await call(s, "r2", "/api/admin/resellers/cash-sale", { voucherId: "v2", operationKey: key })).status, 409);
  assert.equal((await call(s, "r1", "/api/admin/resellers/stock-requests", { operationKey: key })).status, 409);
});

test("reseller home shows only own saleable stock and owner can review idempotent requests", async () => {
  const s = fixture();
  s.vouchers.push({ id: "gift", assignedResellerId: "r1", status: "available", saleType: "gift" });
  s.vouchers.push({ id: "owned", assignedResellerId: "r1", status: "available", customerId: "customer-1", faceValue: 500 });
  s.vouchers.push({ id: "paid", assignedResellerId: "r1", status: "available", paymentId: "payment-1", faceValue: 500 });
  const home = await call(s, "r1", "/api/admin/resellers/ledger?view=home");
  assert.equal(home.status, 200);
  assert.deepEqual(home.body.stock.map(v => v.id), ["v1"]);
  for (const voucherId of ["owned", "paid"]) {
    const result = await call(s, "r1", "/api/admin/resellers/cash-sale", { voucherId, operationKey: `sale-${voucherId}-1234567890` });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "VOUCHER_NOT_SELLABLE");
  }
  assert.equal(home.body.salesThisWeek, 0);
  assert.equal((await call(s, "owner", "/api/admin/resellers/ledger?view=home")).status, 403);
  const request = await call(s, "r1", "/api/admin/resellers/stock-requests", { operationKey: key });
  assert.equal(request.status, 201);
  const replay = await call(s, "r1", "/api/admin/resellers/stock-requests", { operationKey: key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await call(s, "r2", "/api/admin/resellers/ledger?view=stock-requests")).status, 403);
  const owner = await call(s, "owner", "/api/admin/resellers/ledger?view=stock-requests");
  assert.equal(owner.body.requests.length, 1);
  assert.equal(owner.body.requests[0].resellerId, "r1");
});
