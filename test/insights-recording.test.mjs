// Insights recording (#262): hourly devices online from the router usage sync,
// and anonymous Wi-Fi page → paid funnel counts by design variant. Aggregates
// only, bucketed on the Africa/Douala clock.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { createRouterCommandProcessor, enqueueRouterCommand } from "../lib/router-queue.mjs";
import { recordDeviceSample, hourlyDeviceCounts, funnelInput, recordFunnelStep, funnelCounts, accessPointLoadAvailability,
  deviceRowId, funnelRowId } from "../lib/insights-recording.mjs";
import { insightsDataAvailability } from "../lib/insights.mjs";

const period = { from: "2026-11-19T23:00:00.000Z", to: "2026-11-21T23:00:00.000Z" }; // 20 and 21 Nov in Douala

test("device samples are kept per Douala hour as samples, total and peak", () => {
  const s = {};
  // 18:30 UTC is 19:30 in Douala.
  recordDeviceSample(s, 12, new Date("2026-11-20T18:30:00Z"));
  recordDeviceSample(s, 20, new Date("2026-11-20T18:59:59Z"));
  recordDeviceSample(s, 4, new Date("2026-11-20T19:00:00Z"));
  for (const bad of [-1, 1.5, NaN, "3"]) assert.equal(recordDeviceSample(s, bad, new Date("2026-11-20T18:40:00Z")), null);
  assert.deepEqual(s.insightCounters.map(({ id, at, hour, samples, total, peak }) => ({ id, at, hour, samples, total, peak })), [
    { id: "devices:2026-11-20T19", at: "2026-11-20T18:00:00.000Z", hour: 19, samples: 2, total: 32, peak: 20 },
    { id: "devices:2026-11-20T20", at: "2026-11-20T19:00:00.000Z", hour: 20, samples: 1, total: 4, peak: 4 },
  ]);
  assert.equal(deviceRowId(new Date("2026-11-20T23:10:00Z")), "devices:2026-11-21T00", "midnight in Douala is 23:00 UTC");
});

test("busiest hours average every sample of that hour of the day over the period, with no zero for missing hours", () => {
  const s = {};
  assert.equal(hourlyDeviceCounts(s, period).status, "collecting");
  recordDeviceSample(s, 10, new Date("2026-11-20T18:10:00Z")); // 19:10 on the 20th
  recordDeviceSample(s, 30, new Date("2026-11-21T18:10:00Z")); // 19:10 on the 21st
  recordDeviceSample(s, 31, new Date("2026-11-21T18:40:00Z"));
  recordDeviceSample(s, 99, new Date("2026-11-22T18:10:00Z")); // outside the period
  const series = hourlyDeviceCounts(s, period);
  assert.equal(series.status, "available");
  assert.equal(series.since, "2026-11-20T18:00:00.000Z");
  assert.deepEqual(series.hours[19], { hour: 19, samples: 3, average: 23.7, peak: 31 });
  assert.deepEqual(series.hours[3], { hour: 3, samples: 0, average: null, peak: null });
  assert.equal(hourlyDeviceCounts(s, { from: "2026-12-01T00:00:00Z", to: "2026-12-02T00:00:00Z" }).status, "no-samples-in-period");
});

test("funnel beacons accept only a known step and variant, and count per Douala day and variant", () => {
  assert.deepEqual(funnelInput({ step: "paid", variant: "v2" }), { step: "paid", variant: "v2" });
  for (const bad of [null, {}, { step: "paid" }, { step: "bought", variant: "v2" }, { step: "paid", variant: "v3" }, { step: ["paid"], variant: "v2" }])
    assert.equal(funnelInput(bad), null);
  const s = {}, late = new Date("2026-11-20T23:30:00Z"); // 00:30 on the 21st in Douala
  assert.equal(funnelRowId(late, "v2"), "funnel:2026-11-21:v2");
  for (const [step, n] of [["wifi_page", 10], ["signed_in", 6], ["payment_started", 4], ["paid", 3]])
    for (let i = 0; i < n; i++) recordFunnelStep(s, { step, variant: "v2" }, new Date("2026-11-20T12:00:00Z"));
  recordFunnelStep(s, { step: "wifi_page", variant: "v2" }, late);
  recordFunnelStep(s, { step: "wifi_page", variant: "v1" }, late);
  const row = s.insightCounters.find((r) => r.id === "funnel:2026-11-20:v2");
  assert.deepEqual([row.at, row.day, row.variant], ["2026-11-19T23:00:00.000Z", "2026-11-20", "v2"]);
  assert.deepEqual(Object.keys(row).sort(), ["at", "day", "id", "steps", "type", "updatedAt", "variant"], "nothing about the visitor is kept");
  const counts = funnelCounts(s, period);
  assert.equal(counts.status, "available");
  assert.deepEqual(counts.variants, {
    v1: { wifi_page: 1, signed_in: 0, payment_started: 0, paid: 0 },
    v2: { wifi_page: 11, signed_in: 6, payment_started: 4, paid: 3 },
  });
  assert.equal(funnelCounts({}, period).status, "collecting");
});

