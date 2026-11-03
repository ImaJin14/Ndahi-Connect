// Device features follow the issued allowance, including custom and legacy bundles.
// An online-device count or today's catalogue cannot grant account authority.
export function deviceCapabilities(s, customerId, now) {
  const customer = s.customers.find(c => c.id === customerId);
  const voucher = customer && !customer.suspended && customer.status !== "suspended" && s.vouchers.find(v =>
    v.customerId === customerId && v.status === "active" && Date.parse(v.expiresAt) > +now &&
    (v.quotaBytes === null || Number.isFinite(v.quotaBytes) && v.quotaBytes > (v.usedBytes || 0)) &&
    Number.isInteger(v.deviceLimit) && v.deviceLimit >= 1);
  const deviceLimit = voucher?.deviceLimit || 0;
  return { voucherId: voucher?.id || null, deviceLimit,
    connectionMode: deviceLimit > 1 ? "multi" : deviceLimit === 1 ? "single" : "unavailable",
    mainDeviceSupported: deviceLimit > 1 };
}
