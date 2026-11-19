import { randomUUID } from "node:crypto";
import { json } from "./http.mjs";
import { audit, purchasedPlan } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { mayReadVoucher, voucherAccess, voucherListView } from "../voucher-access.mjs";
import {
  defaultCommissionPercent,
  normalizeCommissionPercent,
  voucherResellerId,
  isResellerLedgerAccount,
  resolveVoucherCommissionPercent,
  voucherSaleValue,
  computeResellerRow,
  resellerLedgerSummary,
} from "../reseller-ledger.mjs";

function extractOperationKey(req, body = {}) {
  const values = [req.headers?.["idempotency-key"], req.headers?.["x-idempotency-key"],
    body.operationKey, body.idempotencyKey, body.requestKey].filter(value => value !== undefined);
  if (!values.length || values.some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{16,120}$/.test(value)) ||
    new Set(values).size !== 1) return null;
  return values[0];
}

function conflictingOperation(s, operationKey, type) {
  return (s.adminUsers || []).some(u => (type === "remittance" ? u.adjustments || [] : u.remittances || [])
    .some(entry => entry.operationKey === operationKey) || (u.stockRequests || []).some(entry => entry.operationKey === operationKey)) ||
    (s.vouchers || []).some(v => v.cashSale?.operationKey === operationKey);
}

function usedOperation(s, key) {
  return (s.adminUsers || []).some(u => [...(u.remittances || []), ...(u.adjustments || []), ...(u.stockRequests || [])]
    .some(entry => entry.operationKey === key)) || (s.vouchers || []).some(v => v.cashSale?.operationKey === key);
}

function sellable(v, access, now) {
  return mayReadVoucher(v, access) && v.status === "available" && !v.activatedAt && !v.cashSale &&
    !v.customerId && !v.paymentId &&
    v.saleType !== "gift" && !v.reservation && (!v.startBy || (Number.isFinite(Date.parse(v.startBy)) && Date.parse(v.startBy) > +now));
}

function resellerHome(s, user, access, now) {
  const week = new Date(+now + 3600000); // Cameroon time, UTC+1.
  const daysSinceMonday = (week.getUTCDay() + 6) % 7;
  const weekStart = Date.UTC(week.getUTCFullYear(), week.getUTCMonth(), week.getUTCDate() - daysSinceMonday) - 3600000;
  const owned = s.vouchers.filter(v => mayReadVoucher(v, access));
  const stock = owned.filter(v => sellable(v, access, now)).map(v => voucherListView(s, v, access));
  const weekly = s.vouchers.filter(v => v.cashSale ? v.cashSale.resellerId === user.id : mayReadVoucher(v, access)).filter(v => {
    const when = v.cashSale?.receivedAt || (v.saleType !== "gift" ? v.activatedAt : null);
    const time = Date.parse(when);
    return Number.isFinite(time) && time >= weekStart && time <= +now;
  });
  const weeklyCollected = weekly.reduce((sum, voucher) => sum + voucherSaleValue(s, voucher), 0);
  const weeklyCommission = weekly.reduce((sum, voucher) => sum + Math.round(voucherSaleValue(s, voucher) *
    resolveVoucherCommissionPercent(voucher, user, normalizeCommissionPercent(user.commissionPercent, defaultCommissionPercent) ?? defaultCommissionPercent) / 100), 0);
  return { reseller: computeResellerRow(s, user), stock, stockCount: stock.length, salesThisWeek: weekly.length, weeklyCollected, weeklyCommission, weekStart: new Date(weekStart).toISOString(),
    salesTimeBasis: "cash-received-or-legacy-activation", stockRequests: (user.stockRequests || []).slice(-20).reverse() };
}

