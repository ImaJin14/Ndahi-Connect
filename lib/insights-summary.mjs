// The Insights screen's figures (AdminInsights, #382; owner decisions 25 Nov),
// each beside the previous period of the same length. The screen shows these
// as they come; it never works money or shares out itself.
//
// - revenue: recorded collections net of refunds (lib/insights.mjs), XAF;
// - bundlesSold: paid bundle payments, plus codes staff sold by hand, as on
//   Home's "bundles sold today";
// - payingCustomers: distinct customers (or payer numbers) who paid for a
//   bundle or a store order;
// - boughtAgain: of the customers whose bundle ended in the period (at least
//   2 days before now, so every one has had the full 2 days), the share who
//   bought another bundle no later than 2 days after it ended. A bundle bought
//   before the end (an early renewal) counts.
import { recordedCollectionsByDay } from "./insights.mjs";
import { hourlyDeviceCounts, funnelCounts, FUNNEL_STEPS } from "./insights-recording.mjs";

const DAY = 864e5, TWO_DAYS = 2 * DAY;
const at = (value) => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };
const inRange = (ms, start, end) => ms !== null && ms >= start && ms < end;
// A change against the previous period: a percentage, or null when there was nothing to compare with.
export const percentChange = (now, before) => (Number.isFinite(now) && Number.isFinite(before) && before > 0 ? Math.round(((now - before) / before) * 100) : null);

function revenue(s, start, end) {
  try {
    const r = recordedCollectionsByDay(s, { from: new Date(start).toISOString(), to: new Date(end).toISOString() });
    return r.days ? r.days.reduce((n, d) => n + d.net, 0) : null;
  } catch { return null; }
}
function bundlesSold(s, start, end) {
  let count = 0;
  for (const p of s.payments || []) if (p.status === "paid" && p.provider !== "mock" && inRange(at(p.confirmedAt || p.createdAt), start, end)) count++;
  for (const v of s.vouchers || []) if (!v.paymentId && v.generatedByAdmin && v.saleType === "sold" && v.status !== "revoked" && inRange(at(v.activatedAt), start, end)) count++;
  return count;
}
function payingCustomers(s, start, end) {
  const who = new Set();
  for (const p of s.payments || []) if (p.status === "paid" && p.provider !== "mock" && inRange(at(p.confirmedAt || p.createdAt), start, end)) who.add(p.customerId || p.payerPhone);
  for (const o of s.storeOrders || []) if (o.payment?.confirmedAt && inRange(at(o.payment.confirmedAt), start, end)) who.add(o.customerId || o.phone || o.payment.payerPhone);
  who.delete(undefined); who.delete(null);
  return who.size;
}
// When a bundle actually stopped: used up, or its time ran out.
const endedAt = (v) => {
  const times = [at(v.exhaustedAt), v.status === "expired" || v.status === "exhausted" || v.status === "active" ? at(v.expiresAt) : null].filter((t) => t !== null);
  return times.length ? Math.min(...times) : null;
};
const boughtAt = (v) => at(v.activatedAt) ?? at(v.createdAt);
export function boughtAgainShare(s, { start, end, now }) {
  const byCustomer = new Map();
  for (const v of s.vouchers || []) if (v.customerId) {
    if (!byCustomer.has(v.customerId)) byCustomer.set(v.customerId, []);
    byCustomer.get(v.customerId).push(v);
  }
  const cutoff = Math.min(end, +now - TWO_DAYS);
  let ended = 0, again = 0;
  for (const list of byCustomer.values()) {
    const finished = list.map((v) => ({ v, stop: endedAt(v), bought: boughtAt(v) })).filter((x) => x.stop !== null && x.stop >= start && x.stop < cutoff && x.stop <= +now);
    if (!finished.length) continue;
    // One answer per customer: their latest bundle to end in the period.
    const last = finished.sort((a, b) => b.stop - a.stop)[0];
    ended++;
    if (list.some((other) => other !== last.v && boughtAt(other) !== null && boughtAt(other) > (last.bought ?? -Infinity) && boughtAt(other) <= last.stop + TWO_DAYS)) again++;
  }
  return { ended, again, share: ended ? Math.round((again / ended) * 100) : null };
}

