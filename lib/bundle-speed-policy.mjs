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
  if (snapshot?.id && snapshot.id !== voucher.planId) throw new Error("Recorded bundle does not match this voucher.");
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

// The shared speed limit of one bundle (#263, owner decision 19 Nov: one limit for
// all of a customer's devices on it). The router applies it as one simple queue
// whose targets are the addresses of the bundle's devices online now; the usage
// sync keeps that list current. A bundle with no limit, not active, or with no
// device online needs no queue (addresses empty means "remove it").
export const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
export function speedQueueTarget(voucher) {
  let speeds = { uploadBps: 0, downloadBps: 0 };
  try { if (voucher?.speedSnapshot) speeds = routerSpeedBits(voucher.speedSnapshot); } catch { /* An invalid snapshot never limits anyone. */ }
  const limited = speeds.uploadBps > 0 || speeds.downloadBps > 0;
  const addresses = limited && voucher.status === "active" && voucher.accessMode !== "home"
    ? [...new Set((voucher.wifiDevices || []).map((d) => d?.address).filter((a) => IPV4.test(a || "")))].sort().slice(0, 100) : [];
  return { voucherId: voucher.id, ...speeds, addresses, limited, key: JSON.stringify([speeds.uploadBps, speeds.downloadBps, addresses]) };
}

// The speed terms a new allocation keeps for its whole life. A plan (or a payment's
// plan snapshot) without speed fields is unlimited; edits to the catalogue never
// reach bundles already issued.
export function issueSpeedSnapshot(plan) {
  try { return snapshotBundleSpeeds(plan || {}); } catch { return { downloadMbps: null, uploadMbps: null }; }
}
