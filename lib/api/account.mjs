import { json, body, cookie } from "./http.mjs";
import { view, catalogue, dailyEligibleAt, log, sec } from "./state.mjs";
import {
  secureToken,
  totpSecret,
  totpUri,
  verifyTotp,
  recoveryCode,
} from "../security.mjs";
import { paymentView } from "../billing.mjs";
import { randomUUID } from "node:crypto";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import argon2 from "argon2";

// Recovery codes are hashed with Argon2id so they survive SECRET_PEPPER rotation. OWASP's
// minimum parameters keep a ten-code check near 150 ms; challenges are throttled per phone and IP.
const recoveryCodeHash = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export function createAccountRoutes({
  mutate,
  auth,
  refreshCustomerSession,
  clock,
  customerRpName,
  customerRpID,
  customerOrigin,
  secureCookies,
  sessionScope,
}) {
  return async function (req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/account/dashboard") {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, {
            error: "Dashboard session expired. Please sign in again.",
          });
        }
        refreshCustomerSession(req, res, a);
        const c = s.customers.find((x) => x.id === a.customerId),
          v = s.vouchers.filter((x) => x.customerId === c.id).map((x) => view(x, s));
        const {
          totpSecret: _totpSecret,
          pinHash: _pinHash,
          pinFailedAttempts: _pinFailedAttempts,
          pinNextAttemptAt: _pinNextAttemptAt,
          pinLockedUntil: _pinLockedUntil,
          recoveryCodes: _recoveryCodes,
          passkeys: customerPasskeys = [],
          ...safeCustomer
        } = c;
        a.csrfToken ??= secureToken();
        return json(res, 200, {
          customer: {
            ...safeCustomer,
            authenticatorEnrolled: Boolean(_totpSecret),
            pinConfigured: Boolean(_pinHash),
            passkeys: customerPasskeys.length,
          },
          activeBundle: v.find((x) => x.status === "active") || null,
          vouchers: v,
          payments: s.payments.filter((x) => x.customerId === c.id).map(paymentView),
          sessionExpiresAt: a.expiresAt,
          csrfToken: a.csrfToken,
          zone: { status: s.zone.status, notes: s.zone.notes || undefined },
          availablePlans: catalogue(s),
          currentPlan: v[0] || null,
          dailyAvailability: (() => {
            const eligibleAt = dailyEligibleAt(s, c.id);
            return {
              available: !eligibleAt || eligibleAt <= clock(),
              nextEligibleAt: eligibleAt?.toISOString() || null,
            };
          })(),
        });
      }, { res, ...sessionScope(req) });
    }
    if (req.method === "POST" && url.pathname === "/api/account/security/mfa/enroll") {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.totpSecret) return json(res, 409, { error: "Authenticator 2FA is already enabled." });
        const secret = totpSecret(),
          challenge = {
            id: randomUUID(),
            customerId: c.id,
            secret,
            expiresAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
          };
        s.customerMfaChallenges.push(challenge);
        return json(res, 200, {
          challengeId: challenge.id,
          secret,
          uri: totpUri(secret, c.phone),
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/security/mfa/confirm") {
      const i = await body(req);
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId),
          challenge =
            c &&
            s.customerMfaChallenges.find((x) => x.id === i.challengeId && x.customerId === c.id);
        if (
          !challenge ||
          new Date(challenge.expiresAt) <= clock() ||
          !verifyTotp(challenge.secret, i.code, clock().getTime())
        ) {
          return json(res, 400, { error: "The authenticator code is invalid or expired." });
        }
        c.totpSecret = challenge.secret;
        c.totpEnrolledAt = clock().toISOString();
        s.customerMfaChallenges = s.customerMfaChallenges.filter((x) => x.id !== challenge.id);
        log(s, "customer.authenticator.enrolled", { customerId: c.id });
        queueSecurityAlert(
          s,
          {
            customerId: c.id,
            kind: "authenticator_enrolled",
            subject: "Authenticator two-factor sign-in was enabled",
            lines: [
              "Two-factor authentication with an authenticator app was just enabled on your account.",
            ],
          },
          clock(),
        );
        return json(res, 200, { mfaEnabled: true });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkeys/options") {
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        const options = await generateRegistrationOptions({
          rpName: customerRpName,
          rpID: customerRpID,
          userName: c.phone,
          userID: Buffer.from(c.id),
          attestationType: "none",
          excludeCredentials: (c.passkeys || []).map((key) => ({
            id: key.id,
            transports: key.transports,
          })),
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
        });
        const challenge = {
          id: randomUUID(),
          customerId: c.id,
          challenge: options.challenge,
          type: "registration",
          expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
        };
        s.customerPasskeyChallenges.push(challenge);
        return json(res, 200, { challengeId: challenge.id, options });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkeys/verify") {
      const i = await body(req);
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId),
          challenge =
            c &&
            s.customerPasskeyChallenges.find(
              (x) => x.id === i.challengeId && x.customerId === c.id && x.type === "registration",
            );
        if (!challenge || new Date(challenge.expiresAt) <= clock()) {
          return json(res, 400, { error: "Passkey enrollment expired." });
        }
        const verification = await verifyRegistrationResponse({
          response: i.response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: customerOrigin,
          expectedRPID: customerRpID,
          requireUserVerification: true,
        });
        if (!verification.verified || !verification.registrationInfo) {
          return json(res, 400, { error: "Passkey enrollment failed." });
        }
        const credential = verification.registrationInfo.credential;
        c.passkeys ??= [];
        c.passkeys.push({
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          transports: credential.transports,
          createdAt: clock().toISOString(),
          label:
            String(i.label || "")
              .trim()
              .slice(0, 60) || `Passkey ${c.passkeys.length + 1}`,
        });
        s.customerPasskeyChallenges = s.customerPasskeyChallenges.filter(
          (x) => x.id !== challenge.id,
        );
        log(s, "customer.passkey.enrolled", { customerId: c.id });
        queueSecurityAlert(
          s,
          {
            customerId: c.id,
            kind: "passkey_added",
            subject: "A new passkey was added to your NDAHI Connect account",
            lines: ["A new passkey was just added and can now be used to sign in to your account."],
          },
          clock(),
        );
        return json(res, 200, { enrolled: true, passkeys: c.passkeys.length });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkeys/rename") {
      const i = await body(req);
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId),
          key = c?.passkeys?.find((k) => k.id === i.passkeyId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (!key) return json(res, 404, { error: "Passkey not found." });
        const label = String(i.label || "")
          .trim()
          .slice(0, 60);
        if (!label) return json(res, 400, { error: "Enter a name for this passkey." });
        key.label = label;
        log(s, "customer.passkey.renamed", { customerId: c.id });
        return json(res, 200, { renamed: true, label: key.label });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkeys/remove") {
      const i = await body(req);
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId),
          key = c?.passkeys?.find((k) => k.id === i.passkeyId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (!key) return json(res, 404, { error: "Passkey not found." });
        c.passkeys = c.passkeys.filter((k) => k.id !== key.id);
        log(s, "customer.passkey.removed", { customerId: c.id });
        queueSecurityAlert(
          s,
          {
            customerId: c.id,
            kind: "passkey_removed",
            subject: "A passkey was removed from your NDAHI Connect account",
            lines: [
              `The passkey "${key.label || "Passkey"}" was removed and can no longer sign in to your account.`,
              "If you didn't remove it, sign in and review your account security.",
            ],
          },
          clock(),
        );
        return json(res, 200, { removed: true, passkeys: c.passkeys.length });
      });
    }
    if (req.method === "GET" && url.pathname === "/api/account/security") {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
        }
        refreshCustomerSession(req, res, a);
        const c = s.customers.find((x) => x.id === a.customerId),
          loginTypes = new Set([
            "customer.pin_login.succeeded",
            "customer.otp_login.succeeded",
            "customer.passkey_login.succeeded",
            "customer.recovery_code_login.succeeded",
            "customer.access.succeeded",
          ]);
        a.csrfToken ??= secureToken();
        return json(res, 200, {
          sessions: s.dashboardSessions
            .filter((x) => x.customerId === c.id)
            .map((x) => ({
              id: x.id,
              createdAt: x.createdAt,
              lastSeenAt: x.lastSeenAt || x.createdAt,
              ip: x.ip,
              userAgent: x.userAgent,
              current: x === a,
            }))
            .sort(
              (x, y) =>
                y.current - x.current ||
                Date.parse(y.lastSeenAt || 0) - Date.parse(x.lastSeenAt || 0),
            ),
          recentLogins: s.securityEvents
            .filter((e) => loginTypes.has(e.type) && e.meta?.customerId === c.id)
            .slice(0, 20)
            .map((e) => ({ type: e.type, at: e.at, ip: e.ip })),
          passkeys: (c.passkeys || []).map((k) => ({
            id: k.id,
            label: k.label || "Passkey",
            createdAt: k.createdAt,
          })),
          authenticatorEnrolled: Boolean(c.totpSecret),
          pinConfigured: Boolean(c.pinHash),
          recoveryCodesRemaining: c.totpSecret
            ? (c.recoveryCodes || []).filter((code) => !code.usedAt).length
            : null,
          csrfToken: a.csrfToken,
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/security/sessions/revoke") {
      const i = await body(req);
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
        }
        const target = s.dashboardSessions.find(
          (x) => x.id && x.id === i.sessionId && x.customerId === a.customerId,
        );
        if (!target) return json(res, 404, { error: "Session not found." });
        const self = target === a;
        s.dashboardSessions = s.dashboardSessions.filter((x) => x !== target);
        sec(s, "customer.session.revoked", req, { customerId: a.customerId, self });
        return self
          ? json(
              res,
              200,
              { revoked: true, loggedOut: true },
              {
                "set-cookie": cookie("customer_session", "", 0, secureCookies),
              },
            )
          : json(res, 200, { revoked: true });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/security/logout-everywhere") {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
        }
        const count = s.dashboardSessions.filter((x) => x.customerId === a.customerId).length;
        s.dashboardSessions = s.dashboardSessions.filter((x) => x.customerId !== a.customerId);
        sec(s, "customer.sessions.revoked_all", req, {
          customerId: a.customerId,
          severity: "high",
          count,
        });
        return json(
          res,
          200,
          { loggedOut: true, sessionsRevoked: count },
          {
            "set-cookie": cookie("customer_session", "", 0, secureCookies),
          },
        );
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/security/recovery-codes/generate") {
      // Check the session before spending hashing work, and hash outside the store lock.
      const eligible = (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId);
        if (!c) return { response: () => json(res, 401, { error: "Customer session expired." }) };
        if (!c.totpSecret) {
          return { response: () => json(res, 409, { error: "Enable authenticator 2FA before generating recovery codes." }) };
        }
        return { customer: c };
      };
      const rejection = await mutate((s) => eligible(s).response);
      if (rejection) return rejection();
      const codes = Array.from({ length: 10 }, () => recoveryCode()),
        hashes = await Promise.all(codes.map((code) => argon2.hash(code, recoveryCodeHash)));
      return mutate((s) => {
        const { customer: c, response } = eligible(s);
        if (response) return response();
        const generatedAt = clock().toISOString();
        c.recoveryCodes = codes.map((_, index) => ({
          id: randomUUID(),
          argon2Hash: hashes[index],
          createdAt: generatedAt,
          usedAt: null,
        }));
        log(s, "customer.recovery_codes.generated", { customerId: c.id, count: codes.length });
        queueSecurityAlert(
          s,
          {
            customerId: c.id,
            kind: "recovery_codes_regenerated",
            subject: "New NDAHI Connect recovery codes were generated",
            lines: [
              "New account recovery codes were generated. Any previously issued codes no longer work.",
              "If you didn't request this, sign in and review your account security.",
            ],
          },
          clock(),
        );
        return json(res, 200, { codes, remaining: codes.length });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/devices/disconnect") {
      const i = await body(req);
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, {
            error: "Dashboard session expired. Please sign in again.",
          });
        }
        const x = s.sessions.find((x) => x.id === i.sessionId && x.status === "online"),
          v = x && s.vouchers.find((v) => v.id === x.voucherId && v.customerId === a.customerId);
        if (!x || !v) {
          return json(res, 404, { error: "Active device session not found." });
        }
        x.status = "disconnected";
        x.disconnectedAt = clock().toISOString();
        enqueueRouterCommand(s, { action: "disconnect_device", targetId: x.deviceId }, clock);
        return json(res, 200, {
          message: "Device disconnected. Its slot is now available.",
          voucher: view(v, s),
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/devices/connect") {
      const i = await body(req);
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, {
            error: "Dashboard session expired. Please sign in again.",
          });
        }
        const v = s.vouchers.find((v) => v.customerId === a.customerId && v.status === "active");
        if (!v) {
          return json(res, 409, {
            error: "You don't have an active bundle yet. Choose a package to get started.",
          });
        }
        const deviceId = String(i.deviceId || "").slice(0, 200) || secureToken(16);
        let session = s.sessions.find(
          (x) => x.voucherId === v.id && x.deviceId === deviceId && x.status === "online",
        );
        const active = s.sessions.filter((x) => x.voucherId === v.id && x.status === "online");
        if (!session && active.length >= v.deviceLimit) {
          return json(res, 409, {
            error: `Device limit reached (${v.deviceLimit}). Disconnect another device first.`,
          });
        }
        if (!session) {
          session = {
            id: randomUUID(),
            voucherId: v.id,
            deviceId,
            label: String(i.label || "Device").slice(0, 80),
            status: "online",
            connectedAt: clock().toISOString(),
          };
          s.sessions.push(session);
        }
        session.lastSeenAt = clock().toISOString();
        log(s, "device.connected", { voucherId: v.id, deviceId });
        return json(res, 200, { voucher: view(v, s), session });
      });
    }
    return NOT_HANDLED;
  };
}
