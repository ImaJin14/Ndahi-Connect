import { purchasedPlan } from "./api/state.mjs";

export const defaultCommissionPercent = 10;

export function normalizeCommissionPercent(value, fallback = defaultCommissionPercent) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!["number", "string"].includes(typeof value) || typeof value === "string" && !value.trim()) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100) return null;
  return Math.round(num * 100) / 100;
}

export function voucherResellerId(voucher) {
  if (!voucher) return null;
  return voucher.assignedResellerId || voucher.generatedByAdminId || null;
}

export function isResellerLedgerAccount(s, user, assignedIds = null) {
  if (!user || !user.id) return false;
  if (user.role === "reseller") return true;
  if (user.commissionPercent !== undefined && user.commissionPercent !== null) return true;
  if (Array.isArray(user.remittances) && user.remittances.length > 0) return true;
  if (Array.isArray(user.adjustments) && user.adjustments.length > 0) return true;
  if (assignedIds) return assignedIds.has(user.id);
  return (s?.vouchers || []).some((v) => v?.assignedResellerId === user.id);
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

export function resolveVoucherCommissionPercent(voucher, user, fallbackRate = defaultCommissionPercent) {
  const settled = normalizeCommissionPercent(voucher?.settledCommissionPercent, null);
  if (settled !== null) return settled;
  const snapshotted = normalizeCommissionPercent(voucher?.commissionPercent, null);
  if (snapshotted !== null) return snapshotted;

  const refTime = String(voucher?.activatedAt || voucher?.createdAt || "");
  if (refTime && Array.isArray(user?.commissionHistory) && user.commissionHistory.length > 0) {
    for (const change of user.commissionHistory) {
      if (change?.effectiveAt && refTime < String(change.effectiveAt)) {
        const historical = normalizeCommissionPercent(change.previousCommissionPercent, null);
        if (historical !== null) return historical;
      }
    }
  }
  return fallbackRate;
}

export function computeResellerRow(s, user) {
  const currentCommissionPercent =
    normalizeCommissionPercent(user?.commissionPercent, defaultCommissionPercent) ?? defaultCommissionPercent;
  const resellerName = String(user?.displayName || user?.username || "Reseller");
  let assignedVouchers = 0;
  let unsoldVouchers = 0;
  let unsoldFaceValue = 0;
  let redeemedVouchers = 0;
  let revokedVouchers = 0;
  let refundedVouchers = 0;
  let assignedFaceValue = 0;
  let cashCollected = 0;
  let commissionEarned = 0;

  for (const v of s.vouchers || []) {
    if (voucherResellerId(v) !== user.id) continue;
    assignedVouchers++;
    const face = voucherFaceValue(s, v);
    const isRevoked = v.status === "revoked";
    const isRefunded = v.status === "refunded" || Boolean(v.refundedAt);
    if (isRevoked) {
      revokedVouchers++;
    }
    if (isRefunded) {
      refundedVouchers++;
    }

    // A redeemed sold voucher represents cash already collected by the reseller;
    // access/refund status never erases it. Refund credits use audited adjustments.
    if (v.activatedAt && v.saleType !== "gift") {
      const rate = resolveVoucherCommissionPercent(v, user, currentCommissionPercent);
      const saleValue = voucherSaleValue(s, v);
      assignedFaceValue += face;
      redeemedVouchers++;
      cashCollected += saleValue;
      commissionEarned += Math.round(saleValue * (rate / 100));
      continue;
    }

    if (isRevoked) {
      // Unredeemed stock that was revoked before sale is no longer sellable.
      continue;
    }

    assignedFaceValue += face;
    if (v.status === "available" && !v.activatedAt) {
      unsoldVouchers++;
      unsoldFaceValue += face;
    }
  }

  const rawAdjustments = Array.isArray(user?.adjustments) ? user.adjustments : [];
  const adjustments = rawAdjustments
    .map((entry) => ({
      id: String(entry?.id || ""),
      resellerId: String(user.id),
      resellerUsername: String(user.username || ""),
      resellerName,
      amount: Math.round(Number(entry?.amount || 0)),
      reason: String(entry?.reason || ""),
      recordedBy: String(entry?.recordedBy || "owner"),
      createdAt: String(entry?.createdAt || ""),
      ...(entry?.operationKey ? { operationKey: String(entry.operationKey) } : {}),
    }))
    .filter((entry) => entry.id && Number.isFinite(entry.amount) && entry.amount !== 0)
    .toReversed();

  const adjustmentTotal = adjustments.reduce((sum, entry) => sum + entry.amount, 0);
  const netPayableToOwner = cashCollected - commissionEarned + adjustmentTotal;

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
      ...(entry?.operationKey ? { operationKey: String(entry.operationKey) } : {}),
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
    role: String(user.role || "reseller"),
    active: user.active !== false,
    commissionPercent: currentCommissionPercent,
    ...(user.commissionEffectiveAt ? { commissionEffectiveAt: String(user.commissionEffectiveAt) } : {}),
    assignedVouchers,
    unsoldVouchers,
    unsoldFaceValue,
    redeemedVouchers,
    revokedVouchers,
    refundedVouchers,
    assignedFaceValue,
    cashCollected,
    commissionEarned,
    adjustmentTotal,
    netPayableToOwner,
    remittedTotal,
    outstandingBalance,
    creditBalance,
    remittances: remittances.slice(0, 25),
    adjustments: adjustments.slice(0, 25),
  };
}