// The figures for [from, to) and the same length before it.
export function insightsFigures(s, { from, to, now = new Date() }) {
  const start = Date.parse(from), end = Date.parse(to), length = end - start, prevStart = start - length;
  const pair = (fn) => { const current = fn(start, end), previous = fn(prevStart, start); return { value: current, previous, change: percentChange(current, previous) }; };
  const again = boughtAgainShare(s, { start, end, now }), againBefore = boughtAgainShare(s, { start: prevStart, end: start, now });
  return {
    revenue: pair((a, b) => revenue(s, a, b)),
    bundlesSold: pair((a, b) => bundlesSold(s, a, b)),
    payingCustomers: pair((a, b) => payingCustomers(s, a, b)),
    // A change in points, not a percentage.
    boughtAgain: { value: again.share, ended: again.ended, previous: againBefore.share, changePoints: again.share !== null && againBefore.share !== null ? again.share - againBefore.share : null },
  };
}

// The busiest three hours by average devices online ("Peak 19:00–22:00").
export function busiestWindow(hours, size = 3) {
  let best = null;
  for (let first = 0; first + size <= 24; first++) {
    const slice = hours.slice(first, first + size);
    if (slice.some((h) => h.average === null)) continue;
    const total = slice.reduce((n, h) => n + h.average, 0);
    if (!best || total > best.total) best = { from: first, to: first + size, total };
  }
  return best && best.total > 0 ? { from: best.from, to: best.to } : null;
}

// "Starlink at peak: N Mbps in use": the average of the hourly uplink peaks
// recorded by the Connections checks (#380) inside the busiest window.
export function uplinkAtPeak(s, { from, to }, window) {
  if (!window) return null;
  const start = Date.parse(from), end = Date.parse(to);
  const rows = (s.insightCounters || []).filter((r) => r.type === "uplink_hourly" && inRange(at(r.at), start, end) && r.hour >= window.from && r.hour < window.to && Number.isFinite(r.peakMbps));
  return rows.length ? Math.round((rows.reduce((n, r) => n + r.peakMbps, 0) / rows.length) * 10) / 10 : null;
}

// Wi-Fi page → paid, as shares of each design's visitors, with the note's
// numbers: the paid gap in points, the step with the biggest gain, and the
// new design's share of visitors.
export function funnelSummary(funnel) {
  const share = (variant) => {
    const counts = funnel.variants[variant], base = counts[FUNNEL_STEPS[0]];
    return base ? FUNNEL_STEPS.map((step) => Math.round((counts[step] / base) * 100)) : null;
  };
  const current = share("v1"), next = share("v2"), visitors = funnel.variants.v1[FUNNEL_STEPS[0]] + funnel.variants.v2[FUNNEL_STEPS[0]];
  let biggest = null;
  if (current && next) for (let i = 1; i < FUNNEL_STEPS.length; i++) {
    const rate = (v, j) => (v[j - 1] ? v[j] / v[j - 1] : 0), gain = rate(next, i) - rate(current, i);
    if (gain > 0 && (!biggest || gain > biggest.gain)) biggest = { from: FUNNEL_STEPS[i - 1], to: FUNNEL_STEPS[i], gain };
  }
  return { steps: [...FUNNEL_STEPS], current, next,
    paidPoints: current && next ? next.at(-1) - current.at(-1) : null,
    biggestGain: biggest ? { from: biggest.from, to: biggest.to } : null,
    newShare: visitors ? Math.round((funnel.variants.v2[FUNNEL_STEPS[0]] / visitors) * 100) : null };
}

export function insightsSummary(s, { from, to, now = new Date() }) {
  const devices = hourlyDeviceCounts(s, { from, to }), window = busiestWindow(devices.hours);
  return { figures: insightsFigures(s, { from, to, now }), busiest: window, uplinkAtPeakMbps: uplinkAtPeak(s, { from, to }, window),
    funnel: funnelSummary(funnelCounts(s, { from, to })) };
}
