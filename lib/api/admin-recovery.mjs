import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { json, ip } from "./http.mjs";
import { sec, audit } from "./state.mjs";
import { secureToken, hashSecret, safeEqual } from "../security.mjs";
import { revokeCustomerCredentials } from "../account-security.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { verifyAdminAction } from "../admin-sensitive-actions.mjs";
import { profilePhoneConflict, revokeProfileAuthority } from "../profile-edit.mjs";
import { normalizeCameroonPhone, validCameroonPhone } from "../../shared-app/cameroon-phone.js";

export function createAdminRecoveryRoutes({ clock, env, pepper, verifyBootstrapCredential, adminSecret, previousAdminSecret, matchesRotatingHash, rpID, adminOrigin }) {
  return async (req, res, url, { s, i, adminUser, administrator, role }) => {
    if (req.method !== "POST" || url.pathname !== "/api/admin/customers/recovery") return NOT_HANDLED;
    if (role !== "owner") return json(res, 403, { error: "Only an owner can approve account recovery." });
    // One recovery action, decided once (#245): the fresh proof is bound to it and
    // only it runs. Contradictory purpose fields are refused before any proof.
    if (i.purpose !== undefined && i.recoveryPurpose !== undefined && i.purpose !== i.recoveryPurpose)
      return json(res, 400, { code: "RECOVERY_ACTION_MISMATCH", error: "The recovery action is unclear. Start the recovery again." });
    const action = i.purpose ?? i.recoveryPurpose ?? "pin";
    if (!["pin", "authenticator", "passkeys", "phone"].includes(action)) return json(res, 400, { error: "Choose a supported recovery purpose." });
    const customer = s.customers.find((c) => c.id === i.customerId), caseReference = String(i.caseReference || "").trim(), reason = String(i.reason || "").trim();
    if (!customer || customer.status === "suspended") return json(res, 400, { error: "An active customer account is required." });
    if (action === "authenticator") return json(res, 410, { code: "AUTHENTICATOR_RETIRED", error: "Use audited PIN recovery instead." });
    if (!/^[a-zA-Z0-9._/-]{3,80}$/.test(caseReference) || reason.length < 12 || reason.length > 500 ||
      !["in_person", "existing_verified_channel"].includes(i.verificationMethod) || i.confirmedIdentity !== true) {
      return json(res, 400, { error: "Record the support case, reason and identity verification method before approving recovery." });
    }
    // Change number (PhoneEditProfile, #398; owner 26 Nov): the portal shows the
    // sign-in number read-only ("To change it, contact support"). The new number
    // is checked before any proof is asked for.
    const newPhone = action === "phone" ? normalizeCameroonPhone(i.phone) : null;
    if (action === "phone") {
      if (!validCameroonPhone(newPhone)) return json(res, 400, { error: "Enter the customer's new Cameroon number." });
      if (newPhone === normalizeCameroonPhone(customer.phone)) return json(res, 400, { error: "That is already this customer's number." });
      if (profilePhoneConflict(s, customer, newPhone)) return json(res, 409, { code: "PHONE_IN_USE", error: "Another account uses that number." });
    }
    const failures = s.securityEvents.filter((e) => e.type === "admin.recovery_verification.failed" &&
      Date.parse(e.meta?.attemptedAt || e.at) > +clock() - 900000 && (e.ip === ip(req) || e.meta?.userId === adminUser?.id));
    if (failures.length >= 5) return json(res, 429, { error: "Too many verification attempts. Try again in 15 minutes." });
    const proof = await verifyAdminAction({ s, user: adminUser, session: administrator, input: { ...i, purpose: action, recoveryPurpose: action }, purpose: "support_recovery", clock, rpID, origin: adminOrigin, secret: adminSecret });
    if (proof.throttle) return json(res, 429, { error: "Administrator verification is temporarily locked.", ...proof.throttle }, { "retry-after": String(proof.throttle.retryAfterSeconds) });
    const verified = proof.verified;
    if (!verified) {
      sec(s, "admin.recovery_verification.failed", req, { userId: adminUser?.id, attemptedAt: clock().toISOString() });
      return json(res, 400, { code: "VERIFICATION_FAILED", error: "Verify your current administrator password or passkey." });
    }
    // Lost passkeys (canvas: AdminCustomerDetail "Remove lost passkeys"): the
    // same case, identity check and proof; the customer then signs in with PIN.
    if (action === "passkeys") {
      const removed = (customer.passkeys || []).length;
      if (!removed) return json(res, 409, { error: "This customer has no passkeys to remove." });
      customer.passkeys = [];
      revokeCustomerCredentials(s, customer, { keepBackupCodes: true });
      audit(s, "customer.support_passkeys_removed", req, { customerId: customer.id, caseReference, reason, verificationMethod: i.verificationMethod, removed });
      queueSecurityAlert(s, { customerId: customer.id, kind: "support_recovery", subject: "Passkeys were removed from your NDAHI account",
        lines: ["An owner removed your saved passkeys after an identity check. Other portal sessions were signed out.", "Sign in with your PIN, then add a passkey on your new device. If you did not ask for this, contact NDAHI support immediately."] }, clock());
      return json(res, 200, { removed, message: "Passkeys removed. The customer signs in with their PIN and can add a new passkey." });
    }
    // The customer keeps their PIN, passkeys, bundles, vouchers and history; their
    // portal sessions and open sign-in challenges end, as when they change it.
    if (action === "phone") {
      const oldPhone = customer.phone, masked = (value) => `•••${String(value).slice(-3)}`;
      customer.phone = newPhone;
      customer.phoneVerified = false;
      customer.phoneChangedAt = clock().toISOString();
      revokeProfileAuthority(s, customer, oldPhone);
      sec(s, "customer.phone_changed", req, { customerId: customer.id, severity: "high", bySupport: true });
      audit(s, "customer.support_phone_changed", req, { customerId: customer.id, caseReference, reason, verificationMethod: i.verificationMethod, from: masked(oldPhone), to: masked(newPhone) });
      queueSecurityAlert(s, { customerId: customer.id, kind: "phone_changed", subject: "Your NDAHI Connect account number changed",
        lines: ["NDAHI support changed the number you sign in with after an identity check. Your PIN, bundles, vouchers, payment history and device approvals stay with your account.",
          "Sign in with your new number. If you did not ask for this, contact NDAHI support immediately."] }, clock());
      return json(res, 200, { phone: newPhone, message: "Number changed. The customer signs in with the new number and their PIN; their portal sessions were signed out." });
    }
    if (Date.parse(customer.supportRecoveryIssuedAt) > +clock() - 60000) return json(res, 429, { error: "Please wait before issuing another recovery code." });
    const token = secureToken(32), expiresAt = new Date(+clock() + 900000).toISOString();
    revokeCustomerCredentials(s, customer);
    customer.supportRecoveryIssuedAt = clock().toISOString();
    s.pinResetChallenges.push({ id: randomUUID(), customerId: customer.id, tokenHash: hashSecret(token, pepper), used: false, attempts: 0,
      createdAt: clock().toISOString(), expiresAt, source: "support", caseReference });
    audit(s, "customer.support_recovery.approved", req, { customerId: customer.id, caseReference, reason, verificationMethod: i.verificationMethod });
    queueSecurityAlert(s, { customerId: customer.id, kind: "support_recovery", subject: "Account recovery was approved for your NDAHI account",
      lines: ["An owner approved a time-limited account recovery code after an identity check. Other portal sessions and previous backup codes were revoked.", "If you did not request recovery, contact NDAHI support immediately."] }, clock());
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { recoveryCode: token, expiresAt, message: "Share this code only through the verified channel or in person. It is shown once and expires in 15 minutes. The customer enters it on the PIN recovery page." });
  };
}
