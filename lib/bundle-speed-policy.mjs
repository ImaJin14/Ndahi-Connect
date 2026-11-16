// Freeze bandwidth terms with the allocation. A legacy payment snapshot with
// no speed fields represents an allocation made before limits were offered;
// never fill its missing fields from a subsequently edited catalogue plan.
const FIELDS = ["downloadMbps", "uploadMbps"];

export function snapshotBundleSpeeds(plan) {
  if (!plan || typeof plan !== "object") throw new TypeError("A bundle is required.");
  const snapshot = {};
  for (const field of FIELDS) {
    const value = plan[field];
    if (value == null) { snapshot[field] = null; continue; }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0.001 || value > 10000 ||
        Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-8) {
      throw new RangeError("Invalid bundle speed setting.");
    }
    snapshot[field] = value;
  }
  return snapshot;
}

export function voucherBundleSpeeds(voucher, payment) {
  if (!voucher || typeof voucher !== "object") throw new TypeError("A voucher is required.");
  if (voucher.speedSnapshot !== undefined) return snapshotBundleSpeeds(voucher.speedSnapshot);
  if (!payment) return null;
  if (!voucher.paymentId || payment.id !== voucher.paymentId || payment.planId !== voucher.planId)
    throw new Error("Payment does not match this voucher.");
  const snapshot = payment.planSnapshot || payment.receipt?.plan;
  if (!snapshot || typeof snapshot !== "object" || !FIELDS.some(field => Object.hasOwn(snapshot, field))) return null;
  return snapshotBundleSpeeds(snapshot);
}

// RouterOS directions are from the router's perspective: receive is customer
// upload, transmit is customer download. Zero represents an unlimited side.
export function routerSpeedBits(snapshot) {
  const speeds = snapshotBundleSpeeds(snapshot);
  return { uploadBps: speeds.uploadMbps === null ? 0 : Math.round(speeds.uploadMbps * 1e6),
    downloadBps: speeds.downloadMbps === null ? 0 : Math.round(speeds.downloadMbps * 1e6) };
}
