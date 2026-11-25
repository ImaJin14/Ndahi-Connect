import test from "node:test";
import assert from "node:assert/strict";
import { recordRouterCheck, routerRowId, routerUptime } from "../lib/insights-recording.mjs";

// Admin home "Router uptime, 7 days" (#377): every router usage sync is a check
// that reached the router or not, counted per Douala hour.
const at = (iso) => new Date(iso);

test("checks are counted per Douala hour, reached or not", () => {
  const s = {};
  recordRouterCheck(s, true, at("2026-11-25T05:01:00Z"));
  recordRouterCheck(s, false, at("2026-11-25T05:30:00Z"));
  recordRouterCheck(s, true, at("2026-11-25T05:59:59Z"));
  recordRouterCheck(s, true, at("2026-11-25T06:00:00Z"));
  assert.equal(routerRowId(at("2026-11-25T05:30:00Z")), "router:2026-11-25T06", "the row is named by the Douala hour");
  assert.deepEqual(s.insightCounters.map(({ id, type, at: start, checks, reached }) => ({ id, type, at: start, checks, reached })), [
    { id: "router:2026-11-25T06", type: "router_hourly", at: "2026-11-25T05:00:00.000Z", checks: 3, reached: 2 },
    { id: "router:2026-11-25T07", type: "router_hourly", at: "2026-11-25T06:00:00.000Z", checks: 1, reached: 1 },
  ]);
});

test("uptime is the share of the last seven days' checks that reached the router", () => {
  const s = {}, now = at("2026-11-25T12:00:00Z");
  assert.deepEqual(routerUptime(s, { now }), { status: "collecting", since: null, days: 7, checks: 0, reached: 0, percent: null, basis: "router-usage-syncs-that-reached-the-router" });
  // Eight days ago: outside the window.
  for (let i = 0; i < 50; i++) recordRouterCheck(s, false, at("2026-11-17T10:00:00Z"));
  assert.equal(routerUptime(s, { now }).status, "no-checks-in-period");
  // 997 of 1000 checks in the window reached the router: 99.7%.
  for (let i = 0; i < 997; i++) recordRouterCheck(s, true, new Date(+at("2026-11-18T13:00:00Z") + i * 60000));
  for (let i = 0; i < 3; i++) recordRouterCheck(s, false, at("2026-11-25T11:30:00Z"));
  const week = routerUptime(s, { now });
  assert.deepEqual([week.status, week.checks, week.reached, week.percent, week.since], ["available", 1000, 997, 99.7, "2026-11-17T10:00:00.000Z"]);
  // A share just under 100% is never rounded up to it.
  const nearly = {};
  for (let i = 0; i < 1999; i++) recordRouterCheck(nearly, true, new Date(+now - i * 60000));
  recordRouterCheck(nearly, false, now);
  assert.equal(routerUptime(nearly, { now }).percent, 99.9);
});
