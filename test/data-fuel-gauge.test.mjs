import test from "node:test";
import assert from "node:assert/strict";
import { formatExpiryCountdown, fuelStatusClass, formatDataBalance } from "../shared-app/data-usage.js";
import { networkBannerState } from "../customer-app/network-status.js";

test("formatExpiryCountdown formats time remaining accurately", () => {
  const base = new Date("2026-10-22T12:00:00Z");

  // Invalid or null
  assert.equal(formatExpiryCountdown(null, base), null);
  assert.equal(formatExpiryCountdown("", base), null);
  assert.equal(formatExpiryCountdown("invalid-date", base), null);

  // Expired
  assert.equal(formatExpiryCountdown("2026-10-22T11:59:59Z", base), "Expired");
  assert.equal(formatExpiryCountdown("2026-10-22T12:00:00Z", base), "Expired");

  // Days and hours
  assert.equal(formatExpiryCountdown("2026-10-24T15:00:00Z", base), "2d 3h left");

  // Hours and minutes
  assert.equal(formatExpiryCountdown("2026-10-22T16:45:00Z", base), "4h 45m left");

  // Minutes only (< 1h)
  assert.equal(formatExpiryCountdown("2026-10-22T12:35:00Z", base), "35m left");
  assert.equal(formatExpiryCountdown("2026-10-22T12:00:40Z", base), "1m left");
});

test("fuelStatusClass assigns proper status color classes based on remaining ratio", () => {
  // Unlimited plans
  assert.equal(fuelStatusClass(null, null), "fuel-unlimited");

  // Zero or negative remaining
  assert.equal(fuelStatusClass(0, 10e9), "fuel-danger");
  assert.equal(fuelStatusClass(-100, 10e9), "fuel-danger");

  // Danger (< 10%)
  assert.equal(fuelStatusClass(0.5e9, 10e9), "fuel-danger"); // 5%
  assert.equal(fuelStatusClass(1.0e9, 10e9), "fuel-danger"); // exactly 10%

  // Warning (10% - 25%)
  assert.equal(fuelStatusClass(1.5e9, 10e9), "fuel-warning"); // 15%
  assert.equal(fuelStatusClass(2.5e9, 10e9), "fuel-warning"); // exactly 25%

  // Good (> 25%)
  assert.equal(fuelStatusClass(2.6e9, 10e9), "fuel-good"); // 26%
  assert.equal(fuelStatusClass(10e9, 10e9), "fuel-good"); // 100%
});

test("networkBannerState distinguishes active, captive and off-network states truthfully", () => {
  // 1. Off-network / mobile data
  const offNet = networkBannerState({
    purchaseAccess: { allowed: false, message: "Connect to NDAHI Wi-Fi" },
    active: { status: "active" },
  });
  assert.equal(offNet.status, "off-network");
  assert.equal(offNet.badge, "Mobile Data / Off-network");
  assert.match(offNet.message, /Viewing via Mobile Data/);
  assert.ok(offNet.actionHref);

  // 2. Pre-Auth captive on Wi-Fi without active bundle
  const captiveNoBundle = networkBannerState({
    purchaseAccess: { allowed: true },
    active: null,
  });
  assert.equal(captiveNoBundle.status, "pre-auth");
  assert.equal(captiveNoBundle.badge, "Pre-Auth Captive");
  assert.match(captiveNoBundle.message, /Select a bundle or enter voucher/);

  // 3. Pre-Auth captive with expired bundle
  const captiveExpired = networkBannerState({
    purchaseAccess: { allowed: true },
    active: { status: "expired", remainingBytes: 0 },
  });
  assert.equal(captiveExpired.status, "pre-auth");
  assert.equal(captiveExpired.badge, "Pre-Auth Captive");

  // 4. Connected & Active on Wi-Fi with normal Starlink connection
  const activeOnline = networkBannerState({
    purchaseAccess: { allowed: true },
    active: { status: "active", remainingBytes: 5e9 },
    zone: { status: "online" },
  });
  assert.equal(activeOnline.status, "active");
  assert.equal(activeOnline.badge, "Connected & Active");
  assert.match(activeOnline.message, /Starlink Active/);

  // 5. Connected & Active with degraded upstream
  const activeDegraded = networkBannerState({
    purchaseAccess: { allowed: true },
    active: { status: "active", remainingBytes: 5e9 },
    zone: { status: "degraded" },
  });
  assert.equal(activeDegraded.status, "active");
  assert.match(activeDegraded.message, /Network degraded/);
});
