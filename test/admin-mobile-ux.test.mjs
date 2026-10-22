import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("admin styles.css defines responsive inspection cards on viewports < 768px", async () => {
  const css = await readFile(resolve("admin-app/styles.css"), "utf8");

  assert.ok(css.includes("@media (max-width: 768px)"), "must include 768px media query");
  assert.ok(css.includes(".admin-dashboard table"), "must style table");
  assert.ok(css.includes(".admin-dashboard thead"), "must hide table headers on small screens");
  assert.ok(css.includes("display: block !important"), "must reflow table cells into block cards");
  assert.ok(css.includes("border-radius: 12px"), "must apply card rounding to rows");
});

test("admin styles.css defines live pulse indicator and filter chips", async () => {
  const css = await readFile(resolve("admin-app/styles.css"), "utf8");

  // Live activity pulse
  assert.ok(css.includes(".live-pulse"), "must style .live-pulse");
  assert.ok(css.includes("livePulseAnim"), "must define pulse keyframe animation");
  assert.ok(css.includes("background: #16a34a"), "must use green indicator color");

  // Filter chips
  assert.ok(css.includes(".filter-chips"), "must style .filter-chips group");
  assert.ok(css.includes(".filter-chip"), "must style individual chips");
  assert.ok(css.includes(".filter-chip.active"), "must style active chip state");
});

test("admin-app/records.js includes quick voucher filter chips and debounced search", async () => {
  const js = await readFile(resolve("admin-app/records.js"), "utf8");

  assert.ok(js.includes('data-status-chip=""'), "must include All filter chip");
  assert.ok(js.includes('data-status-chip="active"'), "must include Active filter chip");
  assert.ok(js.includes('data-status-chip="expired"'), "must include Expired filter chip");
  assert.ok(js.includes('data-status-chip="revoked"'), "must include Revoked filter chip");
  assert.ok(js.includes("250"), "must debounce search input by 250ms");
});

test("admin-app/app.js integrates live pulse indicators on active sessions and metrics", async () => {
  const js = await readFile(resolve("admin-app/app.js"), "utf8");

  assert.ok(js.includes('<span class="live-pulse" aria-hidden="true"></span>Active Wi-Fi sessions'), "must show pulse on active sessions metric");
  assert.ok(js.includes("live-pulse"), "must show pulse on active router devices in table");
});
