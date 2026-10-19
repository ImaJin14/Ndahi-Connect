// Invalidate browser credentials without changing bundles, Wi-Fi sessions or payment history.
export function revokeCustomerCredentials(s, customer, { keepBackupCodes = false } = {}) {
  const vouchers = new Set((s.vouchers || []).filter((v) => v.customerId === customer.id).map((v) => v.id));
  s.dashboardSessions = (s.dashboardSessions || []).filter((x) => x.customerId !== customer.id);
  for (const key of ["customerPasskeyChallenges", "customerMfaChallenges", "otpChallenges", "pinResetChallenges", "customerAccessChallenges"]) {
    s[key] = (s[key] || []).filter((x) => x.customerId !== customer.id && x.phone !== customer.phone && !vouchers.has(x.voucherId));
  }
  delete customer.pendingEmail;
  if (!keepBackupCodes) delete customer.accountBackupCodes;
}
