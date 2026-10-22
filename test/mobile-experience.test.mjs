import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  planHighlightBadge,
  planValue,
} from "../customer-app/plan-presentation.js";
import {
  getInstallMode,
  isIPhoneUserAgent,
  copy as installCopy,
} from "../customer-app/install.js";

test("planHighlightBadge identifies Popular and Best Value packages", () => {
  assert.equal(planHighlightBadge({ id: "weekly" }), "Popular");
  assert.equal(planHighlightBadge({ id: "unlimited" }), "Best Value");
  assert.equal(planHighlightBadge({ id: "custom", highlightBadge: "Special" }), "Special");
  assert.equal(planHighlightBadge({ id: "daily" }), "");
  assert.equal(planHighlightBadge(null), "");
});

test("planValue computes per-GB unit pricing and handles unlimited plans", () => {
  const weekly = { id: "weekly", price: 500, quotaGb: 5, validityHours: 168 };
  const unlimited = { id: "unlimited", price: 30000, quotaGb: null, validityHours: 720 };
  
  const weeklyVal = planValue(weekly);
  assert.equal(weeklyVal.pricePerGb, 100);
  assert.equal(weeklyVal.perGbLabel, "100 FCFA / GB");
  
  const unlimitedVal = planValue(unlimited);
  assert.equal(unlimitedVal.pricePerGb, null);
  assert.equal(unlimitedVal.perGbLabel, "Not applicable for unlimited data");
});

test("PWA install guidance distinguishes iOS Safari and native Chromium prompts", () => {
  assert.equal(isIPhoneUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1"), true);
  assert.equal(isIPhoneUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36"), false);
  assert.equal(isIPhoneUserAgent("", "MacIntel", 5), true); // iPadOS touch desktop emulation

  // When already installed or settled, no mode is returned
  assert.equal(getInstallMode({ installed: true, deferred: true }), null);
  assert.equal(getInstallMode({ settled: true, deferred: true }), null);

  // When prompt is deferred (Chromium)
  assert.equal(getInstallMode({ deferred: true }), "prompt");

  // When on iPhone without standalone mode
  assert.equal(getInstallMode({ iPhone: true }), "iphone");
  assert.ok(installCopy.iphone.includes("Add to Home Screen"));

  // When in an in-app WebView
  assert.equal(getInstallMode({ webView: true }), "webview");
});

test("package-grid.css contains mobile scroll-snap carousel rules and unit rate styles", async () => {
  const css = await readFile(resolve("customer-app/package-grid.css"), "utf8");
  
  assert.ok(css.includes("scroll-snap-type: x mandatory"), "must have scroll-snap-type");
  assert.ok(css.includes("overflow-x: auto"), "must have overflow-x: auto");
  assert.ok(css.includes("scroll-snap-align: center"), "must align cards on center snap");
  assert.ok(css.includes(".plan-unit-rate"), "must style per-GB unit rate");
  assert.ok(css.includes(".plan-badge-popular"), "must have popular badge style");
  assert.ok(css.includes(".plan-badge-best-value"), "must have best value badge style");
});

test("styles.css enforces mobile bottom sheets and minimum 44px touch targets", async () => {
  const css = await readFile(resolve("customer-app/styles.css"), "utf8");
  
  // Mobile bottom sheets
  assert.ok(css.includes("bottom: 0 !important"), "must anchor bottom sheets to viewport bottom");
  assert.ok(css.includes("border-radius: 20px 20px 0 0 !important"), "must apply top corner radius to sheet");
  assert.ok(css.includes("width: 36px"), "must render grab handle indicator on bottom sheets");

  // Touch accessibility
  assert.ok(css.includes("min-height: 44px"), "interactive form controls and buttons must have 44px min height");
  assert.ok(css.includes(".lang-switcher button"), "lang-switcher buttons must have touch target rules");
});
