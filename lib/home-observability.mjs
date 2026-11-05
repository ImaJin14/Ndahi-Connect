const elapsed = (at, now) => {
  const value = Date.parse(at);
  return Number.isFinite(value) && value <= +now ? +now - value : null;
};
const percentile = (values, fraction) => values.length
  ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;

export function homeOperationalSummary(s, now) {
  const vouchers = (s.vouchers || []).filter(v => v.accessMode === "home");
  const active = vouchers.filter(v => v.status === "active" && !["revoked", "exhausted", "expired"].includes(v.homeStatus));
  const pending = (s.homeOperations || []).filter(op => ["queued", "processing", "retry"].includes(op.status));
  const ages = pending.map(op => elapsed(op.createdAt, now)).filter(age => age !== null);
  const payments = new Map((s.payments || []).map(payment => [payment.id, payment]));
  const activation = vouchers.flatMap(v => {
    const payment = payments.get(v.paymentId);
    // A direct purchase later assigned to Home is not a paid Home activation.
    const start = Date.parse(payment?.confirmedAt), end = Date.parse(v.homeAuthorizedAt);
    return payment?.accessMode === "home" && Number.isFinite(start) && Number.isFinite(end) && end >= start && end <= +now ? [end - start] : [];
  });
  const observations = s.homeUsageObservations || [];
  const failures = observations.filter(o => o.type === "synchronization.failed");
  const pilot = observations.filter(o => o.type === "pilot.report")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const usage = active.map(v => elapsed(v.lastUsageSyncAt, now));
  return {
    observedAt: now.toISOString(), activeHouseholds: new Set(active.map(v => v.customerId)).size,
    queue: { pending: pending.length, needsReview: (s.homeOperations || []).filter(op => op.status === "needs_review").length,
      oldestAgeMs: ages.length ? Math.max(...ages) : null, unknownAge: pending.length - ages.length },
    usage: { freshnessTargetMs: 60000, fresh: usage.filter(age => age !== null && age <= 60000).length,
      stale: usage.filter(age => age === null || age > 60000).length,
      oldestAgeMs: usage.some(age => age !== null) ? Math.max(...usage.filter(age => age !== null)) : null },
    activation: { source: "server-confirmed-payment-to-first-gateway-confirmation", samples: activation.length,
      p95Ms: percentile(activation, .95), maxMs: activation.length ? Math.max(...activation) : null },
    accounting: { recordedFailures: failures.length,
      discontinuities: failures.filter(o => o.code === "HOME_ACCOUNTING_REVIEW").length,
      activeReview: active.filter(v => v.homeStatus === "accounting_review").length },
    cutoffs: { gatewayConfirmed: observations.filter(o => o.type === "authorization.cutoff_confirmed").length,
      packetLevelAcceptance: "requires-physical-pilot" },
    pilot: pilot ? { at: pilot.at, evidenceHash: pilot.evidenceHash, source: "operator-reported",
      ...pilot.summary, requiresIndependentReview: true } : { status: "not_recorded", source: "operator-reported", requiresIndependentReview: true },
  };
}
