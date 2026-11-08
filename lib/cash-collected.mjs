// Fixed reporting baseline requested by the owner, in Africa/Douala (UTC+01).
export const CASH_COLLECTED_FROM = "2026-11-01T00:00:00+01:00";
const money = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw Error("Invalid cash amount");
  const minor = Math.round(value * 100);
  if (!Number.isSafeInteger(minor) || Math.abs(value * 100 - minor) > 0.000001)
    throw Error("Invalid cash precision");
  return minor;
};
export function cashCollected(s, now = new Date()) {
  const from = Date.parse(CASH_COLLECTED_FROM),
    to = +now,
    seen = new Map();
  const sources = {
    internet: { payments: 0, collected: 0, refunded: 0, amount: 0 },
    store: { payments: 0, collected: 0, refunded: 0, amount: 0 },
  };
  let invalid = 0,
    duplicates = 0;
  const rows = [
    ...(s.payments || []).map((payment) => ({ source: "internet", payment })),
    ...(s.storeOrders || []).map((o) => ({
      source: "store",
      payment: o.payment,
    })),
  ];
  for (const { source, payment: p } of rows) {
    if (!p || !["mesomb", "flutterwave"].includes(p.provider) || !p.confirmedAt)
      continue;
    const confirmed = Date.parse(p.confirmedAt);
    if (!Number.isFinite(confirmed)) {
      invalid++;
      continue;
    }
    if (confirmed < from || confirmed > to) continue;
    try {
      if (
        p.currency !== "XAF" ||
        typeof p.providerReference !== "string" ||
        !p.providerReference.trim() ||
        !["paid", "refund-pending", "refunded"].includes(p.status)
      )
        throw Error("Incomplete payment evidence");
      const collected = money(p.amount);
      if (collected <= 0) throw Error("Invalid collection");
      const refunded =
        p.refund?.status === "completed" || p.status === "refunded"
          ? collected
          : 0;
      const key = `${p.provider}:${p.providerReference}`,
        fingerprint = JSON.stringify([p.id, collected, refunded, confirmed]);
      if (seen.has(key)) {
        if (seen.get(key) !== fingerprint)
          throw Error("Conflicting provider reference");
        duplicates++;
        continue;
      }
      seen.set(key, fingerprint);
      const bucket = sources[source];
      if (
        !Number.isSafeInteger(bucket.collected + collected) ||
        !Number.isSafeInteger(bucket.refunded + refunded)
      )
        throw Error("Cash total overflow");
      bucket.collected += collected;
      bucket.refunded += refunded;
      bucket.payments++;
    } catch {
      invalid++;
    }
  }
  const gross = sources.internet.collected + sources.store.collected,
    refunded = sources.internet.refunded + sources.store.refunded;
  if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(refunded))
    invalid++;
  for (const bucket of Object.values(sources)) {
    bucket.amount = (bucket.collected - bucket.refunded) / 100;
    bucket.collected /= 100;
    bucket.refunded /= 100;
  }
  return {
    status: invalid ? "needs_review" : "available",
    amount: invalid ? null : (gross - refunded) / 100,
    collected: invalid ? null : gross / 100,
    refunded: invalid ? null : refunded / 100,
    currency: "XAF",
    from: CASH_COLLECTED_FROM,
    to: now.toISOString(),
    timeZone: "Africa/Douala",
    basis: "recorded-gateway-confirmed-collections-before-fees",
    sources: invalid ? null : sources,
    invalidRecords: invalid,
    duplicateRecords: duplicates,
    message:
      "Payments confirmed from 1 November 2026 onward, less completed full refunds for those payments. Before gateway fees. Based on saved gateway confirmations, not a live gateway settlement report. Excludes mock payments, pending payments, gifts and offline voucher sales.",
  };
}
