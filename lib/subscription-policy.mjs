// Purchase eligibility is independent of Wi-Fi coverage and router availability.
// Evaluate server time/quota even when a caller has not run lifecycle cleanup.
// Malformed active records fail closed until reconciled; they cannot prove expiry.
export function activeSubscription(state, customerId, now) {
  return state.vouchers.find((voucher) => {
    if (voucher.customerId !== customerId || voucher.status !== "active") return false;
    const expiresAt = Date.parse(voucher.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= +now) return false;
    if (voucher.quotaBytes !== null && Number.isFinite(voucher.quotaBytes) &&
        Number.isFinite(voucher.usedBytes ?? 0) && (voucher.usedBytes ?? 0) >= voucher.quotaBytes) return false;
    return true;
  });
}

export function subscriptionPurchaseAccess(state, customer, now) {
  if (customer?.suspended || customer?.status === "suspended") {
    return { allowed: false, code: "ACCOUNT_SUSPENDED", message: "This account is suspended. Contact support before making a payment." };
  }
  if (customer && activeSubscription(state, customer.id, now)) {
    return { allowed: false, code: "ACTIVE_BUNDLE_EXISTS",
      message: "Your current bundle is still active. Bundles cannot be stacked, renewed or switched until expiry or data exhaustion. Sign in to connect and continue using your existing bundle." };
  }
  return { allowed: true };
}
