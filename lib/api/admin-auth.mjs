import { authenticatorRetired } from "../authentication-migration.mjs";
import { createAdminMigrationRoutes } from "./authentication-migration.mjs";
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
import { adminCredentialVersion, adminRoles } from "../admin-sensitive-actions.mjs";
export function createAdminAuthRoutes(context) {
  const {
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
} = context;
  const migration = createAdminMigrationRoutes(context);
  return async function (req, res, url) {
    if (await migration(req, res, url) !== NOT_HANDLED) return;
    if (req.method === "POST" && url.pathname === "/api/admin/passkey/options") {
      const i = await body(req);
      return mutate(async (s) => {
        const user = s.adminUsers.find(
          (item) =>
            item.username ===
              String(i.username || "")
                .trim()
                .toLowerCase() && item.active !== false && adminRoles.has(item.role),
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
          type: "login",
          credentialVersion: adminCredentialVersion(user),
          challenge: options.challenge,
          expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
        });
        return json(res, 200, { challengeId: s.adminPasskeyChallenges.at(-1).id, options });
      }, { res });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/passkey/verify") {
      const i = await body(req);
      return mutate(async (s) => {
        const challenge = s.adminPasskeyChallenges.find((item) => item.id === i.challengeId),
          user = challenge && s.adminUsers.find((item) => item.id === challenge.userId),
          key = user?.passkeys?.find((item) => item.id === i.response?.id);
        if (!challenge || challenge.type !== "login" || !user || user.active === false || !adminRoles.has(user.role) || !key || !(Date.parse(challenge.expiresAt) > +clock()))
          return json(res, 401, { error: "Passkey challenge is invalid or expired." });
        s.adminPasskeyChallenges = s.adminPasskeyChallenges.filter(item => item.id !== challenge.id);
        if ((authenticatorRetired(s) || challenge.credentialVersion) && challenge.credentialVersion !== adminCredentialVersion(user))
          return json(res, 401, { error: "Administrator credentials changed. Sign in again." });
        let verification;
        try { verification = await verifyAuthenticationResponse({
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
        }); } catch { return json(res, 401, { error: "Passkey verification failed. Start again." }); }
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
      }, { res });
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
        const candidate = i.pin ?? i.password;
        let user = s.adminUsers.find((item) => item.username === username && item.active !== false && adminRoles.has(item.role)),
          validCredential = (user?.pinHash || user?.passwordHash)
            ? await argon2.verify(user.pinHash || user.passwordHash, String(candidate || "")).catch(() => false)
            : !s.adminUsers.length && (await verifyBootstrapCredential(candidate));
        if (!validCredential) {
          sec(s, "admin.login.failed", req);
          audit(s, "admin.login.failed", req);
          return json(res, 401, { error: "Invalid admin credentials." });
        }
        if (!user) {
          const hash = await argon2.hash(String(candidate));
          user = {
            id: randomUUID(),
            username,
            displayName: "Owner",
            role: "owner",
            pinHash: hash,
            passwordHash: hash,
            passkeys: [],
            active: true,
            createdAt: clock().toISOString(),
          };
          s.adminUsers.push(user);
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
            mfaEnabled: false,
            user: { username: user.username, role: user.role },
          },
          {
            "set-cookie": cookie("admin_session", token, seconds, secureCookies),
          },
        );
      }, { res });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/login/mfa") {
      return json(res, 410, { code: "AUTHENTICATOR_RETIRED", error: "Authenticator access has retired. Use your PIN or passkey." });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      return mutate((s) => {
        const session = auth(req, s, "adminSessions");
        const user = session && s.adminUsers.find(item => item.id === session.userId);
        if (!session || user?.active === false || !adminRoles.has(user?.role || session.role) ||
          (!user && (session.userId || authenticatorRetired(s)))) {
          return json(res, 401, { error: "Admin session expired." });
        }
        if (
          (env.NODE_ENV === "production" || authenticatorRetired(s)) &&
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
      }, { res });
    }
    return NOT_HANDLED;
  };
}
