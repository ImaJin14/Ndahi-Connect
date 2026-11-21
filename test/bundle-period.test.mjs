import test from "node:test";
import assert from "node:assert/strict";
import { bundlePeriod, groupBundles, chosenPeriod } from "../shared-app/bundle-period.js";

// Bundles arranged by how long they last (owner, 21 Nov): Daily up to a day,
// Weekly up to 7 days, Monthly longer; cheapest first within each.

test("a bundle's period comes from its validity", () => {
  for (const [hours, period] of [[1, "daily"], [24, "daily"], [36, "weekly"], [72, "weekly"], [168, "weekly"], [169, "monthly"], [336, "monthly"], [720, "monthly"], [1080, "monthly"]])
    assert.equal(bundlePeriod({ validityHours: hours }), period, String(hours));
});

test("bundles are grouped Daily, Weekly, Monthly, cheapest first, and empty periods are left out", () => {
  const plans = [
    { id: "monthly", price: 3000, validityHours: 720 }, { id: "unlimited", price: 30000, validityHours: 720 },
    { id: "weekly", price: 1000, validityHours: 168 }, { id: "daily", price: 250, validityHours: 24 },
    { id: "connect30", price: 6000, validityHours: 720 }, { id: "three-days", price: 600, validityHours: 72 },
    { id: "tbc", price: null, validityHours: 720 }, { id: "monthly-twin", price: 3000, validityHours: 720 },
  ];
  assert.deepEqual(groupBundles(plans).map((g) => [g.period, g.plans.map((p) => p.id)]), [
    ["daily", ["daily"]],
    ["weekly", ["three-days", "weekly"]],
    ["monthly", ["monthly", "monthly-twin", "connect30", "unlimited", "tbc"]],
  ]);
  assert.deepEqual(groupBundles([{ id: "w", price: 1, validityHours: 168 }]).map((g) => g.period), ["weekly"]);
  assert.deepEqual(groupBundles([]), []);
});

test("a filter is kept only when its period has bundles", () => {
  const groups = groupBundles([{ price: 1, validityHours: 24 }, { price: 2, validityHours: 720 }]);
  assert.equal(chosenPeriod("monthly", groups), "monthly");
  assert.equal(chosenPeriod("weekly", groups), "all");
  assert.equal(chosenPeriod("anything", groups), "all");
});
