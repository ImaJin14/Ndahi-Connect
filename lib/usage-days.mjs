// Daily usage per bundle (#354, owner 27 Nov: record daily usage so Home can
// show "Used this week"). Each router reading that raises a bundle's usage adds
// the increase to that day (Douala time); only the last 8 days are kept. It
// fills in from the day this ships, and never changes the usage itself.
const ZONE = "Africa/Douala", KEEP = 8;
const dayOf = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: ZONE });
export function recordUsageDay(v, increase, now = new Date()) {
  if (!(Number.isFinite(increase) && increase > 0)) return;
  const day = dayOf(now), days = { ...(v.usageDays || {}) };
  days[day] = (Number(days[day]) || 0) + increase;
  const kept = Object.keys(days).sort().slice(-KEEP);
  v.usageDays = Object.fromEntries(kept.map((d) => [d, days[d]]));
}
// What the bundle used over the last `count` days, today included; null until a reading is recorded.
export function usedLastDays(v, count = 7, now = new Date()) {
  const days = v?.usageDays;
  if (!days || !Object.keys(days).length) return null;
  const from = dayOf(+now - (count - 1) * 864e5), to = dayOf(now);
  return Object.entries(days).filter(([d]) => d >= from && d <= to).reduce((sum, [, bytes]) => sum + (Number(bytes) || 0), 0);
}
