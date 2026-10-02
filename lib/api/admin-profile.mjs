import { json } from "./http.mjs";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { audit } from "./state.mjs";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { totpSecret, totpUri, verifyTotp, hashSecret } from "../security.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createAdminProfileRoutes({ clock, rpName, rpID, adminOrigin, adminSecret }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    if (req.method === "POST" && url.pathname === "/api/admin/users") {
      const username = String(i.username || "")
          .trim()
          .toLowerCase(),
        role = String(i.role || "auditor"),
        password = String(i.password || "");
      if (
        !/^[a-z0-9._-]{3,40}$/.test(username) ||
        !["owner", "operator", "reseller", "auditor"].includes(role) ||
        password.length < 14
      ) {
        return json(res, 400, {
          error: "Enter a valid username, role, and password of at least 14 characters.",
        });
      }
      if (s.adminUsers.some((user) => user.username === username))
        return json(res, 409, { error: "That administrator already exists." });
      const user = {
        id: randomUUID(),
        username,
        displayName: String(i.displayName || username).slice(0, 80),
        role,
        passwordHash: await argon2.hash(password),
        passkeys: [],
        active: true,
        createdAt: clock().toISOString(),
      };
      s.adminUsers.push(user);
      audit(s, "admin.user_created", req, { userId: user.id, username, role });
      return json(res, 201, {
        user: { id: user.id, username, displayName: user.displayName, role, active: true },
      });
    }
    // Incident containment (DEP-006): owners can disable another administrator at once.
    // There is no reactivation; restore access with a new account and fresh credentials.
    if (req.method === "POST" && url.pathname === "/api/admin/users/deactivate") {
      const target = s.adminUsers.find((user) => user.id === i.userId);
      if (!target) return json(res, 404, { error: "Administrator not found." });
      if (target.id === adminUser?.id) {
        return json(res, 409, { error: "You cannot deactivate your own account." });
      }
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
      if (!challenge || new Date(challenge.expiresAt) <= clock())
        return json(res, 400, { error: "Passkey enrollment expired." });
      const verification = await verifyRegistrationResponse({
        response: i.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: adminOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo)
        return json(res, 400, { error: "Passkey enrollment failed." });
      const credential = verification.registrationInfo.credential;
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
    if (req.method === "POST" && url.pathname === "/api/admin/profile/mfa/enroll") {
      const secret = totpSecret();
      s.adminMfaChallenges.push({
        secret,
        createdAt: clock().toISOString(),
        expiresAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
      });
      return json(res, 200, {
        secret,
        uri: totpUri(secret, "administrator"),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/profile/mfa/confirm") {
      const challenge = s.adminMfaChallenges.at(-1);
      if (
        !challenge ||
        new Date(challenge.expiresAt) <= clock() ||
        !verifyTotp(challenge.secret, i.code, clock().getTime())
      ) {
        return json(res, 400, {
          error: "The authenticator code is invalid or expired.",
        });
      }
      s.adminProfile = {
        mfaEnabled: true,
        totpSecret: challenge.secret,
        updatedAt: clock().toISOString(),
      };
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
      s.adminProfile = {
        mfaEnabled: Boolean(i.enabled),
        mfaCodeHash: i.enabled ? hashSecret(i.code, adminSecret) : undefined,
        updatedAt: clock().toISOString(),
      };
      audit(s, "configuration.admin_mfa_changed", req, {
        enabled: s.adminProfile.mfaEnabled,
      });
      return json(res, 200, { mfaEnabled: s.adminProfile.mfaEnabled });
    }
    return NOT_HANDLED;
  };
}
