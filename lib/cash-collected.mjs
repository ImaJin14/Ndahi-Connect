import { chargedAmounts } from "./payment-fees.mjs";
import { suggestedPaymentNetwork } from "../shared-app/cameroon-phone.js";
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
// `since` narrows the report to payments confirmed from that moment (Admin
// home's "Revenue today", #377); it never reaches back before the baseline.
export function cashCollected(s, now = new Date(), { since } = {}) {
  const start = since == null ? NaN : Date.parse(since);
  if (since != null && !Number.isFinite(start)) throw Error("Invalid cash report start");
  const from = Math.max(Date.parse(CASH_COLLECTED_FROM), Number.isFinite(start) ? start : -Infinity),
    to = +now,
    seen = new Map();
  const sources = {
    internet: { payments: 0, collected: 0, refunded: 0, amount: 0 },
    store: { payments: 0, collected: 0, refunded: 0, amount: 0 },
  };
  // Net provider settlements (#379; owner, 25 Nov): per network, what customers
  // paid (the price plus the fee saved on the payment: MeSomb's reported fee,
  // else the quoted one, else none), the fees, completed refunds, and the net
  // MeSomb should pay into the bank. Not a completed settlement read from the
  // gateway: that waits for #191.
  const networks = {
    mtn: { payments: 0, cashBeforeFees: 0, fees: 0, refunded: 0, net: 0 },
    orange: { payments: 0, cashBeforeFees: 0, fees: 0, refunded: 0, net: 0 },
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
      const charged = chargedAmounts(p).fee,
        fee = Number.isFinite(charged) && charged >= 0 ? money(charged) : 0,
        network = networks[["mtn", "orange"].includes(p.network) ? p.network : suggestedPaymentNetwork(p.payerPhone)];
      if (network && !Number.isSafeInteger(network.cashBeforeFees + collected + fee))
        throw Error("Cash total overflow");
      bucket.collected += collected;
      bucket.refunded += refunded;
      bucket.payments++;
      if (network) {
        network.payments++;
        network.cashBeforeFees += collected + fee;
        network.fees += fee;
        network.refunded += refunded;
        network.net += collected - refunded;
      }
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
  for (const network of Object.values(networks))
    for (const key of ["cashBeforeFees", "fees", "refunded", "net"]) network[key] /= 100;
  return {
    status: invalid ? "needs_review" : "available",
    amount: invalid ? null : (gross - refunded) / 100,
    collected: invalid ? null : gross / 100,
    refunded: invalid ? null : refunded / 100,
    currency: "XAF",
    from: Number.isFinite(start) ? new Date(from).toISOString() : CASH_COLLECTED_FROM,
    to: now.toISOString(),
    timeZone: "Africa/Douala",
    basis: "recorded-gateway-confirmed-collections-before-fees",
    sources: invalid ? null : sources,
    networks: invalid ? null : networks,
    invalidRecords: invalid,
    duplicateRecords: duplicates,
    message:
      "Payments confirmed from 1 November 2026 onward, less completed full refunds for those payments. Before gateway fees. Based on saved gateway confirmations, not a live gateway settlement report. Excludes mock payments, pending payments, gifts and offline voucher sales.",
  };
}

// Cash and settlements (#379): Today, the last 7 days or this month, in Douala
// (owner, 25 Nov: the periods replace the fixed "since 1 November" total).
// Today starts at midnight; the last 7 days at midnight six days before today;
// this month on the 1st. A period never starts before the baseline.
export const CASH_PERIODS = Object.freeze(["today", "week", "month"]);
const DAY = 86400000, DOUALA = 3600000;
export function cashPeriodStart(period, now = new Date()) {
  if (!CASH_PERIODS.includes(period)) throw Error("Unknown cash report period");
  const local = new Date(+now + DOUALA), midnight = Math.floor(+local / DAY) * DAY;
  const start = period === "today" ? midnight : period === "week" ? midnight - 6 * DAY : Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  return new Date(Math.max(start - DOUALA, Date.parse(CASH_COLLECTED_FROM)));
}

// The report for a period, with the cash resellers handed over in it.
export function cashReport(s, now = new Date(), { period = "week" } = {}) {
  const since = cashPeriodStart(period, now), report = cashCollected(s, now, { since });
  let handoffs = 0, received = 0;
  for (const u of s.adminUsers || []) for (const r of u.remittances || []) {
    const at = Date.parse(r?.createdAt);
    if (!Number.isFinite(at) || at < +since || at > +now || !Number.isFinite(r.amount) || r.amount <= 0) continue;
    handoffs++;
    received += r.amount;
  }
  return { ...report, period, resellerCash: { handoffs, amount: received } };
}