test("availability says what is collecting, and access-point load is never estimated", () => {
  assert.deepEqual(accessPointLoadAvailability({ OMADA_MODE: "standalone" }), { status: "unavailable", reason: "access-points-run-standalone-without-a-controller" });
  assert.equal(accessPointLoadAvailability({ OMADA_MODE: "live" }).status, "unavailable");
  const s = {};
  recordDeviceSample(s, 5, new Date("2026-11-20T18:10:00Z"));
  const availability = insightsDataAvailability({ devices: hourlyDeviceCounts(s, period), funnel: funnelCounts(s, period), accessPointLoad: accessPointLoadAvailability({ OMADA_MODE: "standalone" }) });
  assert.deepEqual(availability.hourlyDeviceCounts, { status: "available", since: "2026-11-20T18:00:00.000Z" });
  assert.equal(availability.funnel.status, "collecting");
  assert.equal(availability.accessPointLoad.reason, "access-points-run-standalone-without-a-controller");
});

// The router usage sync: each completed reading is one sample of the devices
// it lists, once each, without Home vouchers.
async function usageFixture() {
  let now = new Date("2026-11-20T18:05:00Z"), readings = [];
  const store = createStore({ persistent: false });
  const active = (id, extra = {}) => ({ id, customerId: `c-${id}`, planId: "weekly", code: `NC-${id}`, status: "active", activatedAt: "2026-11-20T10:00:00Z",
    expiresAt: "2026-11-27T10:00:00Z", quotaBytes: 5e9, usedBytes: 0, deviceLimit: 3, ...extra });
  await store.transaction((s) => { s.vouchers.push(active("v1"), active("v2"), active("vh", { accessMode: "home" })); });
  const router = { readUsage: async () => readings };
  const processor = createRouterCommandProcessor({ store, now: () => now, router });
  const read = async (next, at) => {
    now = new Date(at); readings = next;
    await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, () => now));
    while (!(await processor.process()).idle);
    return (await store.snapshot()).insightCounters;
  };
  return { read };
}
const mac = (n) => ({ mac: `AA:BB:CC:DD:EE:0${n}`, address: `10.20.0.${n}`, sessionId: `*${n}`, startedAt: "2026-11-20T18:00:00Z", usedBytes: 0 });

test("each completed usage sync records the devices online, without Home devices or readings that list none", async () => {
  const f = await usageFixture();
  let rows = await f.read([{ voucherId: "v1", usedBytes: 0, counterBytes: 0, devices: [mac(1), mac(2)] },
    { voucherId: "v2", usedBytes: 0, counterBytes: 0, devices: [mac(3), { mac: "not-a-mac" }] },
    { voucherId: "vh", usedBytes: 0, counterBytes: 0, devices: [mac(4), mac(5)] }], "2026-11-20T18:05:00Z");
  assert.deepEqual(rows.map(({ id, samples, total, peak }) => [id, samples, total, peak]), [["devices:2026-11-20T19", 1, 3, 3]]);
  // A reading without device lists says nothing about devices online.
  rows = await f.read([{ voucherId: "v1", usedBytes: 0, counterBytes: 0 }], "2026-11-20T18:06:00Z");
  assert.equal(rows[0].samples, 1);
  // Nobody connected is a real reading of zero.
  rows = await f.read([], "2026-11-20T18:07:00Z");
  assert.deepEqual([rows[0].samples, rows[0].total, rows[0].peak], [2, 3, 3]);
});
