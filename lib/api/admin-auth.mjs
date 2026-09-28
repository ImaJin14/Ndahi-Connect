import { body, json, cookie, ip, cookies } from "./http.mjs";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import { secureToken, hashSecret, safeEqual, verifyTotp } from "../security.mjs";
import { audit, sec } from "./state.mjs";
import argon2 from "argon2";
import { NOT_HANDLED } from "./routing.mjs";
export function createAdminAuthRoutes({
  mutate,
  rpID,
  clock,
  adminOrigin,
  env,
  adminSecret,
  secureCookies,
  verifyBootstrapCredential,
  matchesRotatingHash,
  previousAdminSecret,
  auth,
}) {
  return async function (req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/admin/passkey/options") {
      const i = await body(req);
      return mutate(async (s) => {
        const user = s.adminUsers.find(
          (item) =>
            item.username ===
              String(i.username || "")
                .trim()
                .toLowerCase() && item.active !== false,
        );
        if (!user?.passkeys?.length)
          return json(res, 404, { error: "No passkey is enrolled for this account." });
        const options = await generateAuthenticationOptions({
          rpID,
          userVerification: "required",
          allowCredentials: user.passkeys.map((key) => ({
            id: key.id,
            transports: key.transports,
          })),
        });
        s.adminPasskeyChallenges.push({
          id: randomUUID(),
          userId: user.id,
          challenge: options.challenge,
          expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
        });
        return json(res, 200, { challengeId: s.adminPasskeyChallenges.at(-1).id, options });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/passkey/verify") {
      const i = await body(req);
      return mutate(async (s) => {
        const challenge = s.adminPasskeyChallenges.find((item) => item.id === i.challengeId),
          user = challenge && s.adminUsers.find((item) => item.id === challenge.userId),
          key = user?.passkeys?.find((item) => item.id === i.response?.id);
        if (!challenge || !user || !key || new Date(challenge.expiresAt) <= clock())
          return json(res, 401, { error: "Passkey challenge is invalid or expired." });
        const verification = await verifyAuthenticationResponse({
          response: i.response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: adminOrigin,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: key.id,
            publicKey: Buffer.from(key.publicKey, "base64url"),
            counter: key.counter,
            transports: key.transports,
          },
        });
        if (!verification.verified)
          return json(res, 401, { error: "Passkey verification failed." });
        key.counter = verification.authenticationInfo.newCounter;
        s.adminPasskeyChallenges = s.adminPasskeyChallenges.filter(
          (item) => item.id !== challenge.id,
        );
        const token = secureToken(),
          seconds = Number(env.ADMIN_SESSION_SECONDS || 1800),
          expiresAt = new Date(clock().getTime() + seconds * 1000).toISOString();
        s.adminSessions.push({
          tokenHash: hashSecret(token, adminSecret),
          userId: user.id,
          role: user.role,
          csrfToken: secureToken(),
          createdAt: clock().toISOString(),
          lastSeenAt: clock().toISOString(),
          expiresAt,
        });
        req.adminActor = user.username;
        audit(s, "admin.passkey_login.succeeded", req);
        return json(
          res,
          200,
          { authenticated: true, expiresAt, user: { username: user.username, role: user.role } },
          { "set-cookie": cookie("admin_session", token, seconds, secureCookies) },
        );
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const i = await body(req);
      return mutate(async (s) => {
        const recent = s.securityEvents.filter(
          (x) =>
            x.type === "admin.login.failed" &&
            x.ip === ip(req) &&
            new Date(x.at) > new Date(clock() - 9e5),
        );
        if (recent.length >= 5) {
          audit(s, "admin.login.rate_limited", req);
          return json(res, 429, {
            error: "Too many login attempts. Try again later.",
          });
        }
        const username = String(i.username || env.ADMIN_USERNAME || "owner")
          .trim()
          .toLowerCase();
        let user = s.adminUsers.find((item) => item.username === username && item.active !== false),
          validPassword = user?.passwordHash
            ? await argon2.verify(user.passwordHash, String(i.password || i.pin || ""))
            : !s.adminUsers.length && (await verifyBootstrapCredential(i.password || i.pin));
        if (!validPassword) {
          sec(s, "admin.login.failed", req);
          audit(s, "admin.login.failed", req);
          return json(res, 401, { error: "Invalid admin credentials." });
        }
        if (!user) {
          user = {
            id: randomUUID(),
            username,
            displayName: "Owner",
            role: "owner",
            passwordHash: await argon2.hash(String(i.password || i.pin)),
            passkeys: [],
            active: true,
            createdAt: clock().toISOString(),
          };
          s.adminUsers.push(user);
        }
        const mfaEnabled = env.ADMIN_MFA_ENABLED === "true" || s.adminProfile?.mfaEnabled;
        if (mfaEnabled) {
          const challenge = {
            id: secureToken(24),
            userId: user.id,
            ip: ip(req),
            attempts: 0,
            used: false,
            expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
          };
          s.adminLoginChallenges = (s.adminLoginChallenges || []).filter(
            (x) => new Date(x.expiresAt) > clock() && !x.used,
          );
          s.adminLoginChallenges.push(challenge);
          audit(s, "admin.login.password_verified", req, { userId: user.id });
          return json(res, 202, {
            authenticated: false,
            mfaRequired: true,
            challengeId: challenge.id,
            expiresAt: challenge.expiresAt,
          });
        }
        const token = secureToken(),
          seconds = Number(env.ADMIN_SESSION_SECONDS || 1800),
          expiresAt = new Date(clock().getTime() + seconds * 1000).toISOString();
        const csrfToken = secureToken();
        s.adminSessions.push({
          tokenHash: hashSecret(token, adminSecret),
          userId: user.id,
          role: user.role,
          csrfToken,
          createdAt: clock().toISOString(),
          lastSeenAt: clock().toISOString(),
          expiresAt,
        });
        req.adminActor = user.username;
        audit(s, "admin.login.succeeded", req);
        return json(
          res,
          200,
          {
            authenticated: true,
            expiresAt,
            mfaEnabled,
            user: { username: user.username, role: user.role },
          },
          {
            "set-cookie": cookie("admin_session", token, seconds, secureCookies),
          },
        );
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/login/mfa") {
      const i = await body(req);
      return mutate((s) => {
        const challenge = (s.adminLoginChallenges || []).find(
            (x) => safeEqual(x.id, i.challengeId) && !x.used,
          ),
          user =
            challenge && s.adminUsers.find((x) => x.id === challenge.userId && x.active !== false);
        if (
          !challenge ||
          !user ||
          challenge.ip !== ip(req) ||
          new Date(challenge.expiresAt) <= clock() ||
          challenge.attempts >= 5
        ) {
          return json(res, 401, {
            error: "The MFA challenge is invalid or expired. Sign in again.",
          });
        }
        const validMfa = s.adminProfile?.totpSecret
          ? verifyTotp(s.adminProfile.totpSecret, i.mfaCode, clock().getTime())
          : env.ADMIN_MFA_CODE
            ? safeEqual(i.mfaCode || "", env.ADMIN_MFA_CODE)
            : s.adminProfile?.mfaCodeHash &&
              matchesRotatingHash(
                i.mfaCode,
                s.adminProfile.mfaCodeHash,
                adminSecret,
                previousAdminSecret,
              );
        if (!validMfa) {
          challenge.attempts++;
          sec(s, "admin.mfa.failed", req, { userId: user.id });
          return json(res, 401, {
            error: "The authenticator code is invalid or expired.",
            attemptsRemaining: Math.max(0, 5 - challenge.attempts),
          });
        }
        challenge.used = true;
        const token = secureToken(),
          seconds = Number(env.ADMIN_SESSION_SECONDS || 1800),
          expiresAt = new Date(clock().getTime() + seconds * 1000).toISOString(),
          csrfToken = secureToken();
        s.adminSessions.push({
          tokenHash: hashSecret(token, adminSecret),
          userId: user.id,
          role: user.role,
          csrfToken,
          createdAt: clock().toISOString(),
          lastSeenAt: clock().toISOString(),
          expiresAt,
        });
        req.adminActor = user.username;
        audit(s, "admin.login.succeeded", req);
        return json(
          res,
          200,
          {
            authenticated: true,
            expiresAt,
            mfaEnabled: true,
            user: { username: user.username, role: user.role },
          },
          {
            "set-cookie": cookie("admin_session", token, seconds, secureCookies),
          },
        );
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      return mutate((s) => {
        const session = auth(req, s, "adminSessions");
        if (!session) {
          return json(res, 401, { error: "Admin session expired." });
        }
        if (
          env.NODE_ENV === "production" &&
          !safeEqual(req.headers["x-csrf-token"] || "", session.csrfToken || "")
        )
          return json(res, 403, { error: "Security token expired." });
        const token = cookies(req).admin_session;
        s.adminSessions = s.adminSessions.filter(
          (x) => !matchesRotatingHash(token, x.tokenHash, adminSecret, previousAdminSecret),
        );
        audit(s, "admin.logout", req);
        return json(
          res,
          200,
          { loggedOut: true },
          {
            "set-cookie": cookie("admin_session", "", 0, secureCookies),
          },
        );
      });
    }
    return NOT_HANDLED;
  };
}
