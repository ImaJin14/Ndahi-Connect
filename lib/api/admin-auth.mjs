import { authenticatorRetired, recordVerifiedMethod } from "../authentication-migration.mjs";
import { createAdminMigrationRoutes } from "./authentication-migration.mjs";
import { body, json, cookie, ip, cookies } from "./http.mjs";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import { secureToken, hashSecret, safeEqual } from "../security.mjs";
import { audit, sec } from "./state.mjs";
import argon2 from "argon2";
import { NOT_HANDLED } from "./routing.mjs";
import { adminCredentialVersion, adminRoles } from "../admin-sensitive-actions.mjs";
export function createAdminAuthRoutes(context) {
  const passkeyRegistration = (user) => generateRegistrationOptions({
    rpName: context.rpName || "NDAHI Connect", rpID: context.rpID, userName: user.email || user.username, userID: Buffer.from(user.id),
    attestationType: "none", excludeCredentials: (user.passkeys || []).map((key) => ({ id: key.id, transports: key.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
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
  rpName = "NDAHI Connect",
  pepper,
} = context;
  const migration = createAdminMigrationRoutes(context);
  // Phase 6 sign-in (decisions: "email + PIN, then passkey"). Staff are found by
  // email; the username still works so nobody is locked out before adding one.
  const identifier = (i) => String(i.email ?? i.username ?? env.ADMIN_USERNAME ?? "owner").trim().toLowerCase();
  const findAdmin = (s, id) => s.adminUsers.find((item) => (item.username === id || (item.email && item.email === id)) &&
    item.active !== false && adminRoles.has(item.role));
  const issueSession = (s, user, req, res, event, extra = {}) => {
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
    audit(s, event, req);
    return json(res, 200, { authenticated: true, expiresAt, mfaEnabled: false, ...extra, user: { username: user.username, role: user.role } },
      { "set-cookie": cookie("admin_session", token, seconds, secureCookies) });
  };
  // The PIN step leaves a single-use, five-minute step bound to this person's
  // credentials; only its secret token plus the passkey finish the sign-in.
  const stepChallenge = (s, user, type, challenge, stepToken) => {
    s.adminPasskeyChallenges.push({
      id: randomUUID(), userId: user.id, type, challenge,
      stepTokenHash: hashSecret(stepToken, adminSecret),
      credentialVersion: adminCredentialVersion(user),
      expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
    });
    return s.adminPasskeyChallenges.at(-1).id;
  };
  const takeStep = (s, i, type) => {
    const challenge = s.adminPasskeyChallenges.find((item) => item.id === i.challengeId && item.type === type),
      user = challenge && s.adminUsers.find((item) => item.id === challenge.userId);
    if (challenge) s.adminPasskeyChallenges = s.adminPasskeyChallenges.filter((item) => item.id !== challenge.id);
    if (!challenge || !user || user.active === false || !adminRoles.has(user.role) || !(Date.parse(challenge.expiresAt) > +clock()) ||
      !safeEqual(hashSecret(String(i.stepToken || ""), adminSecret), challenge.stepTokenHash || "") ||
      challenge.credentialVersion !== adminCredentialVersion(user)) return {};
    return { challenge, user };
  };
  return async function (req, res, url) {
    if (await migration(req, res, url) !== NOT_HANDLED) return;
    if (req.method === "POST" && url.pathname === "/api/admin/passkey/options") {
      const i = await body(req);
      return mutate(async (s) => {
        // After the cutover a passkey confirms the PIN; it no longer signs in alone.
        if (authenticatorRetired(s))
          return json(res, 409, { code: "PIN_STEP_REQUIRED", error: "Sign in with your email and PIN, then confirm with your passkey." });
        const user = findAdmin(s, String(i.email ?? i.username ?? "").trim().toLowerCase());
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
        const username = identifier(i);
        const candidate = i.password ?? i.pin;
        let user = findAdmin(s, username),
          validCredential = (user?.pinHash || user?.passwordHash)
            ? await argon2.verify(user.passwordHash || user.pinHash, String(candidate || "")).catch(() => false)
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
        req.adminActor = user.username;
        // Step 2 (canvas: AdminLogin): an administrator with a passkey confirms with it.
        if (user.passkeys?.length) {
          const options = await generateAuthenticationOptions({
            rpID, userVerification: "required",
            allowCredentials: user.passkeys.map((key) => ({ id: key.id, transports: key.transports })),
          });
          const stepToken = secureToken(), challengeId = stepChallenge(s, user, "login_passkey_step", options.challenge, stepToken);
          audit(s, "admin.login.pin_verified", req);
          return json(res, 200, { authenticated: false, step: "passkey", challengeId, stepToken, options });
        }
        // After the cutover every administrator needs a passkey: add one now.
        if (authenticatorRetired(s)) {
          const options = await passkeyRegistration(user);
          const stepToken = secureToken(), challengeId = stepChallenge(s, user, "login_passkey_setup", options.challenge, stepToken);
          audit(s, "admin.login.pin_verified", req);
          return json(res, 200, { authenticated: false, step: "passkey_setup", challengeId, stepToken, options });
        }
        // Before the cutover the PIN still signs in alone; the screen offers a passkey.
        return issueSession(s, user, req, res, "admin.login.succeeded", { passkeySetup: "recommended" });
      }, { res });
    }
    // Step 2: the passkey confirms the PIN and opens the session.
    if (req.method === "POST" && url.pathname === "/api/admin/login/passkey") {
      const i = await body(req);
      return mutate(async (s) => {
        const { challenge, user } = takeStep(s, i, "login_passkey_step"), key = user?.passkeys?.find((item) => item.id === i.response?.id);
        if (!challenge || !key) {
          sec(s, "admin.login.failed", req);
          return json(res, 401, { error: "This sign-in expired or changed. Start again with your email and PIN." });
        }
        let verification;
        try { verification = await verifyAuthenticationResponse({
          response: i.response, expectedChallenge: challenge.challenge, expectedOrigin: adminOrigin, expectedRPID: rpID,
          requireUserVerification: true,
          credential: { id: key.id, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, transports: key.transports },
        }); } catch { verification = null; }
        if (!verification?.verified) {
          sec(s, "admin.login.failed", req);
          return json(res, 401, { error: "Passkey verification failed. Start again with your email and PIN." });
        }
        key.counter = verification.authenticationInfo.newCounter;
        return issueSession(s, user, req, res, "admin.login.succeeded");
      }, { res });
    }
    // An administrator without a passkey adds one to finish signing in
    // (required after the cutover; offered before it).
    if (req.method === "POST" && url.pathname === "/api/admin/login/passkey-setup") {
      const i = await body(req);
      return mutate(async (s) => {
        const { challenge, user } = takeStep(s, i, "login_passkey_setup");
        if (!challenge) return json(res, 401, { error: "This sign-in expired or changed. Start again with your email and PIN." });
        let verification;
        try { verification = await verifyRegistrationResponse({
          response: i.response, expectedChallenge: challenge.challenge, expectedOrigin: adminOrigin, expectedRPID: rpID,
          requireUserVerification: true,
        }); } catch { verification = null; }
        const credential = verification?.verified && verification.registrationInfo?.credential;
        if (!credential) return json(res, 400, { error: "Adding the passkey failed. Start again with your email and PIN." });
        if (s.adminUsers.some((item) => (item.passkeys || []).some((key) => key.id === credential.id)))
          return json(res, 409, { error: "That passkey is already enrolled." });
        user.passkeys ??= [];
        user.passkeys.push({
          id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter, transports: credential.transports, createdAt: clock().toISOString(),
        });
        if (pepper) recordVerifiedMethod(user, "passkey", credential.id, pepper, clock());
        req.adminActor = user.username;
        audit(s, "admin.passkey_enrolled", req, { credentialId: credential.id, atSignIn: true });
        return issueSession(s, user, req, res, "admin.login.succeeded");
      }, { res });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/login/mfa") {
      return json(res, 410, { code: "AUTHENTICATOR_RETIRED", error: "Authenticator access has retired. Use your password or passkey." });
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
