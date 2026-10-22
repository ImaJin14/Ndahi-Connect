import { authenticatorRetired, recordVerifiedMethod, verifiedMethods } from "../authentication-migration.mjs";
import { adminActionOptions, adminPurposeAllowed, adminCredentialVersion, verifyAdminAction } from "../admin-sensitive-actions.mjs";
import { json } from "./http.mjs";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { audit } from "./state.mjs";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { totpSecret, totpUri, verifyTotp, hashSecret } from "../security.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createAdminProfileRoutes({ clock, rpName, rpID, adminOrigin, adminSecret, pepper }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    const retired = authenticatorRetired(s);
    if (retired && url.pathname.startsWith("/api/admin/profile/mfa")) return json(res, 410, { code: "AUTHENTICATOR_RETIRED", error: "Authenticator access has retired. Refresh and use your password or passkey." });
    const fresh = async (purpose, input = i) => {
      const proof = await verifyAdminAction({ s, user: adminUser, session: administrator, input, purpose, clock, rpID, origin: adminOrigin, secret: adminSecret });
      if (proof.throttle) { json(res, 429, { code: "VERIFICATION_LOCKED", error: "Administrator verification is temporarily locked.", ...proof.throttle }, { "retry-after": String(proof.throttle.retryAfterSeconds) }); return false; }
      if (!proof.verified) { json(res, 401, { code: "VERIFICATION_FAILED", error: "Verify your current administrator password or passkey." }); return false; }
      recordVerifiedMethod(adminUser, proof.method, proof.credentialId, pepper, clock());
      return true;
    };
    if (req.method === "POST" && url.pathname === "/api/admin/profile/proof/options") {
      if (!adminPurposeAllowed(adminUser, i.purpose)) return json(res, 403, { error: "Your role does not permit this verification purpose." });
      if (retired && i.purpose === "legacy_mfa") return json(res, 410, { code: "AUTHENTICATOR_RETIRED", error: "Authenticator management has retired. Refresh the admin app." });
      if (retired && i.purpose === "support_recovery" && i.recoveryPurpose && i.recoveryPurpose !== "pin")
        return json(res, 410, { code: "AUTHENTICATOR_RETIRED", error: "Use audited PIN recovery instead." });
      if (!adminUser?.passkeys?.length) return json(res, 409, { code: "PASSWORD_REQUIRED", error: "Use your current administrator password for this action." });
      try { return json(res, 200, await adminActionOptions({ s, user: adminUser, session: administrator, input: i, purpose: i.purpose, clock, rpID, secret: adminSecret })); }
      catch { return json(res, 400, { error: "Start a fresh administrator verification attempt." }); }
    }
    if (req.method === "POST" && url.pathname === "/api/admin/users") {
      if (role !== "owner") return json(res, 403, { error: "Only an owner can create administrators." });
      const username = String(i.username || "")
          .trim()
          .toLowerCase(),
        newRole = String(i.role || "auditor"),
        password = String(i.password || "");
      if (
        !/^[a-z0-9._-]{3,40}$/.test(username) ||
        !["owner", "operator", "reseller", "auditor"].includes(newRole) ||
        password.length < 14
      ) {
        return json(res, 400, {
          error: "Enter a valid username, role, and password of at least 14 characters.",
        });
      }
      if (s.adminUsers.some((user) => user.username === username))
        return json(res, 409, { error: "That administrator already exists." });
      if (!await fresh("staff_create")) return;
      const user = {
        id: randomUUID(),
        username,
        displayName: String(i.displayName || username).slice(0, 80),
        role: newRole,
        passwordHash: await argon2.hash(password),
        passkeys: [],
        active: true,
        createdAt: clock().toISOString(),
      };
      s.adminUsers.push(user);
      audit(s, "admin.user_created", req, { userId: user.id, username, role: newRole });
      return json(res, 201, {
        user: { id: user.id, username, displayName: user.displayName, role: newRole, active: true },
      });
    }
    // Incident containment (DEP-006): owners can disable another administrator at once.
    // There is no reactivation; restore access with a new account and fresh credentials.
    if (req.method === "POST" && url.pathname === "/api/admin/users/deactivate") {
      if (role !== "owner") return json(res, 403, { error: "Only an owner can deactivate administrators." });
      const target = s.adminUsers.find((user) => user.id === i.userId);
      if (!target) return json(res, 404, { error: "Administrator not found." });
      if (target.id === adminUser?.id) {
        return json(res, 409, { error: "You cannot deactivate your own account." });
      }
      if (!await fresh("staff_deactivate")) return;
      const sessions = s.adminSessions.length;
      s.adminSessions = s.adminSessions.filter((session) => session.userId !== target.id);
      const sessionsEnded = sessions - s.adminSessions.length;
      if (target.active !== false) {
        target.active = false;
        target.deactivatedAt = clock().toISOString();
        audit(s, "admin.user_deactivated", req, { userId: target.id, username: target.username, sessionsEnded });
      }
      return json(res, 200, {
        user: { id: target.id, username: target.username, role: target.role, active: false },
        sessionsEnded,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/profile/passkeys/options") {
      if (!adminUser)
        return json(res, 409, { error: "Sign in again to migrate the administrator account." });
      if (!await fresh("passkey_add")) return;
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: adminUser.username,
        userID: Buffer.from(adminUser.id),
        attestationType: "none",
        excludeCredentials: (adminUser.passkeys || []).map((key) => ({
          id: key.id,
          transports: key.transports,
        })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
      s.adminPasskeyChallenges.push({
        id: randomUUID(),
        userId: adminUser.id,
        challenge: options.challenge,
        type: "registration",
        sessionTokenHash: administrator.tokenHash, credentialVersion: adminCredentialVersion(adminUser),
        expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
      });
      return json(res, 200, { challengeId: s.adminPasskeyChallenges.at(-1).id, options });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/profile/passkeys/verify") {
      const challenge = s.adminPasskeyChallenges.find(
        (item) =>
          item.id === i.challengeId &&
          item.userId === adminUser?.id &&
          item.type === "registration",
      );
      if (!challenge || !(Date.parse(challenge.expiresAt) > +clock()))
        return json(res, 400, { error: "Passkey enrollment expired." });
      s.adminPasskeyChallenges = s.adminPasskeyChallenges.filter(item => item.id !== challenge.id);
      if (challenge.sessionTokenHash !== administrator.tokenHash || challenge.credentialVersion !== adminCredentialVersion(adminUser))
        return json(res, 400, { error: "Passkey enrollment changed or belongs to another sign-in. Start again." });
      let verification;
      try { verification = await verifyRegistrationResponse({
        response: i.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: adminOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
      }); } catch { return json(res, 400, { error: "Passkey enrollment failed. Start again." }); }
      if (!verification.verified || !verification.registrationInfo)
        return json(res, 400, { error: "Passkey enrollment failed." });
      const credential = verification.registrationInfo.credential;
      if (s.adminUsers.some(user => (user.passkeys || []).some(key => key.id === credential.id)))
        return json(res, 409, { error: "That passkey is already enrolled." });
      adminUser.passkeys ??= [];
      adminUser.passkeys.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports,
        createdAt: clock().toISOString(),
      });
      s.adminPasskeyChallenges = s.adminPasskeyChallenges.filter(
        (item) => item.id !== challenge.id,
      );
      audit(s, "admin.passkey_enrolled", req, { credentialId: credential.id });
      return json(res, 200, { enrolled: true, passkeys: adminUser.passkeys.length });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/profile/passkeys/remove") {
      const key = adminUser?.passkeys?.find(key => key.id === i.credentialId);
      if (!key) return json(res, 404, { error: "Passkey not found." });
      if (!await fresh("passkey_remove")) return;
      const retained = adminUser.passkeys.filter(item => item.id !== key.id);
      if (!verifiedMethods({ ...adminUser, passkeys: retained }, pepper, true).length)
        return json(res, 409, { code: "LAST_CREDENTIAL", error: "Verify your password or another passkey before removing this passkey." });
      adminUser.passkeys = retained;
      audit(s, "admin.passkey_removed", req, { credentialId: key.id });
      return json(res, 200, { removed: true, passkeys: retained.length });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/profile/mfa/enroll") {
      if (!await fresh("legacy_mfa", { ...i, action: "enroll" })) return;
      const secret = totpSecret();
      s.adminMfaChallenges.push({
        id: randomUUID(),
        userId: adminUser.id,
        sessionTokenHash: administrator.tokenHash,
        credentialVersion: adminCredentialVersion(adminUser),
        secret,
        createdAt: clock().toISOString(),
        expiresAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
      });
      return json(res, 200, {
        challengeId: s.adminMfaChallenges.at(-1).id,
        expiresAt: s.adminMfaChallenges.at(-1).expiresAt,
        secret,
        uri: totpUri(secret, "administrator"),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/profile/mfa/confirm") {
      const challenge = s.adminMfaChallenges.find(item => typeof i.challengeId === "string" && item.id === i.challengeId && item.userId === adminUser?.id);
      if (
        !challenge ||
        challenge.sessionTokenHash !== administrator.tokenHash ||
        challenge.credentialVersion !== adminCredentialVersion(adminUser) ||
        !(Date.parse(challenge.expiresAt) > +clock()) ||
        (challenge.attempts || 0) >= 5
      ) {
        return json(res, 400, {
          error: "Authenticator setup expired or belongs to another sign-in. Start again.",
        });
      }
      if (!verifyTotp(challenge.secret, i.code, +clock())) {
        challenge.attempts = Math.min(5, (challenge.attempts || 0) + 1);
        if (challenge.attempts >= 5) s.adminMfaChallenges = s.adminMfaChallenges.filter(item => item.id !== challenge.id);
        return json(res, challenge.attempts >= 5 ? 429 : 400, { error: "The authenticator code is invalid or expired.", attemptsRemaining: Math.max(0, 5 - challenge.attempts) });
      }
      s.adminProfile = {
        ...s.adminProfile,
        mfaEnabled: true,
        totpSecret: challenge.secret,
        totpEnrolledAt: clock().toISOString(),
        updatedAt: clock().toISOString(),
      };
      delete s.adminProfile.mfaCodeHash;
      s.adminMfaChallenges = [];
      audit(s, "configuration.admin_mfa_changed", req, {
        enabled: true,
        method: "totp",
      });
      return json(res, 200, { mfaEnabled: true });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/profile/mfa") {
      if (i.enabled && !/^\d{6}$/.test(String(i.code || ""))) {
        return json(res, 400, {
          error: "A six-digit MFA code is required.",
        });
      }
      if (!await fresh("legacy_mfa", { ...i, action: "set" })) return;
      s.adminProfile = {
        ...s.adminProfile,
        mfaEnabled: Boolean(i.enabled),
        mfaCodeHash: i.enabled ? hashSecret(i.code, adminSecret) : undefined,
        updatedAt: clock().toISOString(),
      };
      delete s.adminProfile.totpSecret;
      delete s.adminProfile.totpEnrolledAt;
      if (!i.enabled) delete s.adminProfile.mfaCodeHash;
      audit(s, "configuration.admin_mfa_changed", req, {
        enabled: s.adminProfile.mfaEnabled,
      });
      return json(res, 200, { mfaEnabled: s.adminProfile.mfaEnabled });
    }
    return NOT_HANDLED;
  };
}
