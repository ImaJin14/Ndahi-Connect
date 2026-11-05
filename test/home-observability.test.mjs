import test from "node:test";
import assert from "node:assert/strict";
import { homeOperationalSummary } from "../lib/home-observability.mjs";

const now = new Date("2030-01-01T12:00:00Z"), ago = ms => new Date(+now - ms).toISOString();
test("Home diagnostics distinguish stale/missing readings, queue age, confirmed latency and accounting review", () => {
  const s = { vouchers: [
    { id: "v1", customerId: "c1", accessMode: "home", status: "active", homeStatus: "connected", lastUsageSyncAt: ago(1000), paymentId: "p1", homeAuthorizedAt: ago(2000) },
    { id: "v2", customerId: "c2", accessMode: "home", status: "active", homeStatus: "accounting_review", paymentId: "p2", homeAuthorizedAt: ago(1000) },
    { id: "v3", customerId: "c3", accessMode: "home", status: "active", homeStatus: "connected", lastUsageSyncAt: ago(61000) },
    { id: "expired", customerId: "finished", accessMode: "home", status: "active", homeStatus: "expired" },
  ], payments: [{ id: "p1", accessMode: "home", confirmedAt: ago(5000) }, { id: "p2", accessMode: "direct", confirmedAt: ago(100000) }],
    homeOperations: [{ status: "retry", createdAt: ago(20000) }, { status: "queued", createdAt: "invalid" }, { status: "needs_review" }],
    homeUsageObservations: [{ type: "synchronization.failed", code: "HOME_ACCOUNTING_REVIEW" }, { type: "authorization.cutoff_confirmed" }] };
  const report = homeOperationalSummary(s, now);
  assert.equal(report.activeHouseholds, 3);
  assert.deepEqual(report.queue, { pending: 2, needsReview: 1, oldestAgeMs: 20000, unknownAge: 1 });
  assert.equal(report.usage.fresh, 1); assert.equal(report.usage.stale, 2);
  assert.equal(report.activation.samples, 1); assert.equal(report.activation.p95Ms, 3000);
  assert.equal(report.accounting.activeReview, 1); assert.equal(report.accounting.discontinuities, 1);
  assert.equal(report.cutoffs.gatewayConfirmed, 1); assert.equal(report.pilot.status, "not_recorded");
  const empty = homeOperationalSummary({}, now);
  assert.equal(empty.activation.p95Ms, null); assert.equal(empty.queue.oldestAgeMs, null);
});
