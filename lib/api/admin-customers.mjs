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
