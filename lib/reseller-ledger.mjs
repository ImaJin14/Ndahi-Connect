import { purchasedPlan } from "./api/state.mjs";

export const defaultCommissionPercent = 10;

export function normalizeCommissionPercent(value, fallback = defaultCommissionPercent) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100) return null;
  return Math.round(num * 100) / 100;
}

export function voucherResellerId(voucher) {
  if (!voucher) return null;
  return voucher.assignedResellerId || voucher.generatedByAdminId || null;
}

function voucherFaceValue(s, voucher) {
  const explicit = Number(voucher?.faceValue);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const planPrice = Number(purchasedPlan(s, voucher)?.price);
  return Number.isFinite(planPrice) && planPrice > 0 ? planPrice : 0;
}

function voucherSaleValue(s, voucher) {
  const explicit = Number(voucher?.saleAmount);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return voucherFaceValue(s, voucher);
}

export function computeResellerRow(s, user) {
  const commissionPercent = normalizeCommissionPercent(user?.commissionPercent, defaultCommissionPercent) ?? defaultCommissionPercent;
  const resellerName = String(user?.displayName || user?.username || "Reseller");
  let assignedVouchers = 0;
  let unsoldVouchers = 0;
  let unsoldFaceValue = 0;
  let redeemedVouchers = 0;
  let revokedVouchers = 0;
  let assignedFaceValue = 0;
  let cashCollected = 0;

  for (const v of s.vouchers || []) {
    if (voucherResellerId(v) !== user.id) continue;
    assignedVouchers++;
    const face = voucherFaceValue(s, v);
    if (v.status === "revoked") {
      revokedVouchers++;
      continue;
    }
    assignedFaceValue += face;
    if (v.status === "available" && !v.activatedAt) {
      unsoldVouchers++;
      unsoldFaceValue += face;
    } else if (v.activatedAt && v.saleType !== "gift") {
      redeemedVouchers++;
      cashCollected += voucherSaleValue(s, v);
    }
  }

  const commissionEarned = Math.round(cashCollected * (commissionPercent / 100));
  const netPayableToOwner = Math.max(0, cashCollected - commissionEarned);
  const rawRemittances = Array.isArray(user?.remittances) ? user.remittances : [];
  const remittances = rawRemittances
    .map((entry) => ({
      id: String(entry?.id || ""),
      resellerId: String(user.id),
      resellerUsername: String(user.username || ""),
      resellerName,
      amount: Math.max(0, Math.round(Number(entry?.amount || 0))),
      note: String(entry?.note || ""),
      recordedBy: String(entry?.recordedBy || "owner"),
      createdAt: String(entry?.createdAt || ""),
    }))
    .filter((entry) => entry.id && entry.amount > 0)
    .toReversed();

  const remittedTotal = remittances.reduce((sum, entry) => sum + entry.amount, 0);
  const outstandingBalance = Math.max(0, netPayableToOwner - remittedTotal);
  const creditBalance = Math.max(0, remittedTotal - netPayableToOwner);

  return {
    resellerId: String(user.id),
    username: String(user.username || ""),
    displayName: resellerName,
    active: user.active !== false,
    commissionPercent,
    assignedVouchers,
    unsoldVouchers,
    unsoldFaceValue,
    redeemedVouchers,
    revokedVouchers,
    assignedFaceValue,
    cashCollected,
    commissionEarned,
    netPayableToOwner,
    remittedTotal,
    outstandingBalance,
    creditBalance,
    remittances: remittances.slice(0, 25),
  };
}

export function resellerLedgerSummary(s, access = {}) {
  const role = access?.role || "owner";
  const allResellers = (s.adminUsers || []).filter((u) => u && u.role === "reseller");
  const visibleUsers = role === "reseller"
    ? allResellers.filter((u) => u.id === access.staffId)
    : allResellers;

  const resellers = visibleUsers.map((user) => computeResellerRow(s, user));
  const totals = {
    resellerCount: resellers.length,
    activeResellerCount: resellers.filter((r) => r.active).length,
    assignedVouchers: 0,
    unsoldVouchers: 0,
    unsoldFaceValue: 0,
    redeemedVouchers: 0,
    revokedVouchers: 0,
    assignedFaceValue: 0,
    cashCollected: 0,
    commissionEarned: 0,
    netPayableToOwner: 0,
    remittedTotal: 0,
    outstandingBalance: 0,
  };

  for (const row of resellers) {
    totals.assignedVouchers += row.assignedVouchers;
    totals.unsoldVouchers += row.unsoldVouchers;
    totals.unsoldFaceValue += row.unsoldFaceValue;
    totals.redeemedVouchers += row.redeemedVouchers;
    totals.revokedVouchers += row.revokedVouchers;
    totals.assignedFaceValue += row.assignedFaceValue;
    totals.cashCollected += row.cashCollected;
    totals.commissionEarned += row.commissionEarned;
    totals.netPayableToOwner += row.netPayableToOwner;
    totals.remittedTotal += row.remittedTotal;
    totals.outstandingBalance += row.outstandingBalance;
  }

  const remittances = resellers
    .flatMap((row) => row.remittances)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 50);

  return {
    scope: role === "reseller" ? "self" : "all",
    canManageRemittances: role === "owner",
    canAssignInventory: role === "owner" || role === "operator",
    totals,
    resellers,
    remittances,
  };
}
