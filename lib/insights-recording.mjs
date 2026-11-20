// Recorded series for Insights (#262). Rows are small aggregates in the
// insightCounters collection, never per-person records:
//   devices:<YYYY-MM-DDTHH>  devices online, sampled by each completed router
//                            usage sync in that Douala hour (samples, total, peak)
//   funnel:<YYYY-MM-DD>:<variant>  anonymous step counts for one Douala day
// Each row's `at` is the start of its hour or day, so retention and the
// period filter work on it like any other event.
const HOUR = 3600000, DAY = 86400000, OFFSET = 3600000; // Africa/Douala is UTC+1, without daylight saving.
export const FUNNEL_STEPS = Object.freeze(["wifi_page", "signed_in", "payment_started", "paid"]);
export const FUNNEL_VARIANTS = Object.freeze(["v1", "v2"]);

const hourStart = (ms) => Math.floor((ms + OFFSET) / HOUR) * HOUR - OFFSET;
const dayStart = (ms) => Math.floor((ms + OFFSET) / DAY) * DAY - OFFSET;
const localIso = (ms) => new Date(ms + OFFSET).toISOString();

export const deviceRowId = (at) => `devices:${localIso(hourStart(+at)).slice(0, 13)}`;
export const funnelRowId = (at, variant) => `funnel:${localIso(dayStart(+at)).slice(0, 10)}:${variant}`;

// One completed usage sync: `count` devices online on the hotspot at `at`.
export function recordDeviceSample(s, count, at) {
  if (!Number.isSafeInteger(count) || count < 0) return null;
  const id = deviceRowId(at), start = hourStart(+at);
  s.insightCounters ??= [];
  let row = s.insightCounters.find((r) => r.id === id);
  if (!row) {
    row = { id, type: "devices_hourly", at: new Date(start).toISOString(), hour: Number(localIso(start).slice(11, 13)), samples: 0, total: 0, peak: 0 };
    s.insightCounters.push(row);
  }
  row.samples += 1;
  row.total += count;
  row.peak = Math.max(row.peak, count);
  row.updatedAt = new Date(+at).toISOString();
  return row;
}

// Validates a beacon; returns { step, variant } or null. Nothing else is kept.
export function funnelInput(input) {
  const step = input?.step, variant = input?.variant;
  return FUNNEL_STEPS.includes(step) && FUNNEL_VARIANTS.includes(variant) ? { step, variant } : null;
}

export function recordFunnelStep(s, { step, variant }, at) {
  const id = funnelRowId(at, variant);
  s.insightCounters ??= [];
  let row = s.insightCounters.find((r) => r.id === id);
  if (!row) {
    row = { id, type: "funnel_daily", at: new Date(dayStart(+at)).toISOString(), day: localIso(dayStart(+at)).slice(0, 10), variant,
      steps: Object.fromEntries(FUNNEL_STEPS.map((name) => [name, 0])) };
    s.insightCounters.push(row);
  }
  row.steps[step] = (row.steps[step] || 0) + 1;
  row.updatedAt = new Date(+at).toISOString();
  return row;
}

const within = (row, start, end) => { const at = Date.parse(row.at); return at >= start && at < end; };
const firstAt = (rows) => rows.reduce((first, r) => (!first || r.at < first ? r.at : first), null);

// "Devices online, average by hour": each Douala hour of the day, averaged over
// the period's samples. An hour with no samples is null, never zero.
export function hourlyDeviceCounts(s, { from, to }) {
  const start = Date.parse(from), end = Date.parse(to);
  const all = (s.insightCounters || []).filter((r) => r.type === "devices_hourly");
  const rows = all.filter((r) => within(r, start, end));
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const at = rows.filter((r) => r.hour === hour), samples = at.reduce((n, r) => n + r.samples, 0);
    return { hour, samples, average: samples ? Math.round(at.reduce((n, r) => n + r.total, 0) / samples * 10) / 10 : null,
      peak: samples ? Math.max(...at.map((r) => r.peak)) : null };
  });
  return { status: rows.length ? "available" : all.length ? "no-samples-in-period" : "collecting", since: firstAt(all), timeZone: "Africa/Douala",
    basis: "devices-online-from-each-completed-router-usage-sync", hours };
}

// Wi-Fi page → paid, by design variant: visits that reached each step.
export function funnelCounts(s, { from, to }) {
  const start = Date.parse(from), end = Date.parse(to);
  const all = (s.insightCounters || []).filter((r) => r.type === "funnel_daily");
  const rows = all.filter((r) => within(r, start, end));
  const variants = Object.fromEntries(FUNNEL_VARIANTS.map((variant) => [variant,
    Object.fromEntries(FUNNEL_STEPS.map((step) => [step, rows.filter((r) => r.variant === variant).reduce((n, r) => n + (r.steps?.[step] || 0), 0)]))]));
  return { status: rows.length ? "available" : all.length ? "no-visits-in-period" : "collecting", since: firstAt(all), timeZone: "Africa/Douala",
    basis: "anonymous-visits-counted-once-per-step-from-the-wifi-page", steps: [...FUNNEL_STEPS], variants };
}

// Access-point load needs a measured share of capacity per access point. The
// standalone EAPs report nothing to the API, so it is not shown or estimated.
export function accessPointLoadAvailability(env = {}) {
  return env.OMADA_MODE === "standalone"
    ? { status: "unavailable", reason: "access-points-run-standalone-without-a-controller" }
    : { status: "unavailable", reason: "measured-peak-capacity-not-recorded" };
}
