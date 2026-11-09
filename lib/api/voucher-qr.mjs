import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { body, json } from "./http.mjs";
import { sec, purchasedPlan } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { secureToken, hashSecret, safeEqual } from "../security.mjs";
import {
  findQrVoucher,
  voucherQrUrl,
  qrIdentityValid,
  qrGrantTarget,
} from "../voucher-qr.mjs";
import { profileProofOptions, verifyProfileProof } from "../profile-proof.mjs";
import { pairingVoucher } from "../wifi-pairing.mjs";
const root = "/api/account/qr-connect";

export function createVoucherQrRoutes(context) {
  const {
    mutate,
    auth,
    clock,
    pepper,
    coverage,
    pinThrottle,
    recordPinFailure,
    clearPinFailures,
    customerRpID,
    customerOrigin,
    issueCustomerSession,
  } = context;
  const denied = (
    res,
    status = 401,
    code = "QR_INVALID",
    error = "This QR is invalid or was replaced. Open the latest voucher from your account.",
  ) => json(res, status, { code, error });
  function eligible(s, v, res) {
    if (!v) {
      denied(res);
      return null;
    }
    const c = s.customers.find((c) => c.id === v.customerId);
    if (!c || v.status === "available") {
      denied(
        res,
        409,
        "VOUCHER_NOT_ASSIGNED",
        "This voucher needs to be claimed first. Use the voucher activation page.",
      );
      return null;
    }
    if (c.status === "suspended" || c.suspended) {
      denied(
        res,
        403,
        "ACCOUNT_UNAVAILABLE",
        "This account is unavailable. Contact support.",
      );
      return null;
    }
    if (!c.pinHash && !(c.passkeys && c.passkeys.length)) {
      denied(
        res,
        409,
        "ACCOUNT_SETUP_REQUIRED",
        "Finish setting up your account PIN before using this QR. Open your saved voucher or sign in for setup.",
      );
      return null;
    }
    if (v.accessMode === "home" || v.accessTransitionId) {
      denied(
        res,
        409,
        "HOME_ACCESS_SELECTED",
        "This bundle uses a Home router. Manage it from your account.",
      );
      return null;
    }
    if (
      v.status !== "active" ||
      !(Date.parse(v.expiresAt) > +clock()) ||
      (v.quotaBytes !== null && !(v.quotaBytes > (v.usedBytes || 0)))
    ) {
      denied(
        res,
        409,
        "BUNDLE_INACTIVE",
        "You do not have an active bundle on this voucher. Subscribe from your account to get connected.",
      );
      return null;
    }
    if (!pairingVoucher(s, { customerId: c.id, voucherId: v.id }, clock())) {
      denied(
        res,
        409,
        "BUNDLE_NOT_READY",
        "This bundle is still being prepared or needs a payment check. Try again shortly; do not pay again.",
      );
      return null;
    }
    return c;
  }
  function sameAccount(req, s, customer, res) {
    const session = auth(req, s, "dashboardSessions");
    if (session && session.customerId !== customer.id) {
      denied(
        res,
        409,
        "DIFFERENT_ACCOUNT",
        "You are signed into a different account. Sign out explicitly before using this QR.",
      );
      return false;
    }
    return true;
  }
  return async (req, res, url) => {
    if (
      req.method !== "POST" ||
      ![
        root + "/begin",
        root + "/options",
        root + "/verify",
        root + "/rotate",
      ].includes(url.pathname)
    )
      return NOT_HANDLED;
    const input = await body(req);
    return mutate(
      async (s) => {
        if (url.pathname.endsWith("/rotate")) {
          const session = auth(req, s, "dashboardSessions"),
            c = session && s.customers.find((c) => c.id === session.customerId);
          const v =
            c &&
            s.vouchers.find(
              (v) => v.id === input.voucherId && v.customerId === c.id,
            );
          if (!v || !c || c.status === "suspended" || c.suspended)
            return denied(res, 404, "VOUCHER_NOT_FOUND", "Voucher not found.");
          const proof = await verifyProfileProof({
            s,
            customer: c,
            session,
            input,
            type: "voucher_qr_rotate",
            target: v.id,
            clock,
            rpID: customerRpID,
            origin: customerOrigin,
            pinThrottle,
          });
          if (proof.throttle)
            return json(res, 429, {
              code: "PIN_THROTTLED",
              error: "Wait before trying again.",
              ...proof.throttle,
            });
          if (!proof.verified) {
            const failure = recordPinFailure(s, c, req, c.phone);
            return denied(
              res,
              failure.locked ? 429 : 401,
              "VERIFICATION_FAILED",
              "Could not verify account ownership.",
            );
          }
          clearPinFailures(c);
          const qrUrl = voucherQrUrl(v, c, customerOrigin, { rotate: true });
          sec(s, "customer.voucher_qr.rotated", req, {
            customerId: c.id,
            voucherId: v.id,
          });
          return json(res, 200, { qrUrl });
        }
        if (url.pathname.endsWith("/begin")) {
          const v = findQrVoucher(s, input),
            c = eligible(s, v, res);
          if (!c || !sameAccount(req, s, c, res)) return;
          if (input.qr && !qrIdentityValid(v, c)) return denied(res);
          // Legacy printed voucher links resolve here, but grant no session or connection.
          voucherQrUrl(v, c, customerOrigin);
          if (
            s.customerAccessChallenges.filter(
              (ch) =>
                ch.type === "qr_connect_context" &&
                ch.customerId === c.id &&
                Date.parse(ch.expiresAt) > +clock(),
            ).length >= 30
          )
            return denied(
              res,
              429,
              "QR_RATE_LIMIT",
              "Too many scan attempts. Wait a few minutes before trying again.",
            );
          const token = secureToken(32),
            at = clock(),
            target = qrGrantTarget(input);
          s.customerAccessChallenges.push({
            id: randomUUID(),
            type: "qr_connect_context",
            tokenHash: hashSecret(token, pepper),
            customerId: c.id,
            voucherId: v.id,
            qrHash: hashSecret(v.qrConnectToken, pepper),
            target,
            used: false,
            createdAt: at.toISOString(),
            expiresAt: new Date(+at + 300000).toISOString(),
          });
          return json(res, 200, {
            context: token,
            planName: purchasedPlan(s, v)?.name || "Active bundle",
            passkeyAvailable: Boolean(c.passkeys?.length),
            expiresIn: 300,
          });
        }
        const row = s.customerAccessChallenges.find(
          (ch) =>
            ch.type === "qr_connect_context" &&
            !ch.used &&
            safeEqual(
              ch.tokenHash,
              hashSecret(String(input.context || ""), pepper),
            ) &&
            Date.parse(ch.expiresAt) > +clock(),
        );
        if (!row)
          return denied(
            res,
            401,
            "QR_CONTEXT_EXPIRED",
            "Scan the QR again. This connection attempt expired or was already used.",
          );
        const v = s.vouchers.find((v) => v.id === row.voucherId),
          c = eligible(s, v, res);
        if (!c || !sameAccount(req, s, c, res)) return;
        if (
          !qrIdentityValid(v, c) ||
          !safeEqual(row.qrHash, hashSecret(v.qrConnectToken, pepper))
        )
          return denied(res);
        if (row.target !== qrGrantTarget(input))
          return denied(
            res,
            409,
            "DEVICE_CHANGED",
            "Device details changed. Start a new connection attempt.",
          );
        if (
          coverage?.access(req).allowed === false ||
          !/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(
            String(input.mac || "").toUpperCase(),
          ) ||
          isIP(String(input.address || "")) !== 4 ||
          !/^[a-f0-9]{32,64}$/.test(String(input.key || ""))
        )
          return denied(
            res,
            403,
            "WIFI_REQUIRED",
            "Join NDAHI Wi-Fi and open Wi-Fi sign-in on this device before authorizing connection.",
          );
        if (url.pathname.endsWith("/options")) {
          if (!c.passkeys?.length)
            return denied(
              res,
              400,
              "PIN_REQUIRED",
              "Use your account PIN to connect.",
            );
          return json(
            res,
            200,
            await profileProofOptions({
              s,
              customer: c,
              session: row,
              type: "voucher_qr_connect",
              target: row.target,
              clock,
              rpID: customerRpID,
            }),
          );
        }
        const proof = await verifyProfileProof({
          s,
          customer: c,
          session: row,
          input,
          type: "voucher_qr_connect",
          target: row.target,
          clock,
          rpID: customerRpID,
          origin: customerOrigin,
          pinThrottle,
        });
        if (proof.throttle)
          return json(res, 429, {
            code: "PIN_THROTTLED",
            error: "Wait before trying your PIN again.",
            ...proof.throttle,
          });
        if (!proof.verified) {
          const failure = recordPinFailure(s, c, req, c.phone);
          return json(res, failure.locked ? 429 : 401, {
            code: "VERIFICATION_FAILED",
            error: "Could not verify your PIN or passkey.",
            ...failure,
          });
        }
        clearPinFailures(c);
        row.used = true;
        const token = secureToken(32);
        s.customerAccessChallenges.push({
          id: randomUUID(),
          type: "qr_connect_grant",
          tokenHash: hashSecret(token, pepper),
          customerId: c.id,
          voucherId: v.id,
          qrHash: row.qrHash,
          target: row.target,
          used: false,
          createdAt: clock().toISOString(),
          expiresAt: new Date(+clock() + 90000).toISOString(),
        });
        sec(s, "customer.voucher_qr.verified", req, {
          customerId: c.id,
          voucherId: v.id,
        });
        return issueCustomerSession(s, c.id, res, req, {
          method: proof.method,
          details: { qrAuthorization: token },
        });
      },
      { res },
    );
  };
}
