// Countdowns to a store promotion's start or end (#302), on the server's
// clock: the catalogue sends its serverTime, and the difference from the
// browser's clock when it was read is added back, so a phone set to the wrong
// time still shows the right days, hours and minutes.
export function clockOffset(serverTime, readAt = Date.now()) {
  const server = Date.parse(serverTime);
  return Number.isFinite(server) ? server - readAt : 0;
}

export function remaining(target, offset = 0, now = Date.now()) {
  const ms = Math.max(0, Date.parse(target) - (now + offset));
  return { ms, days: Math.floor(ms / 864e5), hours: Math.floor(ms / 36e5) % 24, minutes: Math.floor(ms / 6e4) % 60, seconds: Math.floor(ms / 1e3) % 60 };
}

// Runs `tick` now and every `ms` until the element leaves the page, or `tick`
// returns false (the moment has passed: the caller reloads).
export function keepTicking(element, tick, ms = 1000) {
  if (tick() === false) return () => {};
  const timer = setInterval(() => {
    if (!element.isConnected || tick() === false) clearInterval(timer);
  }, ms);
  return () => clearInterval(timer);
}

export const pad = (n) => String(n).padStart(2, "0");
