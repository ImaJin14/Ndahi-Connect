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
import { occupiedSlots, isPersonalUnlimited } from "../device-slots.mjs";
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
    // The bundle this scan connects (PhoneScanNoBundle, #412; owner 26 Nov): the
    // scanned voucher while it lasts; once it has ended, the same account's
    // current personal bundle, so a bundle bought after scanning connects this
    // device without a second scan. The PIN or passkey is still required, and
    // the grant stays tied to the scanned QR.
    let connect = v;
    if (!usable(v)) {
      const mine = s.vouchers.filter((x) => x.customerId === c.id && x.id !== v.id && usable(x));
      connect = mine.filter((x) => x.accessMode !== "home" && !x.accessTransitionId)
        .sort((a, b) => (Date.parse(b.activatedAt || b.createdAt) || 0) - (Date.parse(a.activatedAt || a.createdAt) || 0))[0];
      if (!connect && mine.length) {
        denied(res, 409, "HOME_ACCESS_SELECTED", "This bundle uses a Home router. Manage it from your account.");
        return null;
      }
      if (!connect) {
        // Shown before any PIN, as drawn (owner, 26 Nov): the first name and
        // initial, the masked number and when the last bundle ended.
        json(res, 409, {
          code: "BUNDLE_INACTIVE",
          error: "This account has no active bundle. Buy one, then this device can connect without scanning again.",
          account: { name: shortName(c.name), phone: maskedPhone(c.phone) },
          endedAt: lastEnded(s, c),
        });
        return null;
      }
    }
    if (!pairingVoucher(s, { customerId: c.id, voucherId: connect.id }, clock())) {
      denied(
        res,
        409,
        "BUNDLE_NOT_READY",
        "This bundle is still being prepared or needs a payment check. Try again shortly; do not pay again.",
      );
      return null;
    }
    return { c, v: connect };
  }
  const usable = (v) =>
    v.status === "active" &&
    Date.parse(v.expiresAt) > +clock() &&
    !(v.quotaBytes !== null && !(v.quotaBytes > (v.usedBytes || 0)));
  // "Amina N." and "+237 6•• •• 12 45": enough to recognise the account.
  const shortName = (name) => {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.` : parts[0] || null;
  };
  const maskedPhone = (phone) => {
    const d = String(phone || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, "");
    return d.length === 9 ? `+237 ${d[0]}•• •• ${d.slice(5, 7)} ${d.slice(7)}` : null;
  };
  const lastEnded = (s, c) => {
    const times = s.vouchers.filter((x) => x.customerId === c.id && x.accessMode !== "home")
      .map((x) => Date.parse(x.status === "exhausted" ? x.exhaustedAt || x.expiresAt : x.expiresAt))
      .filter((t) => Number.isFinite(t) && t <= +clock());
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  };
  function wifiReady(req, input) {
    return (
      coverage?.access(req).allowed !== false &&
      /^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(
        String(input.mac || "").toUpperCase(),
      ) &&
      isIP(String(input.address || "")) === 4 &&
      /^[a-f0-9]{32,64}$/.test(String(input.key || ""))
    );
  }
  // "Hi Amina" (#371): the first name only.
  const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || null;
  function sameAccount(req, s, customer, res) {
    const session = auth(req, s, "dashboardSessions");
    if (session && session.customerId !== customer.id) {
      // "Someone else is signed in here" (#371, canvas PhoneScanConnect
      // wrongAccount): who is signed in on this device and whose code was
      // scanned, as the short names "Kofi T." and "Amina N.".
      const current = s.customers.find((x) => x.id === session.customerId);
      json(res, 409, {
        code: "DIFFERENT_ACCOUNT",
        error: "You are signed into a different account. Sign out explicitly before using this QR.",
        account: { name: shortName(customer.name), first: firstName(customer.name) },
        current: { name: shortName(current?.name), first: firstName(current?.name) },
      });
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
          // The scanned voucher proves the QR; the bundle connected may be the
          // account's current one (#412).
          const scanned = findQrVoucher(s, input),
            found = eligible(s, scanned, res);
          if (!found) return;
          const { c, v } = found;
          if (!sameAccount(req, s, c, res)) return;
          if (input.qr && !qrIdentityValid(scanned, c)) return denied(res);
          // Legacy printed voucher links resolve here, but grant no session or connection.
          voucherQrUrl(scanned, c, customerOrigin);
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
            scannedVoucherId: scanned.id,
            qrHash: hashSecret(scanned.qrConnectToken, pepper),
            target,
            used: false,
            createdAt: at.toISOString(),
            expiresAt: new Date(+at + 300000).toISOString(),
          });
          // The card before the PIN (#371, canvas PhoneScanConnect): the first
          // name, then the bundle's end and what's left; a Personal Unlimited
          // bundle's device slots, an earlier bundle its data left.
          const left = v.quotaBytes === null || v.quotaBytes === undefined ? null : Math.max(0, v.quotaBytes - (v.usedBytes || 0));
          return json(res, 200, {
            context: token,
            planName: purchasedPlan(s, v)?.name || "Active bundle",
            account: { first: firstName(c.name) },
            bundle: { expiresAt: v.expiresAt || null, remainingBytes: left,
              ...(isPersonalUnlimited(v) ? { slots: { used: occupiedSlots(s, v).length, total: v.deviceSlots || v.deviceLimit || 1 } } : {}) },
            passkeyAvailable: Boolean(c.passkeys?.length),
            wifiReady: wifiReady(req, input),
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
        const scanned = s.vouchers.find((x) => x.id === (row.scannedVoucherId || row.voucherId)),
          found = eligible(s, scanned, res);
        if (!found) return;
        const { c, v } = found;
        if (!sameAccount(req, s, c, res)) return;
        // The bundle to connect is the one this attempt began with.
        if (v.id !== row.voucherId)
          return denied(res, 401, "QR_CONTEXT_EXPIRED", "Scan the QR again. This connection attempt expired or was already used.");
        if (
          !qrIdentityValid(scanned, c) ||
          !safeEqual(row.qrHash, hashSecret(scanned.qrConnectToken, pepper))
        )
          return denied(res);
        if (row.target !== qrGrantTarget(input))
          return denied(
            res,
            409,
            "DEVICE_CHANGED",
            "Device details changed. Start a new connection attempt.",
          );
        // #213: the account PIN or passkey is accepted before NDAHI Wi-Fi has
        // identified this device, so the customer is never stuck. It signs in to
        // the account only: no router connection grant is issued until the
        // network and the device are verified (below).
        const ready = wifiReady(req, input);
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
        // A verified context is consumed whatever happens next; a failed proof
        // leaves it usable, so the customer can retry the PIN or the passkey.
        row.used = true;
        if (!ready) {
          sec(s, "customer.voucher_qr.verified_without_wifi", req, {
            customerId: c.id,
            voucherId: v.id,
          });
          return issueCustomerSession(s, c.id, res, req, {
            method: proof.method,
            details: { wifiRequired: true },
          });
        }
        const token = secureToken(32);
        s.customerAccessChallenges.push({
          id: randomUUID(),
          type: "qr_connect_grant",
          tokenHash: hashSecret(token, pepper),
          customerId: c.id,
          voucherId: v.id,
          scannedVoucherId: scanned.id,
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
