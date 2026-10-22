import { json } from "./http.mjs";
import { audit, findPlan, uniqueActivationCode, GB, view } from "./state.mjs";
import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { mayReadVoucher, voucherAccess, voucherOwnershipDetails, voucherListView } from "../voucher-access.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createAdminVouchersRoutes({ deliverVoucherEmail, clock }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    const access = voucherAccess(role, adminUser, administrator);
    if (req.method === "GET" && /^\/api\/admin\/vouchers\/[^/]+\/details$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[4]), voucher = s.vouchers.find((v) => v.id === id);
      if (!voucher || !mayReadVoucher(voucher, access)) return json(res, 404, { error: "Voucher not found." });
      if (url.searchParams.get("checkScope") === "1") return json(res, 200, { id: voucher.id, scopeKey: access.scopeKey });
      return json(res, 200, voucherOwnershipDetails(s, voucher, access));
    }
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/resend-email") {
      const voucher = s.vouchers.find((item) => item.id === i.voucherId);
      if (!voucher) return json(res, 404, { error: "Voucher not found." });
      const sent = await deliverVoucherEmail(s, voucher, true);
      audit(s, "voucher.email_retried", req, { voucherId: voucher.id, sent });
      return json(res, 200, {
        sent,
        emailStatus: voucher.emailStatus,
        error: sent ? undefined : voucher.emailLastError,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/generate") {
      const resale = i.purpose === "resale",
        // Resale stock is for selling unless marked otherwise; a voucher handed
        // straight to a customer must say whether it was paid for.
        saleType = i.saleType || (resale ? "sold" : "");
      if (!["sold", "gift"].includes(saleType)) {
        return json(res, 400, { error: "Choose whether this voucher was sold or given as a gift." });
      }
      if (saleType === "gift" && !["owner", "operator"].includes(role)) {
        return json(res, 403, { error: "Only owners and operators can issue gift vouchers." });
      }
      if (role === "reseller" && !resale) return json(res, 403, { error: "Resellers can generate unassigned resale stock only." });
      let plan;
      if (i.planMode === "custom") {
        plan = {
          id: `resale-${randomUUID()}`,
          name: String(i.name || "")
            .trim()
            .slice(0, 80),
          price: Number(i.price),
          quotaGb: i.quotaGb === "" || i.quotaGb === null ? null : Number(i.quotaGb),
          validityHours: Number(i.validityHours),
          deviceLimit: Number(i.deviceLimit),
          custom: true,
          resale: true,
          createdAt: clock().toISOString(),
        };
        if (
          !plan.name ||
          !Number.isFinite(plan.price) ||
          plan.price < 0 ||
          (plan.quotaGb !== null && (!Number.isFinite(plan.quotaGb) || plan.quotaGb <= 0)) ||
          !Number.isFinite(plan.validityHours) ||
          plan.validityHours <= 0 ||
          !Number.isInteger(plan.deviceLimit) ||
          plan.deviceLimit < 1
        )
          return json(res, 400, { error: "Enter valid custom voucher details." });
      } else plan = findPlan(s, i.planId);
      const c = resale ? null : s.customers.find((x) => x.id === i.customerId),
        quantity = resale ? Number(i.quantity || 1) : 1;
      if (!plan || (!resale && !c)) {
        return json(res, 400, {
          error: resale ? "Choose a valid bundle." : "Customer and bundle are required.",
        });
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        return json(res, 400, { error: "Generate between 1 and 100 vouchers at a time." });
      }
      const activeVoucher = c ? s.vouchers.find((v) => v.customerId === c.id && v.status === "active") : null;
      if (activeVoucher) {
        const replaceActive = i.replaceActive === true || i.replaceActive === "true";
        if (!replaceActive) {
          const activePlan = findPlan(s, activeVoucher.planId);
          return json(res, 409, {
            code: "ACTIVE_BUNDLE_EXISTS",
            error: "Customer already has an active voucher. Check 'Replace customer\'s existing active bundle' to replace it.",
            activeBundle: {
              id: activeVoucher.id,
              planId: activeVoucher.planId,
              name: activePlan?.name || "Active bundle",
              expiresAt: activeVoucher.expiresAt,
            },
            canReplace: true,
          });
        }
      }
      if (i.planMode === "custom") s.bundles.push(plan);
      const generated = [];
      for (let index = 0; index < quantity; index++) {
        const t = clock().getTime(),
          v = {
            id: randomUUID(),
            customerId: c?.id || null,
            planId: plan.id,
            code: uniqueActivationCode(s),
            status: resale ? "available" : "active",
            activatedAt: resale ? null : new Date(t).toISOString(),
            expiresAt: resale ? null : new Date(t + plan.validityHours * 36e5).toISOString(),
            quotaBytes: plan.quotaGb === null ? null : plan.quotaGb * GB,
            usedBytes: 0,
            deviceLimit: plan.deviceLimit,
            generatedByAdmin: true,
            ...(adminUser?.id ? { generatedByAdminId: adminUser.id } : {}),
            ...(role === "reseller" && adminUser?.id ? { assignedResellerId: adminUser.id } : {}),
            resale,
            saleType,
            saleAmount: saleType === "sold" ? plan.price : 0,
            faceValue: plan.price,
            createdAt: new Date(t).toISOString(),
            ...(activeVoucher ? { replacesVoucherId: activeVoucher.id } : {}),
          };
        s.vouchers.unshift(v);
        if (!resale) {
          enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, clock);
          v.routerSyncStatus = "pending";
        }
        if (activeVoucher) {
          activeVoucher.status = "replaced";
          activeVoucher.replacedAt = new Date(t).toISOString();
          if (adminUser?.id) activeVoucher.replacedByAdminId = adminUser.id;
          activeVoucher.replacedByVoucherId = v.id;
          enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: activeVoucher.id }, clock);
          activeVoucher.routerSyncStatus = "pending";
        }
        generated.push(voucherListView(s, v, access));
      }
      if (activeVoucher) {
        audit(s, "voucher.admin_replaced", req, {
          replacedVoucherId: activeVoucher.id,
          newVoucherId: generated[0]?.id,
          customerId: c?.id,
          planId: plan.id,
          saleType,
        });
      }
      audit(s, resale ? "voucher.resale_batch_generated" : "voucher.generated", req, {
        voucherIds: generated.map((v) => v.id),
        customerId: c?.id || null,
        planId: plan.id,
        quantity,
        saleType,
        ...(activeVoucher ? { replacedVoucherId: activeVoucher.id } : {}),
      });
      return json(res, 201, {
        voucher: generated[0],
        vouchers: generated,
        plan,
        ...(activeVoucher ? { replacedVoucher: { id: activeVoucher.id, status: activeVoucher.status } } : {}),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/classify") {
      const v = s.vouchers.find((x) => x.id === i.voucherId);
      if (!v || !v.generatedByAdmin || v.paymentId) return json(res, 404, { error: "Generated voucher not found." });
      if (!["sold", "gift"].includes(i.saleType)) return json(res, 400, { error: "Choose sold or gift." });
      const previous = v.saleType || null, faceValue = v.faceValue ?? findPlan(s, v.planId)?.price ?? 0;
      Object.assign(v, { saleType: i.saleType, faceValue, saleAmount: i.saleType === "sold" ? faceValue : 0 });
      audit(s, "voucher.sale_classified", req, { voucherId: v.id, previous, saleType: v.saleType });
      return json(res, 200, { voucher: view(v, s) });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/revoke") {
      const v = s.vouchers.find((x) => x.id === i.voucherId);
      if (!v) return json(res, 404, { error: "Voucher not found." });
      v.status = "revoked";
      enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, clock);
      v.routerSyncStatus = "pending";
      audit(s, "voucher.revoked", req, { voucherId: v.id });
      return json(res, 200, { voucher: view(v, s) });
    }
    return NOT_HANDLED;
  };
}
