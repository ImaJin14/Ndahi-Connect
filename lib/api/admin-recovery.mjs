import { authenticatorRetired } from "../authentication-migration.mjs";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { json, ip } from "./http.mjs";
import { sec, audit } from "./state.mjs";
import { secureToken, hashSecret, safeEqual, verifyTotp } from "../security.mjs";
import { revokeCustomerCredentials } from "../account-security.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { verifyAdminAction } from "../admin-sensitive-actions.mjs";

export function createAdminRecoveryRoutes({ clock, env, pepper, verifyBootstrapCredential, adminSecret, previousAdminSecret, matchesRotatingHash, rpID, adminOrigin }) {
  return async (req, res, url, { s, i, adminUser, administrator, role }) => {
    if (req.method !== "POST" || url.pathname !== "/api/admin/customers/recovery") return NOT_HANDLED;
    if (role !== "owner") return json(res, 403, { error: "Only an owner can approve account recovery." });
    if (i.purpose !== undefined && !["pin", "authenticator"].includes(i.purpose)) return json(res, 400, { error: "Choose a supported recovery purpose." });
    const customer = s.customers.find((c) => c.id === i.customerId), caseReference = String(i.caseReference || "").trim(), reason = String(i.reason || "").trim();
    if (!customer || customer.status === "suspended") return json(res, 400, { error: "An active customer account is required." });
    if (i.purpose === "authenticator" && authenticatorRetired(s)) return json(res, 410, { code: "AUTHENTICATOR_RETIRED", error: "Use audited PIN recovery instead." });
    if (i.purpose === "authenticator" && !customer.totpSecret) return json(res, 409, { error: "This account does not have an authenticator to replace." });
    if (!/^[a-zA-Z0-9._/-]{3,80}$/.test(caseReference) || reason.length < 12 || reason.length > 500 ||
      !["in_person", "existing_verified_channel"].includes(i.verificationMethod) || i.confirmedIdentity !== true) {
      return json(res, 400, { error: "Record the support case, reason and identity verification method before approving recovery." });
    }
    const failures = s.securityEvents.filter((e) => e.type === "admin.recovery_verification.failed" &&
      Date.parse(e.meta?.attemptedAt || e.at) > +clock() - 900000 && (e.ip === ip(req) || e.meta?.userId === adminUser?.id));
    if (failures.length >= 5) return json(res, 429, { error: "Too many verification attempts. Try again in 15 minutes." });
    let verified;
    if (authenticatorRetired(s)) {
      const proof = await verifyAdminAction({ s, user: adminUser, session: administrator, input: i, purpose: "support_recovery", clock, rpID, origin: adminOrigin, secret: adminSecret });
      if (proof.throttle) return json(res, 429, { error: "Administrator verification is temporarily locked.", ...proof.throttle }, { "retry-after": String(proof.throttle.retryAfterSeconds) });
      verified = proof.verified;
    } else {
      const password = i.currentPassword ?? i.password;
      const credentialVerified = adminUser?.passwordHash ? await argon2.verify(adminUser.passwordHash, String(password || "")).catch(() => false)
        : await verifyBootstrapCredential(password);
      const enabled = env.ADMIN_MFA_ENABLED === "true" || s.adminProfile?.mfaEnabled || Boolean(s.adminProfile?.totpSecret);
      const mfa = !enabled || (s.adminProfile?.totpSecret ? verifyTotp(s.adminProfile.totpSecret, i.mfaCode, +clock())
        : env.ADMIN_MFA_CODE ? safeEqual(i.mfaCode || "", env.ADMIN_MFA_CODE)
        : s.adminProfile?.mfaCodeHash && matchesRotatingHash(i.mfaCode, s.adminProfile.mfaCodeHash, adminSecret, previousAdminSecret));
      verified = credentialVerified && mfa;
    }
    if (!verified) {
      sec(s, "admin.recovery_verification.failed", req, { userId: adminUser?.id, attemptedAt: clock().toISOString() });
      return json(res, 400, { code: "VERIFICATION_FAILED", error: authenticatorRetired(s) ? "Verify your current administrator password or passkey." : "Could not verify your current administrator credentials and authenticator code." });
    }
    if (Date.parse(customer.supportRecoveryIssuedAt) > +clock() - 60000) return json(res, 429, { error: "Please wait before issuing another recovery code." });
    const token = secureToken(32), expiresAt = new Date(+clock() + 900000).toISOString();
    revokeCustomerCredentials(s, customer);
    customer.supportRecoveryIssuedAt = clock().toISOString();
    if (i.purpose === "authenticator") {
      customer.authenticatorRecoveryPermit = { tokenHash: hashSecret(token, pepper), originalVersion: hashSecret(customer.totpSecret, pepper),
        pinVersion: customer.pinHash, attempts: 0, used: false, expiresAt, caseReference };
      audit(s, "customer.authenticator_recovery.approved", req, { customerId: customer.id, caseReference, reason, verificationMethod: i.verificationMethod });
      queueSecurityAlert(s, { customerId: customer.id, kind: "authenticator_recovery_approved", subject: "Authenticator recovery was approved",
        lines: ["An owner verified your identity and issued a time-limited authenticator replacement code. The existing authenticator remains active until you confirm the new app.", "If you did not request this, contact NDAHI support immediately."] }, clock());
      return json(res, 200, { recoveryCode: token, purpose: "authenticator", expiresAt,
        message: "Share only in person or through the verified channel. The customer signs in with their PIN, then opens Account → Manage authenticator → I have lost access → Use a support code. The code expires in 15 minutes." });
    }
    s.pinResetChallenges.push({ id: randomUUID(), customerId: customer.id, tokenHash: hashSecret(token, pepper), used: false, attempts: 0,
      createdAt: clock().toISOString(), expiresAt, source: "support", caseReference });
    audit(s, "customer.support_recovery.approved", req, { customerId: customer.id, caseReference, reason, verificationMethod: i.verificationMethod });
    queueSecurityAlert(s, { customerId: customer.id, kind: "support_recovery", subject: "Account recovery was approved for your NDAHI account",
      lines: ["An owner approved a time-limited account recovery code after an identity check. Other portal sessions and previous backup codes were revoked.", "If you did not request recovery, contact NDAHI support immediately."] }, clock());
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { recoveryCode: token, expiresAt, message: "Share this code only through the verified channel or in person. It is shown once and expires in 15 minutes. The customer enters it on the PIN recovery page." });
  };
}
