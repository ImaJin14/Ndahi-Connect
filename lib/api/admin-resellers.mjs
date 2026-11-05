import { randomUUID } from "node:crypto";
import { json } from "./http.mjs";
import { audit } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { voucherAccess } from "../voucher-access.mjs";
import {
  defaultCommissionPercent,
  normalizeCommissionPercent,
  computeResellerRow,
  resellerLedgerSummary,
} from "../reseller-ledger.mjs";

export function createAdminResellersRoutes({ clock }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role }) {
    const access = voucherAccess(role, adminUser, administrator);

    if (req.method === "GET" && url.pathname === "/api/admin/resellers/ledger") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, resellerLedgerSummary(s, access));
    }

    if (req.method === "POST" && url.pathname === "/api/admin/resellers/commission") {
      if (role !== "owner") {
        audit(s, "admin.authorization.denied", req, { role, path: url.pathname });
        return json(res, 403, { error: "Only the owner can configure reseller commission rates." });
      }
      const resellerId = String(i.resellerId || "").trim();
      const target = (s.adminUsers || []).find((u) => u.id === resellerId && u.role === "reseller");
      if (!target) {
        return json(res, 404, { error: "Reseller account not found." });
      }
      const commissionPercent = normalizeCommissionPercent(i.commissionPercent, null);
      if (commissionPercent === null) {
        return json(res, 400, { error: "Enter a commission percentage between 0 and 100." });
      }
      const previousCommissionPercent = normalizeCommissionPercent(
        target.commissionPercent,
        defaultCommissionPercent,
      );
      target.commissionPercent = commissionPercent;
      target.updatedAt = clock().toISOString();
      audit(s, "reseller.commission_updated", req, {
        resellerId: target.id,
        resellerUsername: target.username,
        previousCommissionPercent,
        commissionPercent,
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
      const target = (s.adminUsers || []).find((u) => u.id === resellerId && u.role === "reseller");
      if (!target) {
        return json(res, 404, { error: "Reseller account not found." });
      }
      const amount = Number(i.amount);
      if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) {
        return json(res, 400, { error: "Enter a whole FCFA remittance amount greater than 0." });
      }
      const note = String(i.note || "").trim().slice(0, 200);
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
        outstandingBalance: updatedRow.outstandingBalance,
      });
      return json(res, 201, {
        remittance,
        reseller: updatedRow,
        resellerLedger: resellerLedgerSummary(s, access),
      });
    }

    return NOT_HANDLED;
  };
}
