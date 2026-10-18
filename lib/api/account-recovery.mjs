import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { body, ip, json } from "./http.mjs";
import { phone, sec } from "./state.mjs";
import { secureToken, hashSecret, verifyTotp } from "../security.mjs";
import { profileProofOptions, verifyProfileProof } from "../profile-proof.mjs";
import { revokeCustomerCredentials } from "../account-security.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { NOT_HANDLED } from "./routing.mjs";

const hashing = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const dummy = argon2.hash("unused-account-backup-proof", hashing);
const validPin = (input) => /^\d{4}$/.test(String(input.newPin || "")) && input.newPin === input.confirmPin;

export function createAccountRecoveryRoutes({ mutate, auth, clock, pepper, pinThrottle, recordPinFailure,
  clearPinFailures, customerRpID, customerOrigin, issueCustomerSession }) {
  return async (req, res, url) => {
    const paths = ["/api/account/security/pin", "/api/account/security/pin/options", "/api/account/security/account-backup/generate", "/api/account/security/account-backup/options", "/api/account/pin-reset/backup"];
    if (req.method !== "POST" || !paths.includes(url.pathname)) return NOT_HANDLED;
    const input = await body(req), backupReset = url.pathname.endsWith("/pin-reset/backup"), changingPin = url.pathname.includes("/security/pin");
    if ((backupReset || changingPin) && !validPin(input)) return json(res, 400, { error: "Enter matching four-digit PINs." });
    return mutate(async (s) => {
      const session = !backupReset && auth(req, s, "dashboardSessions"), customer = backupReset
        ? s.customers.find((c) => c.phone === phone(input.phone)) : session && s.customers.find((c) => c.id === session.customerId);
      const failures = s.securityEvents.filter((e) => e.type === (backupReset ? "customer.backup_reset.failed" : "customer.credential_change.failed") &&
        Date.parse(e.meta?.attemptedAt || e.at) > +clock() - 900000 && (e.ip === ip(req) || e.meta?.phone === phone(input.phone) || customer && e.meta?.customerId === customer.id));
      if (failures.length >= 5) return json(res, 429, { error: "Too many verification attempts. Try again in 15 minutes." });
      if (!backupReset && !customer) return json(res, 401, { error: "Customer session expired." });
      if (!backupReset && customer.status === "suspended") return json(res, 403, { error: "This account is suspended." });
      if (backupReset) {
        const codes = customer?.accountBackupCodes || [], candidate = String(input.backupCode || "").trim();
        let matched = null;
        // Fixed work for existing and unknown accounts; no plaintext backup code is stored.
        for (let index = 0; index < 5; index++) {
          const code = codes[index], verified = await argon2.verify(code?.hash || await dummy, candidate).catch(() => false);
          if (code && verified) matched = code;
        }
        if (!matched || customer?.status === "suspended" || (customer?.totpSecret && !verifyTotp(customer.totpSecret, input.otp, +clock()))) {
          sec(s, "customer.backup_reset.failed", req, { phone: phone(input.phone), attemptedAt: clock().toISOString() });
          return json(res, 401, { code: "VERIFICATION_FAILED", error: "Could not verify account recovery. Check the account number, backup code and any required authenticator code." });
        }
        customer.pinHash = await argon2.hash(String(input.newPin), hashing);
        customer.pinUpdatedAt = clock().toISOString();
        clearPinFailures(customer);
        revokeCustomerCredentials(s, customer);
        sec(s, "customer.backup_reset.completed", req, { customerId: customer.id });
        queueSecurityAlert(s, { customerId: customer.id, kind: "pin_reset", subject: "Your NDAHI Connect PIN was recovered",
          lines: ["An account backup code was used to reset your PIN. Portal sessions and the previous backup-code set were revoked.", "Sign in with your new PIN and generate fresh account backup codes. Authenticator verification remains enabled when previously enrolled."] }, clock());
        return json(res, 200, { reset: true, message: "PIN reset. Sign in with your new PIN, then generate a fresh set of account backup codes." });
      }
      const type = changingPin ? "pin_change" : "account_backup", target = changingPin ? hashSecret(String(input.newPin), pepper) : "generate";
      if (url.pathname.endsWith("/options")) {
        if (!customer.passkeys?.length) return json(res, 400, { error: "Use your current PIN to verify this action." });
        return json(res, 200, await profileProofOptions({ s, customer, session, type, target, clock, rpID: customerRpID }));
      }
      const proof = await verifyProfileProof({ s, customer, session, input: { ...input, pin: input.currentPin }, type, target, clock,
        rpID: customerRpID, origin: customerOrigin, pinThrottle });
      if (proof.throttle) return json(res, 429, { error: "PIN verification is temporarily locked.", ...proof.throttle });
      if (!proof.verified || (customer.totpSecret && !verifyTotp(customer.totpSecret, input.otp, +clock()))) {
        sec(s, "customer.credential_change.failed", req, { customerId: customer.id, attemptedAt: clock().toISOString() });
        return json(res, 401, { code: "VERIFICATION_FAILED", error: "Could not verify this action. Check your current credentials and authenticator code.", ...recordPinFailure(s, customer, req, customer.phone) });
      }
      clearPinFailures(customer);
      if (changingPin) {
        customer.pinHash = await argon2.hash(String(input.newPin), hashing);
        customer.pinUpdatedAt = clock().toISOString();
        revokeCustomerCredentials(s, customer);
        sec(s, "customer.pin_changed", req, { customerId: customer.id });
        queueSecurityAlert(s, { customerId: customer.id, kind: "pin_changed", subject: "Your NDAHI Connect PIN changed",
          lines: ["Your PIN was changed after credential verification. Other portal sessions and previous account backup codes were revoked.", "If you did not make this change, contact NDAHI support."] }, clock());
        return issueCustomerSession(s, customer.id, res, req);
      }
      if (Date.parse(customer.backupCodesGeneratedAt) > +clock() - 60000) return json(res, 429, { error: "Please wait one minute before generating another backup-code set." });
      const codes = Array.from({ length: 5 }, () => `NC-REC-${secureToken(20)}`), records = [];
      for (const code of codes) records.push({ id: randomUUID(), hash: await argon2.hash(code, hashing) });
      customer.accountBackupCodes = records;
      customer.backupCodesGeneratedAt = clock().toISOString();
      sec(s, "customer.backup_codes.generated", req, { customerId: customer.id });
      queueSecurityAlert(s, { customerId: customer.id, kind: "backup_codes_generated", subject: "Your NDAHI Connect account backup codes changed",
        lines: ["A new account backup-code set was generated. Any earlier set is invalid.", "Keep these codes private and offline. They can reset your PIN without email; enrolled authenticator verification is still required."] }, clock());
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { codes, generatedAt: customer.backupCodesGeneratedAt });
    }, { res });
  };
}
