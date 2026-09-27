import { json } from "./http.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { audit } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createAdminCustomersRoutes({ clock }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
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
        recoveryCodes: _recoveryCodes,
        ...safeCustomer
      } = c;
      return json(res, 200, { customer: safeCustomer });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/customers/reset-authenticator") {
      const c = s.customers.find((x) => x.id === i.customerId);
      if (!c) return json(res, 404, { error: "Customer not found." });
      delete c.totpSecret;
      delete c.totpEnrolledAt;
      delete c.recoveryCodes;
      c.passkeys = [];
      s.dashboardSessions = s.dashboardSessions.filter((x) => x.customerId !== c.id);
      audit(s, "customer.authenticator_reset", req, {
        customerId: c.id,
      });
      return json(res, 200, { reset: true });
    }
    return NOT_HANDLED;
  };
}
