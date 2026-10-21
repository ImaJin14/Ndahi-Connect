import test from "node:test";
import assert from "node:assert/strict";
import { voucherHistory, displayedVoucherStatus } from "../shared-app/voucher-history.js";
import { parseRecordQuery, queryRecords, RecordQueryError } from "../lib/admin-records.mjs";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
const now = Date.parse("2030-01-01T12:00:00Z");
const current = { id: "current", code: "NC-CURR-1111", status: "active", activatedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-02-01T00:00:00Z", customerId: "c1", quotaBytes: 1e9, usedBytes: 0, planId: "weekly" };
const history = (n) => ({ ...current, id: "old-" + n, status: n % 2 ? "expired" : "exhausted", activatedAt: "2029-12-01T00:00:00Z", paymentId: "payment-" + n });

test("the default view shows only the explicitly current active voucher with history opt-in", () => {
  const source = [history(1), { ...current, id: "other-active", activatedAt: "2030-01-01T01:00:00Z" }, current];
  const active = voucherHistory(source, { activeId: "current", now }); assert.deepEqual(active.items.map((v) => v.id), ["current"]);
  const all = voucherHistory(source, { activeId: "current", filter: "all", now }); assert.equal(all.items[0].id, "current"); assert.equal(all.total, 3);
});

test("mixed historical states stay reachable through filters and bounded pages without deleting references", () => {
  const source = [current, ...Array.from({ length: 19 }, (_, n) => history(n)), ...["renewed", "switched", "refunded", "revoked", "suspended"].map((status) => ({ ...current, id: status, status }))];
  const before = structuredClone(source), ids = [];
  for (let page = 1; page <= 5; page++) ids.push(...voucherHistory(source, { filter: "all", page, now }).items.map((v) => v.id));
  assert.equal(new Set(ids).size, source.length); assert.equal(ids.length, source.length);
  assert.equal(voucherHistory(source, { filter: "expired", now }).total, 9); assert.equal(voucherHistory(source, { filter: "exhausted", now }).total, 10);
  assert.deepEqual(source, before); assert.equal(source[1].paymentId, "payment-0");
});

test("time expiry automatically removes the current voucher from Active without mutating or reactivating the source", () => {
  const source = Object.freeze({ ...current, expiresAt: "2030-01-01T12:00:01Z" });
  assert.equal(voucherHistory([source], { now }).total, 1);
  assert.equal(voucherHistory([source], { now: now + 1001 }).total, 0);
  assert.equal(voucherHistory([source], { filter: "expired", now: now + 1001 }).items[0].displayStatus, "expired");
  assert.equal(source.status, "active"); assert.equal(displayedVoucherStatus({ ...source, status: "exhausted" }, now + 1001), "exhausted");
});

test("no-active and invalid paging states produce clear bounded history without inventing a current code", () => {
  const source = [history(0), history(1)];
  assert.equal(voucherHistory(source, { now }).currentId, null); assert.equal(voucherHistory(source, { now }).items.length, 0);
  const page = voucherHistory(source, { filter: "all", page: 999, pageSize: 1, now }); assert.equal(page.page, 2); assert.equal(page.items.length, 1);
  assert.equal(voucherHistory(source, { filter: "all", pageSize: 1e6, now }).items.length, 2);
});

test("admin voucher date/status/search combinations filter before pagination while retaining every raw status", () => {
  const source = { vouchers: [current, ...Array.from({ length: 40 }, (_, n) => history(n))], customers: [{ id: "c1", phone: "670050001" }] };
  const query = parseRecordQuery(new URLSearchParams("collection=vouchers&status=expired&q=payment&from=2029-12-01&to=2029-12-01&pageSize=7&page=2"));
  const result = queryRecords(source, query); assert.equal(result.total, 20); assert.equal(result.items.length, 7); assert.equal(result.pages, 3);
  assert.ok(result.items.every((v) => v.status === "expired")); assert.ok(result.statuses.includes("renewed")); assert.ok(result.statuses.includes("switched"));
  assert.equal(queryRecords(source, { collection: "vouchers", from: "2030-01-01", to: "2030-01-01" }).items[0].id, "current");
  assert.equal(source.vouchers.length, 41);
  for (const query of ["collection=vouchers&from=2030-02-30", "collection=vouchers&from=bad", "collection=vouchers&from=2030-02-01&to=2030-01-01", "collection=customers&from=2030-01-01"]) assert.throws(() => parseRecordQuery(new URLSearchParams(query)), RecordQueryError);
});

test("owner-authorized expired PDF downloads and payment references remain intact, while other accounts are denied", async (t) => {
  const f = await pairingFixture(); t.after(f.close);
  await f.store.transaction((s) => s.vouchers.push({ ...s.vouchers[0], id: "historical", status: "expired", paymentId: "preserved-payment", code: "NC-OLDX-1111" }));
  const own = await f.call("/api/account/dashboard"); assert.ok(own.body.vouchers.some((v) => v.id === "historical" && v.paymentId === "preserved-payment"));
  const allowed = await fetch(f.api + "/api/account/vouchers/historical/download", { headers: { origin: "http://customer.test", cookie: "customer_session=main" } });
  assert.equal(allowed.status, 200); assert.match(allowed.headers.get("content-type"), /application\/pdf/);
  const other = await fetch(f.api + "/api/account/vouchers/historical/download", { headers: { origin: "http://customer.test", cookie: "customer_session=other" } });
  assert.equal(other.status, 404);
  assert.equal((await f.store.snapshot()).vouchers.find((v) => v.id === "historical").status, "expired");
});
