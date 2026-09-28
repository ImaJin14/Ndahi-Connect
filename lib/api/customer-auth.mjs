import { body, ip, json, cookies, cookie } from "./http.mjs";
import { phone, phoneOk, sec, findPlan, log } from "./state.mjs";
import {
  normalizeActivationCode,
  safeEqual,
  secureToken,
  hashSecret,
  normalizeRecoveryCode,
  verifyTotp,
} from "../security.mjs";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { NOT_HANDLED } from "./routing.mjs";
export function createCustomerAuthRoutes({
  mutate,
  clock,
  generic,
  pepper,
  matchesRotatingHash,
  previousPepper,
  pinThrottle,
  recordPinFailure,
  clearPinFailures,
  issueCustomerSession,
  email,
  customerRpID,
  customerOrigin,
  customerSecret,
  previousCustomerSecret,
  secureCookies,
  customerScope,
}) {
  return async function (req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/account/access/begin") {
      const i = await body(req);
      return mutate((s) => {
        const ph = phone(i.phone),
          code = normalizeActivationCode(i.code),
          cutoff = new Date(clock().getTime() - 15 * 60_000),
          failures = s.securityEvents.filter(
            (event) =>
              event.type === "customer.access.failed" &&
              new Date(event.at) > cutoff &&
              (event.ip === ip(req) || event.meta?.phone === ph),
          );
        if (failures.length >= 5) {
          return json(res, 429, { error: "Too many access attempts. Try again in 15 minutes." });
        }
        const customer = s.customers.find(
            (item) => item.phone === ph && item.status !== "suspended",
          ),
          voucher = s.vouchers.find((item) => safeEqual(item.code, code)),
          linked = voucher && customer && voucher.customerId === customer.id,
          claimable = voucher?.status === "available" && !voucher.customerId;
        if (
          !phoneOk(ph) ||
          !voucher ||
          (!customer && !claimable) ||
          (customer && !linked && !claimable) ||
          (linked && !["active", "expired", "exhausted"].includes(voucher.status))
        ) {
          sec(s, "customer.access.failed", req, { phone: ph });
          return json(res, 401, { error: generic });
        }
        if (
          claimable &&
          customer &&
          s.vouchers.some((item) => item.customerId === customer.id && item.status === "active")
        ) {
          return json(res, 409, {
            error:
              "Your account already has an active bundle. Use its voucher to sign in before adding another package.",
          });
        }
        const token = secureToken(32),
          mode = customer?.pinHash ? "login" : "setup";
        s.customerAccessChallenges.push({
          tokenHash: hashSecret(token, pepper),
          phone: ph,
          voucherId: voucher.id,
          mode,
          used: false,
          createdAt: clock().toISOString(),
          expiresAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
        });
        return json(res, 200, { token, mode, expiresIn: 600 });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/access/complete") {
      const i = await body(req);
      if (!/^\d{4}$/.test(String(i.pin || ""))) {
        return json(res, 400, { error: "PIN must contain exactly 4 numeric digits." });
      }
      return mutate(async (s) => {
        const challenge = s.customerAccessChallenges.find(
          (item) =>
            !item.used &&
            matchesRotatingHash(String(i.token || ""), item.tokenHash, pepper, previousPepper),
        );
        if (!challenge || new Date(challenge.expiresAt) <= clock()) {
          sec(s, "customer.access.failed", req);
          return json(res, 401, { error: "This access attempt expired. Start again." });
        }
        const recentFailures = s.securityEvents.filter(
          (event) =>
            event.type === "customer.access.failed" &&
            new Date(event.at) > new Date(clock().getTime() - 15 * 60_000) &&
            (event.ip === ip(req) || event.meta?.phone === challenge.phone),
        );
        if (recentFailures.length >= 5) {
          return json(res, 429, { error: "Too many access attempts. Try again in 15 minutes." });
        }
        const voucher = s.vouchers.find((item) => item.id === challenge.voucherId);
        let customer = s.customers.find(
          (item) => item.phone === challenge.phone && item.status !== "suspended",
        );
        const linked = voucher && customer && voucher.customerId === customer.id,
          claimable = voucher?.status === "available" && !voucher.customerId;
        if (
          !voucher ||
          (!linked && !claimable) ||
          (linked && !["active", "expired", "exhausted"].includes(voucher.status))
        ) {
          challenge.used = true;
          sec(s, "customer.access.failed", req, { phone: challenge.phone });
          return json(res, 401, { error: generic });
        }
        const claimPlan = claimable ? findPlan(s, voucher.planId) : null;
        if (claimable && !claimPlan) {
          return json(res, 409, { error: "This voucher's bundle is unavailable." });
        }
        if (
          claimable &&
          customer &&
          s.vouchers.some((item) => item.customerId === customer.id && item.status === "active")
        ) {
          return json(res, 409, {
            error: "Your account already has an active bundle. This voucher was not used.",
          });
        }
        if (challenge.mode === "login") {
          const throttle = pinThrottle(customer);
          if (throttle) {
            return json(
              res,
              429,
              {
                error: throttle.locked
                  ? "PIN sign-in is temporarily locked. Use a passkey or Google Authenticator, or try again later."
                  : "Wait briefly before trying the PIN again.",
                ...throttle,
              },
              { "retry-after": String(throttle.retryAfterSeconds) },
            );
          }
          if (!customer?.pinHash || !(await argon2.verify(customer.pinHash, i.pin))) {
            sec(s, "customer.access.failed", req, { phone: challenge.phone });
            const failure = recordPinFailure(s, customer, req, challenge.phone);
            return json(
              res,
              failure.locked ? 429 : 401,
              {
                error: failure.locked
                  ? "PIN sign-in is temporarily locked. Use a passkey or Google Authenticator, or try again later."
                  : generic,
                ...failure,
              },
              { "retry-after": String(failure.retryAfterSeconds || 1) },
            );
          }
          clearPinFailures(customer);
        } else {
          if (i.pin !== i.confirmPin) {
            return json(res, 400, { error: "PIN entries do not match." });
          }
          if (customer?.pinHash) {
            challenge.used = true;
            return json(res, 409, {
              error: "This account is already set up. Start again and sign in.",
            });
          }
          if (!customer) {
            customer = {
              id: randomUUID(),
              phone: challenge.phone,
              name: "Voucher customer",
              email: "",
              createdAt: clock().toISOString(),
            };
            s.customers.push(customer);
          }
          customer.pinHash = await argon2.hash(i.pin, { type: argon2.argon2id });
          customer.pinCreatedAt = clock().toISOString();
          log(s, "customer.pin.created", { customerId: customer.id });
        }
        if (claimable) {
          const activatedAt = clock();
          Object.assign(voucher, {
            customerId: customer.id,
            status: "active",
            activatedAt: activatedAt.toISOString(),
            expiresAt: new Date(
              activatedAt.getTime() + claimPlan.validityHours * 36e5,
            ).toISOString(),
          });
          enqueueRouterCommand(s, { action: "sync_voucher", targetId: voucher.id }, clock);
          voucher.routerSyncStatus = "pending";
          log(s, "voucher.resale_claimed", { voucherId: voucher.id, customerId: customer.id });
        }
        challenge.used = true;
        challenge.usedAt = clock().toISOString();
        sec(s, "customer.access.succeeded", req, { customerId: customer.id });
        return issueCustomerSession(s, customer.id, res, req);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/pin-reset/request") {
      const i = await body(req);
      return mutate(async (s) => {
        const ph = phone(i.phone),
          cutoff = new Date(clock().getTime() - 15 * 60_000),
          recent = s.securityEvents.filter(
            (event) =>
              event.type === "customer.pin_reset.requested" &&
              new Date(event.at) > cutoff &&
              (event.ip === ip(req) || event.meta?.phone === ph),
          );
        if (recent.length >= 3) {
          return json(res, 429, { error: "Too many reset requests. Try again in 15 minutes." });
        }
        sec(s, "customer.pin_reset.requested", req, { phone: ph });
        const customer = s.customers.find(
          (item) => item.phone === ph && item.status !== "suspended" && item.pinHash && item.email,
        );
        if (customer && email.configured()) {
          const token = secureToken(32);
          for (const challenge of s.pinResetChallenges) {
            if (challenge.customerId === customer.id && !challenge.used) challenge.used = true;
          }
          const challenge = {
            id: randomUUID(),
            customerId: customer.id,
            tokenHash: hashSecret(token, pepper),
            attempts: 0,
            used: false,
            createdAt: clock().toISOString(),
            expiresAt: new Date(clock().getTime() + 15 * 60_000).toISOString(),
          };
          s.pinResetChallenges.push(challenge);
          try {
            const sent = await email.sendPinReset({ customer, token });
            challenge.emailMessageId = sent.messageId;
            challenge.emailSentAt = clock().toISOString();
          } catch (error) {
            challenge.deliveryError = String(error.message || error).slice(0, 200);
            log(s, "customer.pin_reset.email_failed", { customerId: customer.id });
          }
        }
        return json(res, 202, {
          message:
            "If an eligible account matches that phone number, a reset link has been sent to its email address.",
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/pin-reset/confirm") {
      const i = await body(req);
      if (!/^\d{4}$/.test(String(i.pin || ""))) {
        return json(res, 400, { error: "PIN must contain exactly 4 numeric digits." });
      }
      if (i.pin !== i.confirmPin) {
        return json(res, 400, { error: "PIN entries do not match." });
      }
      return mutate(async (s) => {
        const challenge = s.pinResetChallenges.find(
            (item) =>
              !item.used &&
              matchesRotatingHash(String(i.token || ""), item.tokenHash, pepper, previousPepper),
          ),
          failures = s.securityEvents.filter(
            (event) =>
              event.type === "customer.pin_reset.failed" &&
              event.ip === ip(req) &&
              new Date(event.at) > new Date(clock().getTime() - 15 * 60_000),
          );
        if (failures.length >= 5) {
          return json(res, 429, { error: "Too many reset attempts. Try again in 15 minutes." });
        }
        if (!challenge || new Date(challenge.expiresAt) <= clock()) {
          sec(s, "customer.pin_reset.failed", req);
          return json(res, 401, { error: "This reset link is invalid or expired." });
        }
        const customer = s.customers.find((item) => item.id === challenge.customerId);
        if (!customer) {
          challenge.used = true;
          return json(res, 401, { error: "This reset link is invalid or expired." });
        }
        customer.pinHash = await argon2.hash(i.pin, { type: argon2.argon2id });
        customer.pinUpdatedAt = clock().toISOString();
        clearPinFailures(customer);
        challenge.used = true;
        challenge.usedAt = clock().toISOString();
        s.dashboardSessions = s.dashboardSessions.filter(
          (session) => session.customerId !== customer.id,
        );
        log(s, "customer.pin_reset.completed", { customerId: customer.id });
        queueSecurityAlert(
          s,
          {
            customerId: customer.id,
            kind: "pin_reset",
            subject: "Your NDAHI Connect PIN was reset",
            lines: [
              "Your account PIN was just reset using the email link.",
              "This also signed out every other device using your account.",
            ],
          },
          clock(),
        );
        return json(res, 200, {
          reset: true,
          message: "Your PIN has been reset. You can sign in now.",
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/setup/pin") {
      const i = await body(req);
      if (!/^\d{4}$/.test(String(i.pin || ""))) {
        return json(res, 400, { error: "PIN must contain exactly 4 numeric digits." });
      }
      if (i.pin !== i.confirmPin) {
        return json(res, 400, { error: "PIN entries do not match." });
      }
      return mutate(async (s) => {
        const c = s.customers.find((x) => x.phone === phone(i.phone)),
          voucher =
            c &&
            s.vouchers.find(
              (x) =>
                x.customerId === c.id &&
                safeEqual(x.code, normalizeActivationCode(i.code)) &&
                ["active", "exhausted", "expired"].includes(x.status),
            );
        if (!c || !voucher || c.pinHash) {
          sec(s, "customer.pin_setup.failed", req);
          return json(res, 401, { error: generic });
        }
        c.pinHash = await argon2.hash(i.pin, { type: argon2.argon2id });
        c.pinCreatedAt = clock().toISOString();
        log(s, "customer.pin.created", { customerId: c.id });
        return issueCustomerSession(s, c.id, res, req);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/login/pin") {
      const i = await body(req);
      return mutate(async (s) => {
        const ph = phone(i.phone),
          cutoff = new Date(clock().getTime() - 15 * 60_000),
          failures = s.securityEvents.filter(
            (event) =>
              event.type === "customer.pin.failed" &&
              new Date(event.at) > cutoff &&
              (event.ip === ip(req) || event.meta?.phone === ph),
          );
        if (failures.length >= 5) {
          sec(s, "customer.pin.throttled", req, { phone: ph });
          return json(res, 429, {
            error: "Too many incorrect PIN attempts. Try again in 15 minutes.",
          });
        }
        const c = s.customers.find((x) => x.phone === ph && x.status !== "suspended"),
          throttle = pinThrottle(c);
        if (throttle) {
          return json(
            res,
            429,
            {
              error: throttle.locked
                ? "PIN sign-in is temporarily locked. Use a passkey or Google Authenticator, or try again later."
                : "Wait briefly before trying the PIN again.",
              ...throttle,
            },
            { "retry-after": String(throttle.retryAfterSeconds) },
          );
        }
        if (c && !c.pinHash && c.totpSecret) {
          return json(res, 409, {
            error: "Use your existing authenticator to sign in.",
            authenticatorRequired: true,
          });
        }
        if (
          !c?.pinHash ||
          !/^\d{4}$/.test(String(i.pin || "")) ||
          !(await argon2.verify(c.pinHash, i.pin))
        ) {
          const failure = recordPinFailure(s, c, req, ph);
          return json(
            res,
            failure.locked ? 429 : 401,
            {
              error: failure.locked
                ? "PIN sign-in is temporarily locked. Use a passkey or Google Authenticator, or try again later."
                : generic,
              ...failure,
            },
            { "retry-after": String(failure.retryAfterSeconds || 1) },
          );
        }
        clearPinFailures(c);
        sec(s, "customer.pin_login.succeeded", req, { customerId: c.id });
        return issueCustomerSession(s, c.id, res, req);
      }, { res, scope: customerScope(i.phone) });
    }
    if (req.method === "POST" && url.pathname === "/api/account/login/request-authenticator") {
      const i = await body(req);
      return mutate(async (s) => {
        const ph = phone(i.phone),
          recent = s.otpChallenges.filter(
            (x) =>
              (x.phone === ph || x.ip === ip(req)) &&
              new Date(x.createdAt) > new Date(clock() - 9e5),
          );
        if (recent.length >= 5) {
          sec(s, "otp.throttled", req);
          return json(res, 429, {
            error: "Too many OTP requests. Try again later.",
          });
        }
        const c = s.customers.find((x) => x.phone === ph);
        if (!c?.totpSecret || c.status === "suspended") {
          sec(s, "dashboard.login.failed", req);
          return json(res, 401, { error: generic });
        }
        const ch = {
          id: randomUUID(),
          customerId: c.id,
          phone: ph,
          ip: ip(req),
          attempts: 0,
          used: false,
          createdAt: clock().toISOString(),
          expiresAt: new Date(clock().getTime() + 3e5).toISOString(),
        };
        s.otpChallenges.push(ch);
        const out = {
          challengeId: ch.id,
          enrollmentRequired: false,
          message: "Enter the six-digit code from your authenticator app.",
        };
        return json(res, 200, out);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/login/verify-authenticator") {
      const i = await body(req);
      return mutate(async (s) => {
        const ch = s.otpChallenges.find((x) => x.id === i.challengeId);
        if (!ch || ch.used || new Date(ch.expiresAt) <= clock() || ch.attempts >= 5) {
          return json(res, 401, {
            error: "The verification code is invalid or expired.",
          });
        }
        const customer = s.customers.find((x) => x.id === ch.customerId),
          recoveryInput = i.recoveryCode ? normalizeRecoveryCode(i.recoveryCode) : null,
          matchedRecoveryCode =
            recoveryInput &&
            customer?.recoveryCodes?.find(
              (code) => !code.usedAt && safeEqual(code.hash, hashSecret(recoveryInput, pepper)),
            ),
          otpValid =
            !recoveryInput &&
            customer?.totpSecret &&
            verifyTotp(customer.totpSecret, i.otp, clock().getTime());
        if (!customer?.totpSecret || !(otpValid || matchedRecoveryCode)) {
          ch.attempts++;
          sec(s, "otp.failed", req);
          return json(res, 401, {
            error: "The verification code is invalid or expired.",
            attemptsRemaining: Math.max(0, 5 - ch.attempts),
          });
        }
        ch.used = true;
        if (matchedRecoveryCode) {
          matchedRecoveryCode.usedAt = clock().toISOString();
          sec(s, "customer.recovery_code_login.succeeded", req, {
            customerId: customer.id,
            severity: "high",
          });
          queueSecurityAlert(
            s,
            {
              customerId: customer.id,
              kind: "recovery_code_used",
              subject: "A recovery code was used to sign in to your NDAHI Connect account",
              lines: [
                "A recovery code was used to sign in to your account, bypassing your authenticator app.",
                "If this wasn't you, sign in immediately, remove any unfamiliar passkeys, and regenerate your recovery codes.",
              ],
            },
            clock(),
          );
        } else {
          sec(s, "customer.otp_login.succeeded", req, { customerId: customer.id });
        }
        return issueCustomerSession(s, customer.id, res, req);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkey/options") {
      const i = await body(req);
      return mutate(async (s) => {
        const c = s.customers.find((x) => x.phone === phone(i.phone) && x.status !== "suspended");
        if (!c?.passkeys?.length) {
          return json(res, 404, {
            error: "No passkey is enrolled for this customer account.",
          });
        }
        const options = await generateAuthenticationOptions({
          rpID: customerRpID,
          userVerification: "required",
          allowCredentials: c.passkeys.map((key) => ({
            id: key.id,
            transports: key.transports,
          })),
        });
        const challenge = {
          id: randomUUID(),
          customerId: c.id,
          challenge: options.challenge,
          type: "authentication",
          expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
        };
        s.customerPasskeyChallenges.push(challenge);
        return json(res, 200, { challengeId: challenge.id, options });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkey/verify") {
      const i = await body(req);
      return mutate(async (s) => {
        const challenge = s.customerPasskeyChallenges.find(
            (x) => x.id === i.challengeId && x.type === "authentication",
          ),
          c =
            challenge &&
            s.customers.find((x) => x.id === challenge.customerId && x.status !== "suspended"),
          key = c?.passkeys?.find((x) => x.id === i.response?.id);
        if (!challenge || !c || !key || new Date(challenge.expiresAt) <= clock()) {
          return json(res, 401, { error: "Passkey challenge is invalid or expired." });
        }
        const verification = await verifyAuthenticationResponse({
          response: i.response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: customerOrigin,
          expectedRPID: customerRpID,
          requireUserVerification: true,
          credential: {
            id: key.id,
            publicKey: Buffer.from(key.publicKey, "base64url"),
            counter: key.counter,
            transports: key.transports,
          },
        });
        if (!verification.verified) {
          return json(res, 401, { error: "Passkey verification failed." });
        }
        key.counter = verification.authenticationInfo.newCounter;
        s.customerPasskeyChallenges = s.customerPasskeyChallenges.filter(
          (x) => x.id !== challenge.id,
        );
        sec(s, "customer.passkey_login.succeeded", req, { customerId: c.id });
        return issueCustomerSession(s, c.id, res, req);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/logout") {
      return mutate(async (s) => {
        const token = cookies(req).customer_session;
        if (token) {
          s.dashboardSessions = s.dashboardSessions.filter(
            (x) => !matchesRotatingHash(token, x.tokenHash, customerSecret, previousCustomerSecret),
          );
        }
        return json(
          res,
          200,
          { loggedOut: true },
          {
            "set-cookie": cookie("customer_session", "", 0, secureCookies),
          },
        );
      });
    }
    return NOT_HANDLED;
  };
}
