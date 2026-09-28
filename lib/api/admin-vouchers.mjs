import { json } from "./http.mjs";
import { audit, findPlan, uniqueActivationCode, GB, view } from "./state.mjs";
import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createAdminVouchersRoutes({ deliverVoucherEmail, clock }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
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
      const resale = i.purpose === "resale";
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
      if (c && s.vouchers.some((v) => v.customerId === c.id && v.status === "active")) {
        return json(res, 409, { error: "Customer already has an active voucher." });
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
            resale,
            createdAt: new Date(t).toISOString(),
          };
        s.vouchers.unshift(v);
        if (!resale) {
          enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, clock);
          v.routerSyncStatus = "pending";
        }
        generated.push(view(v, s, true));
      }
      audit(s, resale ? "voucher.resale_batch_generated" : "voucher.generated", req, {
        voucherIds: generated.map((v) => v.id),
        customerId: c?.id || null,
        planId: plan.id,
        quantity,
      });
      return json(res, 201, { voucher: generated[0], vouchers: generated, plan });
    }
    if (url.pathname === "/api/admin/vouchers/revoke") {
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
