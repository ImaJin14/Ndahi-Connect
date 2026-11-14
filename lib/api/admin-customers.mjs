import { randomUUID } from "node:crypto";
import { json, ip } from "./http.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { audit, sec, findPlan, uniqueActivationCode, GB } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { bulkCustomerIds, verifyAdminAction } from "../admin-sensitive-actions.mjs";

const maxBulkCustomers = 200, maxMessageLength = 500;
export function createAdminCustomersRoutes({ clock, rpID, adminOrigin, adminSecret }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    // Customers bulk actions (#257, canvas: AdminCustomers): a gift voucher saved in
    // each account (started by the customer, recorded as a gift, no revenue) or a
    // message (in-app notification and email). One audited, idempotent request;
    // suspended customers are skipped; gifts need fresh administrator proof.
    if (req.method === "POST" && url.pathname === "/api/admin/customers/bulk") {
      if (!["owner", "operator"].includes(role)) return json(res, 403, { error: "Only owners and operators can act on many customers at once." });
      const action = i.action, ids = bulkCustomerIds(i.customerIds), requestKey = String(i.requestKey || "");
      if (!["gift", "message"].includes(action)) return json(res, 400, { error: "Choose a gift voucher or a message." });
      if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey)) return json(res, 400, { error: "Start this action again." });
      if (!ids.length || ids.length > maxBulkCustomers) return json(res, 400, { error: `Choose between 1 and ${maxBulkCustomers} customers.` });
      const done = s.auditLogs.find((a) => a.action === `customer.bulk_${action}` && a.meta?.requestKey === requestKey);
      if (done) return json(res, 200, { ...done.meta.result, idempotent: true });
      let plan, body;
      if (action === "gift") {
        plan = findPlan(s, i.planId);
        if (!plan) return json(res, 400, { error: "Choose a bundle to give." });
        const failures = s.securityEvents.filter((e) => e.type === "admin.bulk_gift_verification.failed" &&
          Date.parse(e.meta?.attemptedAt || e.at) > +clock() - 900000 && (e.ip === ip(req) || e.meta?.userId === adminUser?.id));
        if (failures.length >= 5) return json(res, 429, { error: "Too many verification attempts. Try again in 15 minutes." });
        const proof = await verifyAdminAction({ s, user: adminUser, session: administrator, input: { ...i, customerIds: ids }, purpose: "customer_bulk_gift", clock, rpID, origin: adminOrigin, secret: adminSecret });
        if (proof.throttle) return json(res, 429, { error: "Administrator verification is temporarily locked.", ...proof.throttle }, { "retry-after": String(proof.throttle.retryAfterSeconds) });
        if (!proof.verified) {
          sec(s, "admin.bulk_gift_verification.failed", req, { userId: adminUser?.id, attemptedAt: clock().toISOString() });
          return json(res, 400, { code: "VERIFICATION_FAILED", error: "Verify your current administrator PIN or passkey." });
        }
      } else {
        body = String(i.message || "").replace(/\r\n?/g, "\n").trim();
        if (!body || body.length > maxMessageLength) return json(res, 400, { error: `Write a message of up to ${maxMessageLength} characters.` });
      }
      const batchId = randomUUID(), at = clock().toISOString(), results = [];
      for (const id of ids) {
        const c = s.customers.find((x) => x.id === id);
        if (!c || c.status === "suspended" || c.suspended) { results.push({ customerId: id, status: "skipped", reason: c ? "suspended" : "not_found" }); continue; }
        if (action === "gift") {
          s.vouchers.unshift({
            id: randomUUID(), customerId: c.id, planId: plan.id, code: uniqueActivationCode(s), status: "available",
            activatedAt: null, expiresAt: null, quotaBytes: plan.quotaGb === null ? null : plan.quotaGb * GB, usedBytes: 0,
            deviceLimit: plan.deviceLimit, generatedByAdmin: true, ...(adminUser?.id ? { generatedByAdminId: adminUser.id } : {}),
            resale: false, saleType: "gift", saleAmount: 0, faceValue: plan.price, giftBatchId: batchId, giftedAt: at, createdAt: at,
          });
        } else s.customerMessages.push({ id: randomUUID(), customerId: c.id, body, at, byAdminId: adminUser?.id || null, batchId });
        results.push({ customerId: id, status: "done" });
      }
      const result = { action, batchId, done: results.filter((r) => r.status === "done").length, skipped: results.filter((r) => r.status === "skipped") };
      audit(s, `customer.bulk_${action}`, req, { requestKey, batchId, count: result.done, skipped: result.skipped.length, ...(plan ? { planId: plan.id } : {}), result });
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/admin/customers/suspend") {
      const c = s.customers.find((x) => x.id === i.customerId);
      if (!c) return json(res, 404, { error: "Customer not found." });
      c.status = i.suspended === false ? "active" : "suspended";
      for (const v of s.vouchers.filter((v) => v.customerId === c.id && v.status === "active")) {
        v.status = "suspended";
        enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, clock);
        v.routerSyncStatus = "pending";
      }
      audit(s, "customer.suspension_changed", req, {
        customerId: c.id,
        status: c.status,
      });
      const {
        totpSecret: _totpSecret,
        pinHash: _pinHash,
        wifiMainDevice: _wifiMainDevice,
        pendingEmail: _pendingEmail,
        recoveryCodes: _recoveryCodes,
          accountBackupCodes: _accountBackupCodes,
        pushSubscriptions: _pushSubscriptions,
        authenticatorRecoveryPermit: _authenticatorRecoveryPermit,
        mfaCompletion: _mfaCompletion,
        mfaProofs: _mfaProofs,
        mfaCheck: _mfaCheck,
        authMigration: _authMigration,
        passkeys: _passkeys = [],
        ...safeCustomer
      } = c;
      return json(res, 200, { customer: { ...safeCustomer, passkeys: _passkeys.length } });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/customers/reset-authenticator") {
      return json(res, 410, { code: "AUDITED_RECOVERY_REQUIRED", error: "Use verified, audited account recovery. This legacy reset cannot remove customer credentials." });
    }
    return NOT_HANDLED;
  };
}