export function createAdminResellersRoutes({ clock }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role }) {
    const access = voucherAccess(role, adminUser, administrator);

    if (req.method === "GET" && url.pathname === "/api/admin/resellers/ledger") {
      res.setHeader("cache-control", "no-store");
      if (url.searchParams.get("view") === "home") {
        if (role !== "reseller" || !adminUser?.id) return json(res, 403, { error: "Reseller account required." });
        return json(res, 200, resellerHome(s, adminUser, access, clock()));
      }
      if (url.searchParams.get("view") === "stock-requests") {
        if (role !== "owner") return json(res, 403, { error: "Only the owner can review stock requests." });
        return json(res, 200, { requests: (s.adminUsers || []).flatMap(u => (u.stockRequests || []).map(r => ({ ...r, resellerId: u.id, resellerName: u.displayName || u.username }))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
      }
      return json(res, 200, resellerLedgerSummary(s, access));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/resellers/cash-sale") {
      if (role !== "reseller" || !adminUser?.id) return json(res, 403, { error: "Reseller account required." });
      const operationKey = extractOperationKey(req, i), voucherId = String(i.voucherId || "");
      if (!operationKey) return json(res, 400, { code: "OPERATION_KEY_REQUIRED", error: "Start a fresh sale with a valid operation key." });
      const previous = (s.vouchers || []).find(v => v.cashSale?.operationKey === operationKey);
      if (previous) {
        if (previous.id !== voucherId || previous.cashSale.resellerId !== adminUser.id) return json(res, 409, { code: "IDEMPOTENCY_CONFLICT", error: "This operation key was used for another sale." });
        return json(res, 200, { replayed: true, sale: previous.cashSale, reseller: computeResellerRow(s, adminUser) });
      }
      if (usedOperation(s, operationKey)) return json(res, 409, { code: "IDEMPOTENCY_CONFLICT", error: "This operation key was used for another action." });
      const voucher = (s.vouchers || []).find(v => v.id === voucherId);
      if (!voucher || !mayReadVoucher(voucher, access)) return json(res, 404, { error: "Voucher not found." });
      if (!sellable(voucher, access, clock())) return json(res, 409, { code: "VOUCHER_NOT_SELLABLE", error: "This voucher is no longer available for sale." });
      const amount = Number(voucher.faceValue) > 0 ? Number(voucher.faceValue) : Number(purchasedPlan(s, voucher)?.price);
      if (!Number.isSafeInteger(amount) || amount <= 0) return json(res, 409, { code: "PRICE_UNAVAILABLE", error: "The voucher price is unavailable." });
      const sale = { id: `sale-${randomUUID()}`, operationKey, resellerId: adminUser.id, amount,
        commissionPercent: resolveVoucherCommissionPercent(voucher, adminUser, normalizeCommissionPercent(adminUser.commissionPercent, defaultCommissionPercent) ?? defaultCommissionPercent),
        receivedAt: clock().toISOString() };
      voucher.cashSale = sale;
      audit(s, "reseller.cash_sale_recorded", req, { voucherId, resellerId: adminUser.id, saleId: sale.id, amount, operationKey });
      return json(res, 201, { replayed: false, sale, reseller: computeResellerRow(s, adminUser) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/resellers/stock-requests") {
      if (role !== "reseller" || !adminUser?.id) return json(res, 403, { error: "Reseller account required." });
      const operationKey = extractOperationKey(req, i);
      if (!operationKey) return json(res, 400, { code: "OPERATION_KEY_REQUIRED", error: "Start a fresh request with a valid operation key." });
      const previous = (adminUser.stockRequests || []).find(r => r.operationKey === operationKey);
      if (previous) return json(res, 200, { replayed: true, request: previous });
      if (usedOperation(s, operationKey)) return json(res, 409, { code: "IDEMPOTENCY_CONFLICT", error: "This operation key was used for another action." });
      const request = { id: `stock-${randomUUID()}`, operationKey, createdAt: clock().toISOString() };
      (adminUser.stockRequests ||= []).push(request);
      audit(s, "reseller.stock_requested", req, { resellerId: adminUser.id, requestId: request.id, operationKey });
      return json(res, 201, { replayed: false, request });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/resellers/commission") {
      if (role !== "owner") {
        audit(s, "admin.authorization.denied", req, { role, path: url.pathname });
        return json(res, 403, { error: "Only the owner can configure reseller commission rates." });
      }
      const resellerId = String(i.resellerId || "").trim();
      const target = (s.adminUsers || []).find((u) => u.id === resellerId && isResellerLedgerAccount(s, u));
      if (!target) {
        return json(res, 404, { error: "Reseller account not found." });
      }
      const commissionPercent = normalizeCommissionPercent(i.commissionPercent, null);
      if (commissionPercent === null) {
        return json(res, 400, { error: "Enter a commission percentage between 0 and 100." });
      }
      const previousCommissionPercent =
        normalizeCommissionPercent(target.commissionPercent, defaultCommissionPercent) ??
        defaultCommissionPercent;
      const effectiveAt = clock().toISOString();
      const applyToUnsoldStock = i.applyToUnsoldStock === true || i.applyToUnsoldStock === "true";

      // Snapshot agreed commission on existing vouchers before changing the rate so
      // completed sales are never rewritten retroactively.
      let repricedUnsoldCount = 0;
      for (const v of s.vouchers || []) {
        if (voucherResellerId(v) !== target.id) continue;
        const priorRate = resolveVoucherCommissionPercent(v, target, previousCommissionPercent);
        if (v.activatedAt) {
          v.settledCommissionPercent ??= priorRate;
          v.commissionPercent ??= v.settledCommissionPercent;
        } else if (v.status === "available" && applyToUnsoldStock) {
          v.commissionPercent = commissionPercent;
          repricedUnsoldCount++;
        } else {
          v.commissionPercent ??= priorRate;
        }
      }

      if (!Array.isArray(target.commissionHistory)) target.commissionHistory = [];
      target.commissionHistory.push({
        previousCommissionPercent,
        commissionPercent,
        effectiveAt,
        applyToUnsoldStock,
        repricedUnsoldCount,
        updatedBy: String(adminUser?.username || req.adminActor || "owner"),
      });
      target.commissionPercent = commissionPercent;
      target.commissionEffectiveAt = effectiveAt;
      target.updatedAt = effectiveAt;

      audit(s, "reseller.commission_updated", req, {
        resellerId: target.id,
        resellerUsername: target.username,
        previousCommissionPercent,
        commissionPercent,
        effectiveAt,
        applyToUnsoldStock,
        repricedUnsoldCount,
      });
      return json(res, 200, {
        reseller: computeResellerRow(s, target),
        resellerLedger: resellerLedgerSummary(s, access),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/resellers/remittances") {
      if (role !== "owner") {
        audit(s, "admin.authorization.denied", req, { role, path: url.pathname });
        return json(res, 403, { error: "Only the owner can record cash remittances." });
      }
      const resellerId = String(i.resellerId || "").trim();
      const target = (s.adminUsers || []).find((u) => u.id === resellerId && isResellerLedgerAccount(s, u));
      if (!target) {
        return json(res, 404, { error: "Reseller account not found." });
      }
      const amount = Number(i.amount);
      if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) {
        return json(res, 400, { error: "Enter a whole FCFA remittance amount greater than 0." });
      }
      const note = String(i.note || "").trim().slice(0, 200);
      const operationKey = extractOperationKey(req, i);
      if (!operationKey) return json(res, 400, { code: "OPERATION_KEY_REQUIRED", error: "Start a fresh cash handoff with a valid operation key." });
      if (conflictingOperation(s, operationKey, "remittance")) return json(res, 409, { code: "IDEMPOTENCY_CONFLICT", error: "This operation key belongs to another ledger action." });

      if (operationKey) {
        for (const u of s.adminUsers || []) {
          const existing = (u.remittances || []).find((entry) => entry?.operationKey === operationKey);
          if (existing) {
            if (
              u.id !== target.id ||
              Number(existing.amount) !== amount ||
              String(existing.note || "") !== note
            ) {
              return json(res, 409, {
                code: "IDEMPOTENCY_CONFLICT",
                error: "This remittance operation key was already used for a different handoff.",
              });
            }
            return json(res, 200, {
              replayed: true,
              remittance: existing,
              reseller: computeResellerRow(s, target),
              resellerLedger: resellerLedgerSummary(s, access),
            });
          }
        }
      }

      const createdAt = clock().toISOString();
      const remittance = {
        id: `remit-${randomUUID()}`,
        resellerId: target.id,
        resellerUsername: target.username,
        resellerName: String(target.displayName || target.username || "Reseller"),
        amount,
        note,
        recordedBy: String(adminUser?.username || req.adminActor || "owner"),
        recordedById: adminUser?.id || null,
        createdAt,
        ...(operationKey ? { operationKey } : {}),
      };
      if (!Array.isArray(target.remittances)) target.remittances = [];
      target.remittances.push(remittance);
      target.updatedAt = createdAt;

      const updatedRow = computeResellerRow(s, target);
      audit(s, "reseller.remittance_recorded", req, {
        remittanceId: remittance.id,
        resellerId: target.id,
        resellerUsername: target.username,
        amount,
        note: note || undefined,
        operationKey: operationKey || undefined,
        outstandingBalance: updatedRow.outstandingBalance,
      });
      return json(res, 201, {
        replayed: false,
        remittance,
        reseller: updatedRow,
        resellerLedger: resellerLedgerSummary(s, access),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/resellers/adjustments") {
      if (role !== "owner") {
        audit(s, "admin.authorization.denied", req, { role, path: url.pathname });
        return json(res, 403, { error: "Only the owner can record reseller balance adjustments." });
      }
      const resellerId = String(i.resellerId || "").trim();
      const target = (s.adminUsers || []).find((u) => u.id === resellerId && isResellerLedgerAccount(s, u));
      if (!target) {
        return json(res, 404, { error: "Reseller account not found." });
      }
      const amount = Number(i.amount);
      if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100_000_000) {
        return json(res, 400, { error: "Enter a non-zero whole FCFA adjustment amount." });
      }
      const reason = String(i.reason || "").trim().slice(0, 200);
      if (!reason) {
        return json(res, 400, { error: "Enter an audit reason for this balance adjustment." });
      }
      const operationKey = extractOperationKey(req, i);
      if (!operationKey) return json(res, 400, { code: "OPERATION_KEY_REQUIRED", error: "Start a fresh adjustment with a valid operation key." });
      if (conflictingOperation(s, operationKey, "adjustment")) return json(res, 409, { code: "IDEMPOTENCY_CONFLICT", error: "This operation key belongs to another ledger action." });
      if (operationKey) {
        for (const u of s.adminUsers || []) {
          const existing = (u.adjustments || []).find((entry) => entry?.operationKey === operationKey);
          if (existing) {
            if (
              u.id !== target.id ||
              Number(existing.amount) !== amount ||
              String(existing.reason || "") !== reason
            ) {
              return json(res, 409, {
                code: "IDEMPOTENCY_CONFLICT",
                error: "This adjustment operation key was already used for a different adjustment.",
              });
            }
            return json(res, 200, {
              replayed: true,
              adjustment: existing,
              reseller: computeResellerRow(s, target),
              resellerLedger: resellerLedgerSummary(s, access),
            });
          }
        }
      }

      const createdAt = clock().toISOString();
      const adjustment = {
        id: `adj-${randomUUID()}`,
        resellerId: target.id,
        resellerUsername: target.username,
        resellerName: String(target.displayName || target.username || "Reseller"),
        amount,
        reason,
        recordedBy: String(adminUser?.username || req.adminActor || "owner"),
        recordedById: adminUser?.id || null,
        createdAt,
        ...(operationKey ? { operationKey } : {}),
      };
      if (!Array.isArray(target.adjustments)) target.adjustments = [];
      target.adjustments.push(adjustment);
      target.updatedAt = createdAt;

      const updatedRow = computeResellerRow(s, target);
      audit(s, "reseller.adjustment_recorded", req, {
        adjustmentId: adjustment.id,
        resellerId: target.id,
        resellerUsername: target.username,
        amount,
        reason,
        operationKey: operationKey || undefined,
        outstandingBalance: updatedRow.outstandingBalance,
      });
      return json(res, 201, {
        replayed: false,
        adjustment,
        reseller: updatedRow,
        resellerLedger: resellerLedgerSummary(s, access),
      });
    }

    return NOT_HANDLED;
  };
}
