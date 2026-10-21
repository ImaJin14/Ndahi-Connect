import argon2 from "argon2";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import { body, json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { sec, log } from "./state.mjs";
import { hashSecret, totpSecret, totpUri, verifyTotp, recoveryCode, normalizeRecoveryCode, secureToken } from "../security.mjs";
import { profileProofOptions, verifyProfileProof } from "../profile-proof.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";

const root = "/api/account/security/mfa", recoveryPath = "/api/account/security/recovery-codes/generate";
const hashing = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const duration = 600000;

export function createAuthenticatorManagementRoutes({ mutate, store, auth, clock, pepper, previousPepper, matchesRotatingHash,
  customerRpID, customerOrigin, pinThrottle, recordPinFailure, clearPinFailures }) {
  const matches = (value, hash) => matchesRotatingHash(value, hash, pepper, previousPepper);
  const versionMatches = (customer, record) => matches(customer.totpSecret || "", record.originalVersion) && record.pinVersion === customer.pinHash;
  const pending = (s, c, a, id) => s.customerMfaChallenges.find((x) => x.customerId === c.id && x.sessionId === a.id && x.secret &&
    (!id || x.id === id) && Date.parse(x.expiresAt) > +clock() && versionMatches(c, x));
  const recentCompletion = (c, a) => c.mfaCompletion?.sessionId === a.id && Date.parse(c.mfaCompletion.expiresAt) > +clock() && matches(c.totpSecret || "", c.mfaCompletion.version);
  const announce = (s, c, kind, subject, message) => queueSecurityAlert(s, { customerId: c.id, kind, subject, lines: [message] }, clock());
  const setupResponse = async (record, customer) => ({ challengeId: record.id, secret: record.secret, uri: totpUri(record.secret, customer.phone),
    qrCode: await QRCode.toDataURL(totpUri(record.secret, customer.phone), { width: 240, margin: 4, errorCorrectionLevel: "M" }),
    expiresAt: record.expiresAt, replacement: record.replacement === true });
  async function factor(s, c, input, verifiedRecovery) {
    const normalized = normalizeRecoveryCode(input.recoveryCode || "");
    if (normalized) {
      const record = (c.recoveryCodes || []).find((x) => !x.usedAt && (x.argon2Hash ? x.id === verifiedRecovery?.id && x.argon2Hash === verifiedRecovery.argon2Hash : matches(normalized, x.hash)));
      if (!record) return false;
      record.usedAt = clock().toISOString();
      sec(s, "customer.authenticator.recovery_code.used", input.request, { customerId: c.id });
      return true;
    }
    if (input.supportCode) {
      const permit = c.authenticatorRecoveryPermit;
      if (!permit || permit.used || permit.attempts >= 5 || !(Date.parse(permit.expiresAt) > +clock()) || !versionMatches(c, permit)) return false;
      if (!matches(String(input.supportCode), permit.tokenHash)) { permit.attempts++; return false; }
      permit.used = true; permit.usedAt = clock().toISOString(); return true;
    }
    const otp = String(input.otp || "");
    if (!verifyTotp(c.totpSecret, otp, +clock())) return false;
    c.mfaProofs = (c.mfaProofs || []).filter((x) => Date.parse(x.at) > +clock() - 90000);
    if (c.mfaProofs.some((x) => matches(otp, x.hash))) return false;
    c.mfaProofs.push({ hash: hashSecret(otp, pepper), at: clock().toISOString() });
    return true;
  }
  return async (req, res, url) => {
    if (!url.pathname.startsWith(root + "/") && url.pathname !== recoveryPath) return NOT_HANDLED;
    const action = url.pathname === recoveryPath ? "recovery" : url.pathname.slice(root.length + 1);
    if (!["status", "enroll", "replace", "resume", "options", "check", "confirm", "cancel", "recovery"].includes(action)) return NOT_HANDLED;
    if (req.method !== (action === "status" ? "GET" : "POST")) return json(res, 405, { error: "Method not allowed." });
    const input = action === "status" ? {} : await body(req);
    // Expensive recovery verification runs outside the store lock; the mutation
    // rechecks both the exact hash and unused state before consuming it.
    let verifiedRecovery;
    if (input.recoveryCode) {
      const snapshot = await store.snapshot(), a = auth(req, snapshot, "dashboardSessions"), c = a && snapshot.customers.find((x) => x.id === a.customerId);
      for (const record of (c?.recoveryCodes || []).filter((x) => !x.usedAt && x.argon2Hash).slice(0, 10)) {
        if (await argon2.verify(record.argon2Hash, normalizeRecoveryCode(input.recoveryCode)).catch(() => false)) { verifiedRecovery = record; break; }
      }
    }
    const result = await mutate(async (s) => {
      const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((x) => x.id === a.customerId);
      if (!c) return json(res, 401, { error: "Customer session expired." });
      if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
      if (action === "status") {
        const record = pending(s, c, a);
        return json(res, 200, { enabled: Boolean(c.totpSecret), pending: record ? { challengeId: record.id, expiresAt: record.expiresAt, replacement: record.replacement === true } : null,
          ...(recentCompletion(c, a) ? { completedChallengeId: c.mfaCompletion.id } : {}) });
      }
      if (action === "cancel") {
        s.customerMfaChallenges = s.customerMfaChallenges.filter((x) => !(x.id === input.challengeId && x.customerId === c.id && x.sessionId === a.id && x.secret));
        return json(res, 200, { cancelled: true });
      }
      if (action === "check") {
        if (!c.mfaCheck || Date.parse(c.mfaCheck.at) <= +clock() - 900000) c.mfaCheck = { attempts: 0, at: clock().toISOString() };
        if (c.mfaCheck.attempts >= 5) return json(res, 429, { error: "Too many incorrect codes. Try verification again in 15 minutes." });
        if (!c.totpSecret || !verifyTotp(c.totpSecret, input.otp, +clock())) {
          c.mfaCheck.attempts++;
          sec(s, "customer.authenticator.check.failed", req, { customerId: c.id });
          return json(res, 401, { code: "VERIFICATION_FAILED", error: "The authenticator code was not accepted. Check automatic time and try the current code." });
        }
        delete c.mfaCheck;
        return json(res, 200, { verified: true });
      }
      if (action === "confirm") {
        if (!/^[a-f0-9-]{36}$/.test(input.challengeId || "")) return json(res, 400, { code: "MFA_SETUP_EXPIRED", error: "Choose the pending setup in this browser before confirming." });
        if (recentCompletion(c, a) && c.mfaCompletion.id === input.challengeId) return json(res, 200, { mfaEnabled: true, replaced: c.mfaCompletion.replaced });
        const record = pending(s, c, a, input.challengeId);
        if (!record) return json(res, 400, { code: "MFA_SETUP_EXPIRED", error: "Authenticator setup expired or was replaced. Start setup again in this browser." });
        if (!verifyTotp(record.secret, input.code, +clock())) {
          record.attempts = (record.attempts || 0) + 1;
          const attemptsRemaining = Math.max(0, 5 - record.attempts);
          if (!attemptsRemaining) s.customerMfaChallenges = s.customerMfaChallenges.filter((x) => x.id !== record.id);
          sec(s, "customer.authenticator.setup.failed", req, { customerId: c.id });
          return json(res, attemptsRemaining ? 400 : 429, { code: attemptsRemaining ? "MFA_CODE_INVALID" : "MFA_SETUP_EXPIRED", attemptsRemaining,
            error: attemptsRemaining ? "The authenticator code is invalid or expired. Check the app's current code and your phone's automatic time setting." : "Too many incorrect codes. Start authenticator setup again." });
        }
        c.totpSecret = record.secret; c.totpEnrolledAt = clock().toISOString();
        if (record.replacement) { delete c.recoveryCodes; delete c.authenticatorRecoveryPermit; }
        delete c.mfaProofs;
        delete c.mfaCheck;
        c.mfaCompletion = { id: record.id, sessionId: a.id, version: hashSecret(c.totpSecret, pepper), replaced: record.replacement === true,
          expiresAt: new Date(+clock() + duration).toISOString(), recoveryProofUntil: new Date(+clock() + 300000).toISOString() };
        s.customerMfaChallenges = s.customerMfaChallenges.filter((x) => x.customerId !== c.id);
        s.otpChallenges = s.otpChallenges.filter((x) => x.customerId !== c.id);
        const kind = record.replacement ? "authenticator_replaced" : "authenticator_enrolled";
        log(s, "customer.authenticator." + (record.replacement ? "replaced" : "enrolled"), { customerId: c.id });
        announce(s, c, kind, record.replacement ? "Your authenticator app was replaced" : "Authenticator sign-in was enabled",
          "An authenticator app was linked as an optional sign-in method. PIN and passkeys remain available." + (record.replacement ? " The previous authenticator and its recovery codes no longer work." : ""));
        return json(res, 200, { mfaEnabled: true, replaced: record.replacement === true });
      }
      if (action === "recovery") {
        if (!c.totpSecret) return json(res, 409, { error: "Enable authenticator 2FA before generating recovery codes." });
        const justConfirmed = recentCompletion(c, a) && Date.parse(c.mfaCompletion.recoveryProofUntil) > +clock() && !c.mfaCompletion.recoveryIssued;
        if (!justConfirmed && !await factor(s, c, { ...input, request: req }, verifiedRecovery)) return json(res, 401, { code: "VERIFICATION_FAILED", error: "Verify your current authenticator or a recovery code before replacing recovery codes." });
        if (justConfirmed) c.mfaCompletion.recoveryIssued = true;
        const token = secureToken();
        a.mfaRecoveryGrant = { token, version: hashSecret(c.totpSecret, pepper), expiresAt: new Date(+clock() + 60000).toISOString() };
        return { generate: true, sessionId: a.id, token };
      }
      const replacing = action === "replace", resuming = action === "resume" || action === "options" && input.action === "resume";
      const scope = "mfa-enrollment:" + c.id;
      const setupId = input.setupId || input.challengeId;
      const record = resuming && /^[a-f0-9-]{36}$/.test(setupId || "") && pending(s, c, a, setupId);
      if (resuming && !record) return json(res, 400, { code: "MFA_SETUP_EXPIRED", error: "Pending setup expired. Start again." });
      if ((replacing || action === "options" && !resuming) && !c.totpSecret) return json(res, 409, { error: "Set up an authenticator first." });
      if (action === "enroll" && c.totpSecret) return json(res, 409, { error: "Authenticator sign-in is already enabled. Use Manage authenticator to replace it." });
      if (input.requestKey && !/^[a-f0-9]{32}$/.test(input.requestKey)) return json(res, 400, { error: "Start a fresh setup attempt in this browser." });
      const target = resuming ? record.id : hashSecret(c.totpSecret || "", pepper);
      const proofType = resuming ? "authenticator_resume" : "authenticator_replace";
      if (action === "options") {
        if (!c.passkeys?.length) return json(res, 400, { error: "Use your PIN to verify this action." });
        return json(res, 200, await profileProofOptions({ s, customer: c, session: a, type: proofType, target, clock, rpID: customerRpID }));
      }
      if (replacing && /^[a-f0-9]{32}$/.test(input.requestKey || "")) {
        const resumed = pending(s, c, a);
        if (resumed?.requestHash && matches(input.requestKey, resumed.requestHash)) return json(res, 200, await setupResponse(resumed, c));
      }
      if (["enroll", "replace"].includes(action) && s.rateLimitEvents.filter((x) => x.scope === scope && Date.parse(x.at) > +clock() - 900000).length >= 5) return json(res, 429, { error: "Too many setup attempts. Try again in 15 minutes." });
      if (replacing || resuming) {
        const proof = await verifyProfileProof({ s, customer: c, session: a, input, type: proofType, target, clock, rpID: customerRpID, origin: customerOrigin, pinThrottle });
        if (proof.throttle) return json(res, 429, { error: "PIN verification is temporarily locked.", ...proof.throttle });
        if (!proof.verified || replacing && !await factor(s, c, { ...input, request: req }, verifiedRecovery)) return json(res, 401, {
          code: "VERIFICATION_FAILED", error: "Verify your PIN/passkey and current authenticator, recovery code or verified support code.", ...recordPinFailure(s, c, req, c.phone) });
        clearPinFailures(c);
        if (resuming) return json(res, 200, await setupResponse(record, c));
      }
      const challenge = { id: randomUUID(), customerId: c.id, sessionId: a.id, secret: totpSecret(), attempts: 0,
        originalVersion: hashSecret(c.totpSecret || "", pepper), pinVersion: c.pinHash, replacement: replacing,
        ...(input.requestKey ? { requestHash: hashSecret(input.requestKey, pepper) } : {}), expiresAt: new Date(+clock() + duration).toISOString() };
      s.customerMfaChallenges = s.customerMfaChallenges.filter((x) => x.customerId !== c.id || !x.secret);
      s.customerMfaChallenges.push(challenge);
      s.rateLimitEvents.push({ id: randomUUID(), scope, at: clock().toISOString() });
      sec(s, "customer.authenticator.setup.started", req, { customerId: c.id, replacement: replacing });
      return json(res, 200, await setupResponse(challenge, c));
    }, { res });
    if (!result?.generate) return result;
    const codes = Array.from({ length: 10 }, () => recoveryCode());
    const hashes = await Promise.all(codes.map((code) => argon2.hash(code, hashing)));
    return mutate((s) => {
      const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((x) => x.id === a.customerId), grant = a?.mfaRecoveryGrant;
      if (!c || c.status === "suspended" || a.id !== result.sessionId || grant?.token !== result.token || !(Date.parse(grant.expiresAt) > +clock()) || !matches(c.totpSecret || "", grant.version)) return json(res, 409, { error: "Account verification changed. Verify again before generating recovery codes." });
      delete a.mfaRecoveryGrant;
      const generatedAt = clock().toISOString();
      c.recoveryCodes = hashes.map((argon2Hash) => ({ id: randomUUID(), argon2Hash, createdAt: generatedAt, usedAt: null }));
      log(s, "customer.recovery_codes.generated", { customerId: c.id, count: codes.length });
      announce(s, c, "recovery_codes_regenerated", "New NDAHI Connect recovery codes were generated", "New account recovery codes were generated. Any previously issued codes no longer work.");
      return json(res, 200, { codes, remaining: codes.length });
    }, { res });
  };
}
