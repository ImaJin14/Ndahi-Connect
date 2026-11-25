import test from "node:test";
import assert from "node:assert/strict";
import { blank } from "../server.mjs";
import { createAdminVouchersRoutes, nextBatchReference } from "../lib/api/admin-vouchers.mjs";

// Voucher print (#392, canvas: AdminVoucherPrint): each batch to print or sell
// gets one reference, "B-", the day and month in Douala, then the batch's
// number that day ("Print batch B-2511-01"). A voucher for one customer has none.

function routes(now) {
  const s = blank(),
    route = createAdminVouchersRoutes({ deliverVoucherEmail: async () => false, clock: () => new Date(now) });
  s.customers.push({ id: "c1", phone: "670000001" });
  return {
    s,
    async call(i) {
      const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
      await route({ method: "POST", headers: {}, socket: {}, adminActor: "owner" }, res, new URL("http://api.test/api/admin/vouchers/generate"),
        { s, i, role: "owner", adminUser: { id: "owner", role: "owner" }, administrator: { userId: "owner" }, effects: {} });
      return res;
    },
  };
}

test("each batch to print or sell gets one reference, numbered within its day in Douala", async () => {
  const f = routes("2026-11-25T16:30:00Z"); // 17:30 in Douala
  const first = await f.call({ purpose: "resale", planId: "weekly", quantity: 3 });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.vouchers.map((v) => v.batchReference), ["B-2511-01", "B-2511-01", "B-2511-01"]);
  const second = await f.call({ purpose: "resale", planId: "weekly", quantity: 2 });
  assert.deepEqual(second.body.vouchers.map((v) => v.batchReference), ["B-2511-02", "B-2511-02"]);
  assert.equal(f.s.vouchers.filter((v) => v.batchReference === "B-2511-02").length, 2, "kept on each voucher");
  // A voucher for one customer is not a batch.
  const single = await f.call({ purpose: "assigned", customerId: "c1", planId: "weekly", saleType: "sold" });
  assert.equal(single.status, 201);
  assert.equal(single.body.vouchers?.[0]?.batchReference ?? single.body.voucher?.batchReference, undefined);
});

test("the batch day is Douala's: 00:30 there on 26 Nov starts the 26th's numbering", () => {
  const s = { vouchers: [{ batchReference: "B-2511-01", createdAt: "2026-11-25T16:30:00Z" }, { batchReference: "B-2511-02", createdAt: "2026-11-25T17:00:00Z" }] };
  assert.equal(nextBatchReference(s, new Date("2026-11-25T22:59:00Z")), "B-2511-03");
  assert.equal(nextBatchReference(s, new Date("2026-11-25T23:30:00Z")), "B-2611-01");
});
