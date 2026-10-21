import { authenticatorRetired } from "../authentication-migration.mjs";
import { createCustomerMigrationRoutes } from "./authentication-migration.mjs";
import { profileProofOptions, verifyProfileProof } from "../profile-proof.mjs";
import { body, json, ip } from "./http.mjs";
import { phone, phoneOk, findPlan, sec } from "./state.mjs";
import { verifyTotp } from "../security.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { voucherPdf, voucherFilename } from "../voucher-pdf.mjs";
import { NOT_HANDLED } from "./routing.mjs";

export function createAccountToolsRoutes(context) {
  const { mutate, auth, clock, refreshCustomerSession, issueCustomerSession, pinThrottle, recordPinFailure, clearPinFailures, customerRpID, customerOrigin } = context;
  const migration = createCustomerMigrationRoutes(context);
  return async (req, res, url) => {
    if (await migration(req, res, url) !== NOT_HANDLED) return;
    if (req.method === "GET" && /^\/api\/account\/vouchers\/[^/]+\/download$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/").at(-2));
      const snapshot = await mutate((s) => {
        const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((c) => c.id === a.customerId);
        if (!c) { json(res, 401, { error: "Customer session expired." }); return null; }
        const voucher = s.vouchers.find((v) => v.id === id && v.customerId === c.id);
        if (!voucher) { json(res, 404, { error: "Voucher not found." }); return null; }
        refreshCustomerSession(req, res, a);
        return structuredClone({ voucher, phone: c.phone, plan: s.payments.find((p) => p.id === voucher.paymentId)?.planSnapshot || findPlan(s, voucher.planId) });
      }, { res });
      if (!snapshot) return;
      const pdf = await voucherPdf(snapshot);
      res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store", "content-length": pdf.length,
        "content-disposition": `attachment; filename="${voucherFilename(snapshot.voucher)}"` });
      return res.end(pdf);
    }
    if (req.method === "POST" && url.pathname === "/api/account/profile/name") {
      const input = await body(req), name = String(input.name || "").trim().replace(/\s+/g, " ");
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((c) => c.id === a.customerId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
        if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return json(res, 400, { error: "Enter a name between 1 and 100 characters." });
        c.name = name;
        sec(s, "customer.name_changed", req, { customerId: c.id });
        return json(res, 200, { name });
      }, { res });
    }
    if (req.method !== "POST" || !["/api/account/profile/phone", "/api/account/profile/phone/options"].includes(url.pathname)) return NOT_HANDLED;
    const input = await body(req), newPhone = phone(input.phone);
    return mutate(async (s) => {
      const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((c) => c.id === a.customerId);
      if (!c) return json(res, 401, { error: "Customer session expired." });
      if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
      if (!phoneOk(newPhone)) return json(res, 400, { error: "Enter a valid Cameroon phone number." });
      if (newPhone === c.phone) return json(res, 400, { error: "Enter a different account number." });
      const failures = s.securityEvents.filter((e) => e.type === "customer.phone_change.failed" &&
        Date.parse(e.meta?.attemptedAt || e.at) > +clock() - 900000 && (e.meta?.customerId === c.id || e.ip === ip(req)));
      if (failures.length >= 5) return json(res, 429, { error: "Too many verification attempts. Try again in 15 minutes." });
      if (url.pathname.endsWith("/options")) {
        if (!c.passkeys?.length) return json(res, 400, { error: "Use your current PIN to confirm this change." });
        return json(res, 200, await profileProofOptions({ s, customer: c, session: a, type: "phone_change", target: newPhone, clock, rpID: customerRpID }));
      }
      const proof = await verifyProfileProof({ s, customer: c, session: a, input, type: "phone_change", target: newPhone,
        clock, rpID: customerRpID, origin: customerOrigin, pinThrottle });
      if (proof.throttle) return json(res, 429, { error: "PIN verification is temporarily locked. Try again later.", ...proof.throttle });
      const verified = proof.verified;
      if (!verified || (!authenticatorRetired(s) && c.totpSecret && !verifyTotp(c.totpSecret, input.otp, +clock()))) {
        sec(s, "customer.phone_change.failed", req, { customerId: c.id, attemptedAt: clock().toISOString() });
        const failure = recordPinFailure(s, c, req, c.phone);
        return json(res, 401, { code: "VERIFICATION_FAILED", error: "Could not verify this change. Check your credentials and authenticator code.", ...failure });
      }
      if (s.customers.some((other) => other.id !== c.id && other.phone === newPhone)) {
        return json(res, 409, { error: "That number cannot be used for this account. Choose another number or contact support." });
      }
      const oldPhone = c.phone, voucherIds = new Set(s.vouchers.filter((v) => v.customerId === c.id).map((v) => v.id));
      c.phone = newPhone;
      c.phoneVerified = false;
      c.phoneChangedAt = clock().toISOString();
      clearPinFailures(c);
      delete c.pendingEmail;
      s.dashboardSessions = s.dashboardSessions.filter((session) => session.customerId !== c.id);
      for (const collection of ["customerPasskeyChallenges", "customerMfaChallenges", "otpChallenges", "pinResetChallenges", "customerAccessChallenges"]) {
        s[collection] = s[collection].filter((ch) => ch.customerId !== c.id && ch.phone !== oldPhone && !voucherIds.has(ch.voucherId));
      }
      sec(s, "customer.phone_changed", req, { customerId: c.id, severity: "high" });
      queueSecurityAlert(s, { customerId: c.id, kind: "phone_changed", subject: "Your NDAHI Connect account number changed",
        lines: [`Your account number changed from ${oldPhone} to ${newPhone}.`, "Other portal sessions were signed out. Your bundles, vouchers and payment history stay with your account.",
          "If you did not make this change, contact NDAHI support immediately."] }, clock());
      return issueCustomerSession(s, c.id, res, req);
    }, { res });
  };
}
