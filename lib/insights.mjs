// Recorded collections only. Router observations, anonymous funnel events and
// older offline sales do not currently provide a complete historical series.
const DAY = 86400000, OFFSET = 3600000;
const day = ms => new Date(ms + OFFSET).toISOString().slice(0, 10);
function minor(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const n = Math.round(value * 100);
  return Number.isSafeInteger(n) && Math.abs(value * 100 - n) < 0.000001 ? n : null;
}

export function recordedCollectionsByDay(state, { from, to }) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 92 * DAY)
    throw new RangeError("Choose a valid period of at most 92 days.");
  const seen = new Map(), buckets = new Map();
  let invalid = 0, duplicates = 0;
  function add(key, fingerprint, at, amount, refund) {
    if (seen.has(key)) {
      if (seen.get(key) !== fingerprint) invalid++;
      else duplicates++;
      return;
    }
    seen.set(key, fingerprint);
    const d = day(at), bucket = buckets.get(d) || { date: d, collected: 0, refunded: 0 };
    bucket.collected += amount;
    bucket.refunded += refund;
    if (!Number.isSafeInteger(bucket.collected) || !Number.isSafeInteger(bucket.refunded)) invalid++;
    buckets.set(d, bucket);
  }
  const payments = [...(state.payments || []), ...(state.storeOrders || []).map(o => o.payment)];
  for (const p of payments) {
    if (!p || !p.confirmedAt) continue;
    const at = Date.parse(p.confirmedAt);
    if (!Number.isFinite(at)) { invalid++; continue; }
    if (at < start || at >= end) continue;
    // An unrecognised confirmed provider is evidence that the chart would be
    // incomplete, not evidence of zero revenue.
    if (!["mesomb", "flutterwave"].includes(p.provider)) { invalid++; continue; }
    const amount = minor(p.amount);
    if (!amount || p.currency !== "XAF" || typeof p.providerReference !== "string" || !p.providerReference.trim() ||
        !["paid", "refund-pending", "refunded"].includes(p.status)) { invalid++; continue; }
    const refund = p.refund?.status === "completed" || p.status === "refunded" ? amount : 0;
    add(`gateway:${p.provider}:${p.providerReference}`, JSON.stringify([p.id, amount, refund, at]), at, amount, refund);
  }
  for (const v of state.vouchers || []) {
    const sale = v.cashSale;
    if (!sale) continue;
    const at = Date.parse(sale.receivedAt);
    if (!Number.isFinite(at)) { invalid++; continue; }
    if (at < start || at >= end) continue;
    const amount = minor(sale.amount);
    if (!amount || typeof sale.id !== "string" || !sale.id || typeof sale.resellerId !== "string" || !sale.resellerId) { invalid++; continue; }
    add(`cash:${sale.id}`, JSON.stringify([v.id, sale.resellerId, amount, at]), at, amount, 0);
  }
  const points = [];
  for (let cursor = Math.floor((start + OFFSET) / DAY) * DAY - OFFSET; cursor < end; cursor += DAY) {
    const date = day(cursor), bucket = buckets.get(date) || { date, collected: 0, refunded: 0 };
    points.push({ date, collected: bucket.collected / 100, refunded: bucket.refunded / 100,
      net: (bucket.collected - bucket.refunded) / 100 });
  }
  return { status: invalid ? "needs_review" : "available", currency: "XAF", timeZone: "Africa/Douala",
    from: new Date(start).toISOString(), to: new Date(end).toISOString(), endExclusive: true,
    basis: "recorded-confirmations-and-cash-sales-before-fees-refunds-against-original-collection-day",
    coverage: "partial-older-offline-sales-may-not-be-recorded", invalidRecords: invalid, duplicateRecords: duplicates,
    days: invalid ? null : points };
}

export function insightsDataAvailability() {
  return {
    hourlyDeviceCounts: { status: "unavailable", reason: "historical-router-observations-not-recorded" },
    accessPointLoad: { status: "unavailable", reason: "measured-peak-capacity-not-recorded" },
    funnel: { status: "unavailable", reason: "anonymous-variant-funnel-events-not-recorded" },
  };
}
