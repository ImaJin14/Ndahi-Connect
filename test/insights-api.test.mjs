import test from "node:test";
import assert from "node:assert/strict";
import { createInsightsRoutes } from "../lib/api/insights.mjs";
import { NOT_HANDLED } from "../lib/api/routing.mjs";

const route = createInsightsRoutes();
const query = "?from=2026-11-15T23%3A00%3A00Z&to=2026-11-16T23%3A00%3A00Z";
async function call(path, role = "owner", method = "GET") {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
  const result = await route({ method }, res, new URL(path, "http://test"), { s: { payments: [], vouchers: [] }, role });
  return { res, result };
}

test("insights limits financial data to permitted staff and marks availability", async () => {
  for (const role of ["owner"]) {
    const { res } = await call(`/api/admin/insights${query}`, role);
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.body.collections.coverage, "partial-older-offline-sales-may-not-be-recorded");
    assert.equal(res.body.availability.funnel.status, "unavailable");
  }
  for (const role of ["operator", "auditor", "reseller", "unknown", undefined]) {
    const { res } = await call(`/api/admin/insights${query}`, role === undefined ? null : role);
    assert.equal(res.status, 403);
    assert.equal(res.body.collections, undefined);
  }
});

test("insights rejects ambiguous or invalid periods and ignores unrelated routes", async () => {
  for (const suffix of ["", "?from=x&to=y", `${query}&from=2026-11-15`, "?from=2026-01-01&to=2027-01-01"]) {
    const { res } = await call(`/api/admin/insights${suffix}`);
    assert.equal(res.status, 400);
  }
  assert.equal((await call("/api/admin/other")).result, NOT_HANDLED);
  assert.equal((await call(`/api/admin/insights${query}`, "owner", "POST")).result, NOT_HANDLED);
});