export function resellerLedgerSummary(s, access = {}) {
  const role = access?.role || "owner";
  const assignedIds = new Set();
  for (const v of s?.vouchers || []) {
    if (v?.assignedResellerId) assignedIds.add(v.assignedResellerId);
  }
  const allResellers = (s?.adminUsers || []).filter((u) => isResellerLedgerAccount(s, u, assignedIds));
  const visibleUsers = role === "reseller"
    ? allResellers.filter((u) => u.id === access.staffId)
    : allResellers;

  const resellers = visibleUsers.map((user) => computeResellerRow(s, user));
  const totals = {
    resellerCount: resellers.length,
    activeResellerCount: resellers.filter((r) => r.active && r.role === "reseller").length,
    assignedVouchers: 0,
    unsoldVouchers: 0,
    unsoldFaceValue: 0,
    redeemedVouchers: 0,
    revokedVouchers: 0,
    refundedVouchers: 0,
    assignedFaceValue: 0,
    cashCollected: 0,
    commissionEarned: 0,
    adjustmentTotal: 0,
    netPayableToOwner: 0,
    remittedTotal: 0,
    outstandingBalance: 0,
    creditBalance: 0,
  };

  for (const row of resellers) {
    totals.assignedVouchers += row.assignedVouchers;
    totals.unsoldVouchers += row.unsoldVouchers;
    totals.unsoldFaceValue += row.unsoldFaceValue;
    totals.redeemedVouchers += row.redeemedVouchers;
    totals.revokedVouchers += row.revokedVouchers;
    totals.refundedVouchers += row.refundedVouchers;
    totals.assignedFaceValue += row.assignedFaceValue;
    totals.cashCollected += row.cashCollected;
    totals.commissionEarned += row.commissionEarned;
    totals.adjustmentTotal += row.adjustmentTotal;
    totals.netPayableToOwner += row.netPayableToOwner;
    totals.remittedTotal += row.remittedTotal;
    totals.outstandingBalance += row.outstandingBalance;
    totals.creditBalance += row.creditBalance;
  }

  const remittances = resellers
    .flatMap((row) => row.remittances)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 50);

  const adjustments = resellers
    .flatMap((row) => row.adjustments)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 50);

  return {
    scope: role === "reseller" ? "self" : "all",
    canManageRemittances: role === "owner",
    canAssignInventory: role === "owner" || role === "operator",
    totals,
    resellers,
    remittances,
    adjustments,
  };
}
