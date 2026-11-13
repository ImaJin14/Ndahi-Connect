import { purchasedPlan } from "./api/state.mjs";

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
const planView = (s, v) => pick(purchasedPlan(s, v), ["id", "name", "price", "quotaGb", "validityHours", "deviceLimit"]);
const remaining = (v) => v.quotaBytes === null ? null : Math.max(0, Number(v.quotaBytes || 0) - Number(v.usedBytes || 0));
export function voucherListView(s, v, access) {
  return {
    ...pick(v, ["id", "planId", "status", "activatedAt", "createdAt", "expiresAt", "quotaBytes", "usedBytes", "deviceLimit", "accessMode", "generatedByAdmin", "resale", "saleType", "saleAmount", "faceValue"]),
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
    voucher: pick(v, ["id", "status", "activatedAt", "createdAt", "expiresAt", "quotaBytes", "usedBytes", "deviceLimit", "accessMode"]),
    plan: planView(s, v), remainingBytes: remaining(v),
    ownership: {
      state: !v.customerId ? "unlinked" : customer ? "linked" : "unavailable",
      ...(customer && access.contacts ? { customerId: customer.id, name: customer.name || "", accountPhone: customer.phone || "" } : {}),
    },
    ...(payment ? { payment: pick(payment, ["id", "provider", "providerReference", "status", "amount", "currency", "payerPhone", "createdAt", "confirmedAt"]) } : {}),
    permissions: { contacts: access.contacts, payment: access.payments }, scopeKey: access.scopeKey,
  };
}

// The voucher detail page (redesign AdminVoucherDetail, #258): the code (for
// roles that may see codes), how it was sold, its devices, a history from the
// audit trail and the voucher's own times, and the router sync state.
// Staff names in the history are shown to operational and auditor roles only.
export function voucherDetail(s, v, access) {
  const names = new Map((s.adminUsers || []).map((u) => [u.username, u.displayName || u.name || u.username]));
  const showStaff = access.role !== "reseller", by = (actor) => (showStaff && actor && actor !== "system" ? names.get(actor) || actor : null);
  const mine = (a) => a.meta?.voucherId === v.id || (Array.isArray(a.meta?.voucherIds) && a.meta.voucherIds.includes(v.id)) ||
    (v.giftBatchId && a.action === "customer.bulk_gift" && a.meta?.batchId === v.giftBatchId);
  const history = [];
  for (const a of (s.auditLogs || []).filter(mine)) {
    const kind = { "voucher.generated": "created", "voucher.resale_batch_generated": "created", "customer.bulk_gift": "created",
      "voucher.sale_classified": "classified", "voucher.printed": "printed", "voucher.email_retried": "email_resent", "voucher.revoked": "revoked" }[a.action];
    if (!kind) continue;
    history.push({ kind, at: a.at, by: by(a.actor),
      ...(kind === "created" ? { quantity: a.action === "customer.bulk_gift" ? a.meta?.count ?? null : a.meta?.quantity ?? null, saleType: a.meta?.saleType ?? (a.action === "customer.bulk_gift" ? "gift" : null) } : {}),
      ...(kind === "classified" ? { saleType: a.meta?.saleType ?? null } : {}),
      ...(kind === "email_resent" ? { sent: a.meta?.sent === true } : {}) });
  }
  // Bought online: created when the paid voucher was issued (activation).
  if (!history.some((e) => e.kind === "created")) history.push({ kind: "created", at: v.giftedAt || v.createdAt || v.activatedAt || null, by: null, ...(v.paymentId ? { online: true } : {}) });
  const customer = v.customerId && s.customers.find((c) => c.id === v.customerId);
  if (v.activatedAt) history.push({ kind: "redeemed", at: v.activatedAt, ...(customer && access.contacts ? { customer: customer.name || "" } : {}) });
  if (v.status === "exhausted") history.push({ kind: "used_up", at: v.exhaustedAt || null });
  if (v.status === "expired") history.push({ kind: "expired", at: v.expiresAt || null });
  history.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const commands = (s.routerCommands || []).filter((c) => c.targetId === v.id);
  const last = commands.reduce((latest, c) => !latest || (Date.parse(c.processedAt || c.lastAttemptAt || c.at) || 0) >= (Date.parse(latest.processedAt || latest.lastAttemptAt || latest.at) || 0) ? c : latest, null);
  return {
    ...(access.codes ? { code: v.code } : {}),
    saleType: v.saleType || null, saleAmount: v.saleAmount ?? null, faceValue: v.faceValue ?? null, resale: v.resale === true,
    generatedByAdmin: v.generatedByAdmin === true, exhaustedAt: v.exhaustedAt || null,
    activeDevices: Array.isArray(v.wifiDevices) ? v.wifiDevices.length : 0,
    ...(access.payments ? { email: { status: v.emailStatus || null, sentAt: v.emailSentAt || null } } : {}),
    history,
    routerSync: { status: v.routerSyncStatus || null, ...(last ? { action: last.action, commandStatus: last.status, result: last.result || null, at: last.processedAt || last.lastAttemptAt || last.at || null } : {}) },
  };
}
