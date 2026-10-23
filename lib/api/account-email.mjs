import { randomUUID } from "node:crypto";
import { body, json, ip } from "./http.mjs";
import { sec } from "./state.mjs";
import { hashSecret, safeEqual, otpCode } from "../security.mjs";
import { normalizeEmail, validEmail, linkedEmail } from "../email-state.mjs";
import { profileProofOptions, verifyProfileProof } from "../profile-proof.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { NOT_HANDLED } from "./routing.mjs";

export function createAccountEmailRoutes({ mutate, auth, clock, email, pepper, previousPepper, issueCustomerSession,
  customerRpID, customerOrigin, pinThrottle, recordPinFailure, clearPinFailures }) {
  return async (req, res, url) => {
    if (req.method !== "POST" || !["/api/account/profile/email", "/api/account/profile/email/options", "/api/account/profile/email/confirm"].includes(url.pathname)) return NOT_HANDLED;
    const input = await body(req), address = normalizeEmail(input.email);
    if (url.pathname.endsWith("/confirm")) {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((c) => c.id === a.customerId), p = c?.pendingEmail;
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
        if (!p || p.sessionId !== a.id || p.originalEmail !== (c.email || "") || !(Date.parse(p.expiresAt) > +clock()) || p.attempts >= 5) {
          return json(res, 400, { error: "This email confirmation expired. Request a new code from this browser." });
        }
        p.attempts++;
        const code = String(input.code || "").trim();
        if (!/^\d{6}$/.test(code) || !(safeEqual(p.codeHash, hashSecret(code, pepper)) ||
          (previousPepper && safeEqual(p.codeHash, hashSecret(code, previousPepper))))) {
          return json(res, 400, { error: "The email confirmation code is invalid.", attemptsRemaining: 5 - p.attempts });
        }
        const previousEmail = linkedEmail(c);
        if (previousEmail && previousEmail !== p.email) queueSecurityAlert(s, { customerId: c.id, kind: "email_replaced", recipient: previousEmail,
          subject: "Your NDAHI Connect account email changed", lines: ["Your linked account email was replaced after credential and mailbox verification.", "If you did not make this change, contact NDAHI support immediately."] }, clock());
        c.email = p.email;
        c.emailVerifiedAt = clock().toISOString();
        c.emailVerificationRequired = false;
        delete c.pendingEmail;
        const voucherIds = new Set(s.vouchers.filter((v) => v.customerId === c.id).map((v) => v.id));
        for (const collection of ["pinResetChallenges", "customerPasskeyChallenges", "customerMfaChallenges", "otpChallenges", "customerAccessChallenges"]) {
          s[collection] = s[collection].filter((ch) => ch.customerId !== c.id && ch.phone !== c.phone && !voucherIds.has(ch.voucherId));
        }
        s.dashboardSessions = s.dashboardSessions.filter((session) => session.customerId !== c.id);
        sec(s, "customer.email_linked", req, { customerId: c.id });
        queueSecurityAlert(s, { customerId: c.id, kind: "email_linked", subject: "Your NDAHI Connect email is linked",
          lines: ["This address is now linked to your NDAHI Connect account for receipts, account notifications and PIN recovery.",
            "App feature updates continue automatically whether or not you have linked an email. Other portal sessions were signed out."] }, clock());
        return issueCustomerSession(s, c.id, res, req);
      }, { res });
    }
    const job = await mutate(async (s) => {
      const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((c) => c.id === a.customerId);
      if (!c) return json(res, 401, { error: "Customer session expired." });
      if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
      if (!validEmail(address)) return json(res, 400, { error: "Enter a valid email address." });
      if (address === c.email && c.emailVerifiedAt) return json(res, 409, { error: "This email is already linked." });
      const failures = s.securityEvents.filter((e) => e.type === "customer.email_link.failed" &&
        Date.parse(e.meta?.attemptedAt || e.at) > +clock() - 900000 && (e.meta?.customerId === c.id || e.ip === ip(req)));
      if (failures.length >= 5) return json(res, 429, { error: "Too many verification attempts. Try again in 15 minutes." });
      if (url.pathname.endsWith("/options")) {
        if (!c.passkeys?.length) return json(res, 400, { error: "Use your current PIN to link an email." });
        return json(res, 200, await profileProofOptions({ s, customer: c, session: a, type: "email_link", target: address, clock, rpID: customerRpID }));
      }
      if (!email.configured() || typeof email.sendVerification !== "function") return json(res, 503, { error: "Email linking is temporarily unavailable. Your account and purchases remain available." });
      const requests = s.securityEvents.filter((e) => e.type === "customer.email_link.requested" && e.meta?.customerId === c.id && Date.parse(e.meta.attemptedAt) > +clock() - 3600000);
      if (requests.length >= 5 || Date.parse(c.pendingEmail?.requestedAt) > +clock() - 60000) return json(res, 429, { error: "Please wait before requesting another email code." });
      const proof = await verifyProfileProof({ s, customer: c, session: a, input, type: "email_link", target: address,
        clock, rpID: customerRpID, origin: customerOrigin, pinThrottle });
      if (proof.throttle) return json(res, 429, { error: "PIN verification is temporarily locked. Try again later.", ...proof.throttle });
      if (!proof.verified) {
        sec(s, "customer.email_link.failed", req, { customerId: c.id, attemptedAt: clock().toISOString() });
        return json(res, 401, { code: "VERIFICATION_FAILED", error: "Could not verify this email change. Use your current PIN or passkey.",
          ...recordPinFailure(s, c, req, c.phone) });
      }
      clearPinFailures(c);
      const code = otpCode(), id = randomUUID();
      c.pendingEmail = { id, email: address, originalEmail: c.email || "", sessionId: a.id, codeHash: hashSecret(code, pepper),
        attempts: 0, requestedAt: clock().toISOString(), expiresAt: new Date(+clock() + 600000).toISOString(), status: "sending" };
      sec(s, "customer.email_link.requested", req, { customerId: c.id, attemptedAt: clock().toISOString() });
      return { customerId: c.id, id, email: address, code, expiresAt: c.pendingEmail.expiresAt };
    }, { res });
    if (!job) return;
    let sent = false;
    try { await email.sendVerification({ to: job.email, code: job.code, requestId: job.id }); sent = true; }
    catch { /* Delivery can be uncertain. A code that arrives remains usable. */ }
    await mutate((s) => {
      const p = s.customers.find((c) => c.id === job.customerId)?.pendingEmail;
      if (p?.id === job.id) p.status = sent ? "sent" : "unconfirmed";
    });
    return json(res, 202, { verificationPending: true, email: job.email, expiresAt: job.expiresAt, delivery: sent ? "sent" : "unconfirmed" });
  };
}
