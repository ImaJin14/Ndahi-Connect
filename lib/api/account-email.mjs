import { randomUUID } from "node:crypto";
import { body, json, ip } from "./http.mjs";
import { sec } from "./state.mjs";
import { hashSecret, safeEqual } from "../security.mjs";
import { normalizeEmail, validEmail, linkedEmail } from "../email-state.mjs";
import {
  profileProofOptions,
  verifyProfileProof,
  profileCredentialVersion,
} from "../profile-proof.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { emailConfirmationCode } from "../transactional-email.mjs";
import {
  profileEdit,
  profileVersion,
  profileOperation,
  recordProfileOperation,
  profilePhoneConflict,
  applyProfileFields,
  revokeProfileAuthority,
} from "../profile-edit.mjs";
import { NOT_HANDLED } from "./routing.mjs";

export function createAccountEmailRoutes({
  mutate,
  auth,
  clock,
  email,
  pepper,
  previousPepper,
  issueCustomerSession,
  customerRpID,
  customerOrigin,
  pinThrottle,
  recordPinFailure,
  clearPinFailures,
}) {
  return async (req, res, url) => {
    if (
      req.method !== "POST" ||
      ![
        "/api/account/profile",
        "/api/account/profile/options",
        "/api/account/profile/email",
        "/api/account/profile/email/options",
        "/api/account/profile/email/confirm",
      ].includes(url.pathname)
    )
      return NOT_HANDLED;
    const input = await body(req);
    if (!input || typeof input !== "object" || Array.isArray(input))
      return json(res, 400, { error: "Enter valid profile details." });
    let address = normalizeEmail(input.email);
    const combined =
      url.pathname === "/api/account/profile" ||
      url.pathname === "/api/account/profile/options";
    if (url.pathname.endsWith("/confirm")) {
      return mutate(
        (s) => {
          const a = auth(req, s, "dashboardSessions"),
            c = a && s.customers.find((c) => c.id === a.customerId),
            p = c?.pendingEmail;
          if (!c) return json(res, 401, { error: "Customer session expired." });
          if (c.status === "suspended" || c.suspended)
            return json(res, 403, { error: "This account is suspended." });
          if (
            !p ||
            p.sessionId !== a.id ||
            p.originalEmail !== (c.email || "") ||
            !(Date.parse(p.expiresAt) > +clock()) ||
            p.attempts >= 5
          ) {
            return json(res, 400, {
              error:
                "This email confirmation expired. Request a new code from this browser.",
            });
          }
          if (
            p.profileChange &&
            (p.profileChange.originalVersion !== profileVersion(c) ||
              p.profileChange.credentialVersion !== profileCredentialVersion(c))
          ) {
            return json(res, 409, {
              error:
                "Your profile or credentials changed. Request a new confirmation before saving.",
            });
          }
          p.attempts++;
          const code = String(input.code || "").trim();
          if (
            !/^\d{6}$/.test(code) ||
            !(
              safeEqual(p.codeHash, hashSecret(code, pepper)) ||
              (previousPepper &&
                safeEqual(p.codeHash, hashSecret(code, previousPepper)))
            )
          ) {
            return json(res, 400, {
              error: "The email confirmation code is invalid.",
              attemptsRemaining: 5 - p.attempts,
            });
          }
          if (
            p.profileChange &&
            profilePhoneConflict(s, c, p.profileChange.phone)
          )
            return json(res, 409, {
              error:
                "That number cannot be used for this account. Request a new profile change.",
            });
          const oldPhone = c.phone;
          const previousEmail = linkedEmail(c);
          if (previousEmail && previousEmail !== p.email)
            queueSecurityAlert(
              s,
              {
                customerId: c.id,
                kind: "email_replaced",
                recipient: previousEmail,
                subject: "Your NDAHI Connect account email changed",
                lines: [
                  "Your linked account email was replaced after credential and mailbox verification.",
                  "If you did not make this change, contact NDAHI support immediately.",
                ],
              },
              clock(),
            );
          if (p.profileChange) {
            applyProfileFields(s, c, p.profileChange, req, clock());
            recordProfileOperation(
              c,
              { operationId: p.profileChange.operationId },
              { fingerprint: p.profileChange.fingerprint },
              "applied",
              clock(),
            );
          }
          c.email = p.email;
          c.emailVerifiedAt = clock().toISOString();
          c.emailVerificationRequired = false;
          delete c.pendingEmail;
          c.welcomeEmail ??= {
            status: "pending",
            attempts: 0,
            name: c.name || "Customer",
          };
          const voucherIds = new Set(
            s.vouchers.filter((v) => v.customerId === c.id).map((v) => v.id),
          );
          for (const collection of [
            "pinResetChallenges",
            "customerPasskeyChallenges",
            "customerMfaChallenges",
            "otpChallenges",
            "customerAccessChallenges",
          ]) {
            s[collection] = s[collection].filter(
              (ch) =>
                ch.customerId !== c.id &&
                ch.phone !== c.phone &&
                ch.phone !== oldPhone &&
                !voucherIds.has(ch.voucherId),
            );
          }
          s.dashboardSessions = s.dashboardSessions.filter(
            (session) => session.customerId !== c.id,
          );
          sec(s, "customer.email_linked", req, { customerId: c.id });
          queueSecurityAlert(
            s,
            {
              customerId: c.id,
              kind: "email_linked",
              subject: "Your NDAHI Connect email is linked",
              lines: [
                "This address is now linked to your NDAHI Connect account for receipts, account notifications and PIN recovery.",
                "App feature updates continue automatically whether or not you have linked an email. Other portal sessions were signed out.",
              ],
            },
            clock(),
          );
          return issueCustomerSession(s, c.id, res, req);
        },
        { res },
      );
    }
    const job = await mutate(
      async (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((c) => c.id === a.customerId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.status === "suspended" || c.suspended)
          return json(res, 403, { error: "This account is suspended." });
        let edit,
          proofType = "email_link",
          proofTarget = address;
        if (combined) {
          if (input.action === "cancel") {
            if (c.pendingEmail?.profileChange?.operationId) {
              const operation = c.profileOperations?.find(
                (op) => op.id === c.pendingEmail.profileChange.operationId,
              );
              if (operation) operation.status = "cancelled";
            }
            delete c.pendingEmail;
            return json(res, 200, { cancelled: true });
          }
          edit = profileEdit(c, input);
          if (edit.status) return json(res, edit.status, { error: edit.error });
          if (
            input.operationId !== undefined &&
            !/^[a-f0-9]{32}$/.test(input.operationId)
          )
            return json(res, 400, { error: "Choose a valid profile request." });
          const previous =
            input.operationId &&
            profileOperation(c, input.operationId, edit.fingerprint, clock());
          if (previous)
            return json(
              res,
              previous.status,
              previous.body || { error: previous.error },
            );
          if (
            input.expectedVersion !== undefined &&
            input.expectedVersion !== profileVersion(c)
          )
            return json(res, 409, {
              code: "PROFILE_CHANGED",
              error:
                "Your profile changed in another session. Reload it before saving.",
            });
          if (edit.phoneChanged && profilePhoneConflict(s, c, edit.phone))
            return json(res, 409, {
              error:
                "That number cannot be used for this account. Choose another number or contact support.",
            });
          address = edit.email;
          proofType = "profile_edit";
          proofTarget = edit.fingerprint;
          if (!edit.emailChanged && !edit.phoneChanged) {
            if (url.pathname.endsWith("/options"))
              return json(res, 400, {
                error: "No sensitive change needs passkey verification.",
              });
            if (c.pendingEmail?.profileChange) {
              const operation = c.profileOperations?.find(
                (op) => op.id === c.pendingEmail.profileChange.operationId,
              );
              if (operation) operation.status = "cancelled";
              delete c.pendingEmail;
            }
            c.name = edit.name;
            recordProfileOperation(c, input, edit, "applied", clock());
            sec(s, "customer.profile_changed", req, { customerId: c.id });
            return json(res, 200, {
              profileSaved: true,
              operationId: input.operationId,
              profileVersion: profileVersion(c),
            });
          }
        }
        const newMailbox = !combined || Boolean(edit.emailChanged && address);
        if (newMailbox && !validEmail(address))
          return json(res, 400, { error: "Enter a valid email address." });
        if (!combined && address === c.email && c.emailVerifiedAt)
          return json(res, 409, { error: "This email is already linked." });
        const failures = s.securityEvents.filter(
          (e) =>
            e.type === "customer.email_link.failed" &&
            Date.parse(e.meta?.attemptedAt || e.at) > +clock() - 900000 &&
            (e.meta?.customerId === c.id || e.ip === ip(req)),
        );
        if (failures.length >= 5)
          return json(res, 429, {
            error: "Too many verification attempts. Try again in 15 minutes.",
          });
        if (url.pathname.endsWith("/options")) {
          if (!c.passkeys?.length)
            return json(res, 400, {
              error: "Use your current PIN to link an email.",
            });
          return json(
            res,
            200,
            await profileProofOptions({
              s,
              customer: c,
              session: a,
              type: proofType,
              target: proofTarget,
              clock,
              rpID: customerRpID,
            }),
          );
        }
        if (
          newMailbox &&
          (!email.configured() || typeof email.sendVerification !== "function")
        )
          return json(res, 503, {
            error:
              "Email linking is temporarily unavailable. Your account and purchases remain available.",
          });
        const requests = s.securityEvents.filter(
          (e) =>
            e.type === "customer.email_link.requested" &&
            e.meta?.customerId === c.id &&
            Date.parse(e.meta.attemptedAt) > +clock() - 3600000,
        );
        if (
          newMailbox &&
          (requests.length >= 5 ||
            Date.parse(c.pendingEmail?.requestedAt) > +clock() - 60000)
        )
          return json(res, 429, {
            error: "Please wait before requesting another email code.",
          });
        const proof = await verifyProfileProof({
          s,
          customer: c,
          session: a,
          input,
          type: proofType,
          target: proofTarget,
          clock,
          rpID: customerRpID,
          origin: customerOrigin,
          pinThrottle,
        });
        if (proof.throttle)
          return json(res, 429, {
            error: "PIN verification is temporarily locked. Try again later.",
            ...proof.throttle,
          });
        if (!proof.verified) {
          sec(s, "customer.email_link.failed", req, {
            customerId: c.id,
            attemptedAt: clock().toISOString(),
          });
          return json(res, 401, {
            code: "VERIFICATION_FAILED",
            error: combined
              ? "Could not verify this profile change. Use your current PIN or passkey."
              : "Could not verify this email change. Use your current PIN or passkey.",
            ...recordPinFailure(s, c, req, c.phone),
          });
        }
        clearPinFailures(c);
        if (combined && !newMailbox) {
          const removing = edit.emailChanged && !address,
            previousEmail = linkedEmail(c);
          if (removing) {
            if (previousEmail)
              queueSecurityAlert(
                s,
                {
                  customerId: c.id,
                  kind: "email_removed",
                  recipient: previousEmail,
                  subject: "Your NDAHI Connect account email was removed",
                  lines: [
                    "Your account email and email PIN recovery were removed after credential verification. Contact support if this was not you.",
                  ],
                },
                clock(),
              );
            c.email = "";
            delete c.emailVerifiedAt;
            c.emailVerificationRequired = true;
          }
          const oldPhone = applyProfileFields(s, c, edit, req, clock());
          delete c.pendingEmail;
          recordProfileOperation(c, input, edit, "applied", clock());
          revokeProfileAuthority(s, c, oldPhone);
          return issueCustomerSession(s, c.id, res, req);
        }
        const id = randomUUID();
        const code = emailConfirmationCode(
          c.id,
          { id, email: address, sessionId: a.id },
          pepper,
        );
        const previousOperation = c.profileOperations?.find(
          (op) => op.id === c.pendingEmail?.profileChange?.operationId,
        );
        if (previousOperation) previousOperation.status = "cancelled";
        c.pendingEmail = {
          id,
          email: address,
          originalEmail: c.email || "",
          sessionId: a.id,
          codeHash: hashSecret(code, pepper),
          attempts: 0,
          requestedAt: clock().toISOString(),
          expiresAt: new Date(+clock() + 600000).toISOString(),
          status: "pending",
          delivery: { status: "pending", attempts: 0 },
        };
        if (combined) {
          c.pendingEmail.profileChange = {
            name: edit.name,
            phone: edit.phone,
            originalVersion: profileVersion(c),
            credentialVersion: profileCredentialVersion(c),
            operationId: input.operationId,
            fingerprint: edit.fingerprint,
          };
          recordProfileOperation(c, input, edit, "pending", clock());
        }
        sec(s, "customer.email_link.requested", req, {
          customerId: c.id,
          attemptedAt: clock().toISOString(),
        });
        return {
          customerId: c.id,
          id,
          email: address,
          expiresAt: c.pendingEmail.expiresAt,
        };
      },
      { res },
    );
    if (!job) return;
    return json(res, 202, {
      verificationPending: true,
      email: job.email,
      expiresAt: job.expiresAt,
      delivery: "pending",
    });
  };
}
