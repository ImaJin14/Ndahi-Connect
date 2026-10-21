import { findPlan } from "./api/state.mjs";

// This is the complete voucher read policy. No role inherits contact/payment
// access from possession of a code, a customer relation, or a session's old role.
export function voucherAccess(role, adminUser, administrator = {}) {
  const operational = role === "owner" || role === "operator";
  return Object.freeze({
    role, staffId: adminUser?.id || null,
    contacts: operational, payments: operational,
    codes: operational || role === "reseller", manage: operational,
    scopeKey: JSON.stringify([adminUser?.id || administrator.userId || "legacy", role, operational]),
  });
}
export function mayReadVoucher(voucher, access) {
  if (["owner", "operator", "auditor"].includes(access.role)) return true;
  if (access.role !== "reseller" || !access.staffId) return false;
  // Explicit assignment takes precedence over the original generator. Legacy
  // generatedByAdmin:true does not identify a reseller and grants no access.
  return voucher.assignedResellerId
    ? voucher.assignedResellerId === access.staffId
    : voucher.generatedByAdminId === access.staffId;
}
export function voucherReadState(s, access) {
  const vouchers = s.vouchers.filter((v) => mayReadVoucher(v, access)), ids = new Set(vouchers.map((v) => v.id));
  return { ...s, vouchers, sessions: s.sessions.filter((x) => ids.has(x.voucherId)),
    ...(access.payments ? {} : { customers: [], payments: [], auditLogs: [], securityEvents: [], events: [], routerCommands: [] }) };
}
const pick = (source, keys) => Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
const planView = (s, v) => pick(findPlan(s, v.planId), ["id", "name", "price", "quotaGb", "validityHours", "deviceLimit"]);
const remaining = (v) => v.quotaBytes === null ? null : Math.max(0, Number(v.quotaBytes || 0) - Number(v.usedBytes || 0));
export function voucherListView(s, v, access) {
  return {
    ...pick(v, ["id", "planId", "status", "activatedAt", "createdAt", "expiresAt", "quotaBytes", "usedBytes", "deviceLimit", "generatedByAdmin", "resale", "saleType", "saleAmount", "faceValue"]),
    ...(access.codes ? { code: v.code } : {}),
    ...(access.contacts ? { customerId: v.customerId } : {}),
    ...(access.payments ? pick(v, ["paymentId", "emailStatus"]) : {}),
    plan: planView(s, v), remainingBytes: remaining(v),
    activeDevices: Array.isArray(v.wifiDevices) ? v.wifiDevices.length : s.sessions.filter((x) => x.voucherId === v.id && x.status === "online").length,
    permissions: { code: access.codes, manage: access.manage },
  };
}
export function voucherOwnershipDetails(s, v, access) {
  const customer = v.customerId && s.customers.find((c) => c.id === v.customerId),
    payment = access.payments && v.paymentId && s.payments.find((p) => p.id === v.paymentId);
  return {
    voucher: pick(v, ["id", "status", "activatedAt", "createdAt", "expiresAt", "quotaBytes", "usedBytes", "deviceLimit"]),
    plan: planView(s, v), remainingBytes: remaining(v),
    ownership: {
      state: !v.customerId ? "unlinked" : customer ? "linked" : "unavailable",
      ...(customer && access.contacts ? { customerId: customer.id, name: customer.name || "", accountPhone: customer.phone || "" } : {}),
    },
    ...(payment ? { payment: pick(payment, ["id", "provider", "providerReference", "status", "amount", "currency", "payerPhone", "createdAt", "confirmedAt"]) } : {}),
    permissions: { contacts: access.contacts, payment: access.payments }, scopeKey: access.scopeKey,
  };
}
