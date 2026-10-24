// One bounded request at a time. Invalidated replies never update the UI, even
// when an older browser cannot physically cancel fetch.
export function automaticPoll({ run, active, delay, onPause = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, pending = false, stopped = false, generation = 0, again = false, controller;
  function cancel() { clearTimer(timer); timer = undefined; generation++; if (controller) controller.abort(); }
  function schedule(ms) { clearTimer(timer); if (!stopped && active()) timer = setTimer(tick, ms); }
  async function tick() {
    clearTimer(timer);
    if (stopped || !active()) { onPause(); return; }
    if (pending) { again = true; return; }
    pending = true; again = false;
    const expected = generation;
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    const current = () => !stopped && active() && expected === generation;
    try { await run({ signal: controller ? controller.signal : undefined, current }); }
    catch (_) { /* The consumer renders its own scoped failure state. */ }
    finally { pending = false; controller = null; if (!stopped) schedule(again || expected !== generation ? 0 : delay()); }
  }
  const wake = () => { cancel(); if (active()) { if (pending) again = true; else schedule(0); } else onPause(); };
  return { wake, pause() { cancel(); onPause(); }, stop() { stopped = true; cancel(); }, start() { schedule(0); } };
}
