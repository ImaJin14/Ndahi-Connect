// Data "today" for Live devices (#381, canvas AdminDevices): what a session
// or a Home WISP router used since midnight in Douala (UTC+01, no daylight
// saving). The router counts bytes per session, from the session's start; to
// say what was used today, each reading keeps the count the day started with.
// No imports: the router queue, the Wi-Fi device views and the Home ledger
// all use it.

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Douala", year: "numeric", month: "2-digit", day: "2-digit" });
export const doualaDay = (at) => DAY.format(new Date(at));

// The day fields stored with a session's reading. `previous` is the same
// session's last reading, if any.
// - A session that started today: everything it used is today's.
// - Read earlier today: keep the count the day started with.
// - Last read before midnight (or before this was recorded): the count at
//   that reading is where today starts.
// - Never read before and older than today: count from this reading on.
export function sessionDay(previous, startedAt, usedBytes, now) {
  const day = doualaDay(now);
  if (Number.isFinite(Date.parse(startedAt)) && doualaDay(startedAt) === day) return { day, dayStartBytes: 0 };
  if (previous?.day === day && Number.isFinite(previous.dayStartBytes)) return { day, dayStartBytes: Math.min(previous.dayStartBytes, usedBytes) };
  if (previous) return { day, dayStartBytes: Math.min(Number(previous.usedBytes) || 0, usedBytes) };
  return { day, dayStartBytes: usedBytes };
}
// What a reading says was used today; nothing when the reading is from another day.
export const usedToday = (reading, now) => (reading?.day === doualaDay(now) ? Math.max(0, (Number(reading.usedBytes) || 0) - (Number(reading.dayStartBytes) || 0)) : 0);

// RouterOS uptime ("1d02:03:04", "2h5m10s") in seconds, as router-hotspot.mjs
// reads it; kept here so the Home adapter needs no import from it.
export function uptimeSeconds(value) {
  if (value === "none" || value === "0" || value === "0s") return 0;
  const text = String(value || "");
  if (/^(?:\d+w)?(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(text) && text)
    return [...text.matchAll(/(\d+)([wdhms])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * ({ w: 604800, d: 86400, h: 3600, m: 60, s: 1 })[unit], 0);
  const clock = text.match(/^(?:(\d+)d)?(\d+):(\d{2}):(\d{2})$/);
  return clock ? Number(clock[1] || 0) * 86400 + Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]) : null;
}
