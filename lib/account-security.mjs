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

// Receipts contain no proof or credential data. They let only the initiating
// session confirm a committed change after a lost reply; they never authorize it.
export const validSecurityOperation = input => input.operationId === undefined || typeof input.operationId === "string" && /^[a-f0-9]{32}$/.test(input.operationId);
export function recordSecurityAction(session, input, action, now) {
  if (!session || typeof input.operationId !== "string" || !/^[a-f0-9]{32}$/.test(input.operationId)) return;
  session.securityActions = [...(session.securityActions || []).filter(row =>
    row.id !== input.operationId && Date.parse(row.completedAt) > +now - 600000),
    { id: input.operationId, action, completedAt: now.toISOString() }].slice(-10);
}
export function securityActionStatus(session, id, now) {
  const receipt = session.securityActions?.find(row => row.id === id && Date.parse(row.completedAt) > +now - 600000);
  return receipt ? { completed: true, action: receipt.action, completedAt: receipt.completedAt } : null;
}
