import { customGiftTerms, accessTerms } from "../catalogue.mjs";
import { useByFrom } from "../voucher-use-by.mjs";
import { startsOnFirstConnection, revokeDeviceGrant } from "../device-slots.mjs";
import { isHomeWisp, startHomeWisp } from "../home-wisp.mjs";
import { issueSpeedSnapshot } from "../bundle-speed-policy.mjs";
import { voucherQrUrl } from "../voucher-qr.mjs";
import { printSelection, sendVoucherPrint } from "./voucher-print.mjs";
import { json } from "./http.mjs";
import { audit, findPlan, purchasedPlan, uniqueActivationCode, GB, view, phone, phoneOk } from "./state.mjs";
import { maskPhone, newReservation, reservationState } from "../reservations.mjs";
import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { mayReadVoucher, voucherAccess, voucherDetail, voucherOwnershipDetails, voucherListView } from "../voucher-access.mjs";
import { resellerRate, voucherResellerId, isResellerLedgerAccount } from "../reseller-ledger.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { queueVoucherEmail } from "../transactional-email.mjs";
import { linkedEmail } from "../email-state.mjs";
import QRCode from "qrcode";
// A batch to print or sell gets one reference (canvas: AdminVoucherPrint;
// owner, 25 Nov, #392): "B-", the day and month in Douala, then the batch's
// number that day, as in B-2511-01. It is a label for people, not an ID.
const DOUALA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Douala", year: "numeric", month: "2-digit", day: "2-digit" });
export function nextBatchReference(s, now) {
  const [year, month, day] = DOUALA_DAY.format(now).split("-"), today = `${year}-${month}-${day}`;
  const batches = new Set(s.vouchers.filter((v) => v.batchReference && Number.isFinite(Date.parse(v.createdAt)) &&
    DOUALA_DAY.format(new Date(v.createdAt)) === today).map((v) => v.batchReference));
  return `B-${day}${month}-${String(batches.size + 1).padStart(2, "0")}`;
}
export function createAdminVouchersRoutes({ deliverVoucherEmail, clock, customerOrigin }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    const access = voucherAccess(role, adminUser, administrator);
    if (req.method === "GET" && /^\/api\/admin\/vouchers\/[^/]+\/details$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[4]), voucher = s.vouchers.find((v) => v.id === id);
      if (!voucher || !mayReadVoucher(voucher, access)) return json(res, 404, { error: "Voucher not found." });
      if (url.searchParams.get("checkScope") === "1") return json(res, 200, { id: voucher.id, scopeKey: access.scopeKey });
      // ?full=1: the voucher detail page (#258) adds its history, router sync and,
      // for roles that may see codes, the code and its QR.
      if (url.searchParams.get("full") !== "1") return json(res, 200, voucherOwnershipDetails(s, voucher, access));
      const detail = voucherDetail(s, voucher, access);
      const qr = access.codes && voucher.code ? await QRCode.toDataURL(voucherQrUrl(voucher, s.customers.find((c) => c.id === voucher.customerId), customerOrigin), { margin: 0, width: 300 }).catch(() => null) : null;
      return json(res, 200, { ...voucherOwnershipDetails(s, voucher, access), detail: { ...detail, ...(qr ? { qr } : {}) } });
    }
    if (req.method === "POST" && ["/api/admin/vouchers/print-preview", "/api/admin/vouchers/print-pdf"].includes(url.pathname)) {
      if (!access.codes) return json(res, 403, { error: "Your role cannot print voucher codes." });
      const ids = printSelection(i);
      if (!ids) return json(res, 400, { error: "Choose 1–100 vouchers and a 58mm or 80mm print width." });
      const vouchers = ids.map(id => s.vouchers.find(v => v.id === id && mayReadVoucher(v, access)));
      if (vouchers.some(v => !v)) return json(res, 404, { error: "Voucher not found." });
      if (vouchers.some(v => !v.code || !["active", "available"].includes(v.status))) return json(res, 409, { error: "Only active or available vouchers can be printed." });
      audit(s, "voucher.printed", req, { voucherIds: ids, format: i.widthMm });
      return sendVoucherPrint(res, i, vouchers.map(voucher => ({ voucher: { ...voucher, qrRedemptionUrl: voucherQrUrl(voucher, s.customers.find(c => c.id === voucher.customerId), customerOrigin),
        // The slip's foot names the reseller a batch is for (#368).
        ...(voucher.assignedResellerId ? { resellerName: voucherListView(s, voucher, access).resellerName } : {}) }, plan: purchasedPlan(s, voucher) })), customerOrigin, url.pathname.endsWith("print-pdf"));
    }
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/print") {
      if (!access.codes) {
        return json(res, 403, { error: "This administrator role cannot view or print voucher codes." });
      }
      const voucherId = String(i.voucherId || "").trim();
      const customerId = String(i.customerId || "").trim();
      if (customerId && !access.contacts) {
        return json(res, 403, { error: "Your role does not permit customer voucher lookup." });
      }
      const v = voucherId
        ? s.vouchers.find((item) => item.id === voucherId)
        : customerId
          ? s.vouchers.find((item) => item.customerId === customerId && item.status === "active")
          : null;
      if (!v || !mayReadVoucher(v, access)) {
        return json(res, 404, {
          error: customerId && !voucherId
            ? "This customer does not have an active voucher to print."
            : "Voucher not found.",
        });
      }
      if (!["active", "available"].includes(v.status) || !v.code) {
        return json(res, 409, { error: "Only active or available vouchers can be printed." });
      }
      const plan = purchasedPlan(s, v) || findPlan(s, v.planId) || {
        id: v.planId || "bundle",
        name: v.planId || "NDAHI Bundle",
        price: Number.isFinite(Number(v.faceValue)) ? Number(v.faceValue) : 0,
        quotaGb: v.quotaBytes === null ? null : Math.round((Number(v.quotaBytes || 0) / GB) * 10) / 10,
        validityHours: 0,
        deviceLimit: v.deviceLimit || 1,
      };
      const redemptionUrl = voucherQrUrl(v, s.customers.find(c => c.id === v.customerId), customerOrigin);
      const qrCode = await QRCode.toDataURL(redemptionUrl, {
        width: 320, margin: 4, errorCorrectionLevel: "M",
      });
      const { customerId: _customerId, paymentId: _paymentId, ...printableView } = voucherListView(s, v, access);
      const item = { ...printableView, qrCode, qrConnection: redemptionUrl.includes("/voucher-connect.html") };
      audit(s, "voucher.printed", req, {
        voucherId: v.id,
        status: v.status,
        ...(customerId ? { customerId } : {}),
      });
      return json(res, 200, {
        voucher: item,
        vouchers: [item],
        plan,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/resend-email") {
      const voucher = s.vouchers.find((item) => item.id === i.voucherId);
      if (!voucher) return json(res, 404, { error: "Voucher not found." });
      // Resend receipt email (#344): a fresh delivery when the voucher belongs
      // to an account with a confirmed email; otherwise the reason (owner,
      // 26 Nov: an action that can't act says why).
      const customer = voucher.customerId && s.customers.find((c) => c.id === voucher.customerId);
      const reason = !customer ? "No receipt email yet: it's sent when the code is redeemed."
        : !linkedEmail(customer) ? "This customer has no confirmed email address, so there's no receipt to send." : null;
      if (!reason) {
        voucher.emailResends = Number(voucher.emailResends || 0) + 1;
        voucher.emailDelivery = { status: "pending", attempts: 0 };
        voucher.emailStatus = "pending";
        voucher.emailAttempts = 0;
      }
      audit(s, "voucher.email_retried", req, { voucherId: voucher.id, sent: !reason, queued: !reason });
      return json(res, 200, { sent: false, queued: !reason, emailStatus: voucher.emailStatus, ...(reason ? { error: reason } : {}) });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/generate") {
      const resale = i.purpose === "resale",
        // Resale stock is for selling unless marked otherwise; a voucher handed
        // straight to a customer must say whether it was paid for.
        saleType = i.saleType || (resale ? "sold" : "");
      if (!["sold", "gift"].includes(saleType)) {
        return json(res, 400, { error: "Choose whether this voucher was sold or given as a gift." });
      }
      if (saleType === "gift" && !["owner", "operator"].includes(role)) {
        return json(res, 403, { error: "Only owners and operators can issue gift vouchers." });
      }
      if (role === "reseller" && !resale) return json(res, 403, { error: "Resellers can generate unassigned resale stock only." });
      let plan, customGift = null;
      // A custom bundle given by the owner (#421): Unlimited terms set by hand,
      // always a gift for one customer or one reserved number, never written
      // to the catalogue. Operators can't, even through the API.
      if (i.planMode === "customGift") {
        if (role !== "owner") return json(res, 403, { error: "Only the owner can give a custom bundle." });
        if (resale || saleType !== "gift") return json(res, 400, { error: "A custom bundle is always a gift for one customer." });
        try { customGift = customGiftTerms(i, clock()); } catch (error) {
          if (!error.status) throw error;
          return json(res, error.status, { error: error.message });
        }
        plan = customGift.terms;
      } else if (i.planMode === "custom") {
        plan = {
          id: `resale-${randomUUID()}`,
          name: String(i.name || "")
            .trim()
            .slice(0, 80),
          price: Number(i.price),
          quotaGb: i.quotaGb === "" || i.quotaGb === null ? null : Number(i.quotaGb),
          validityHours: Number(i.validityHours),
          deviceLimit: Number(i.deviceLimit),
          custom: true,
          resale: true,
          createdAt: clock().toISOString(),
        };
        if (
          !plan.name ||
          !Number.isFinite(plan.price) ||
          plan.price < 0 ||
          (plan.quotaGb !== null && (!Number.isFinite(plan.quotaGb) || plan.quotaGb <= 0)) ||
          !Number.isFinite(plan.validityHours) ||
          plan.validityHours <= 0 ||
          !Number.isInteger(plan.deviceLimit) ||
          plan.deviceLimit < 1
        )
          return json(res, 400, { error: "Enter valid custom voucher details." });
      } else plan = findPlan(s, i.planId);
      // Reserved for a number with no account yet (#254): saved, not started;
      // claimed later with that number and the code.
      const reservedPhone = !resale && !i.customerId && i.reservedPhone !== undefined ? phone(i.reservedPhone) : null;
      if (reservedPhone !== null) {
        if (!phoneOk(reservedPhone)) return json(res, 400, { error: "Enter a valid Cameroon phone number." });
        const existing = s.customers.find((x) => x.phone === reservedPhone);
        if (existing) return json(res, 409, { code: "ACCOUNT_EXISTS", error: "This number already has an account. Give the voucher to that customer instead.", customerId: access.contacts ? existing.id : undefined });
      }
      // Home WISP is given to one customer, who registers their router (#336):
      // never resale stock, which would start on the direct HotSpot path.
      if (resale && plan?.accessType === "home_wisp_unlimited")
        return json(res, 400, { code: "HOME_WISP_NOT_RESALE", error: "Home WISP Unlimited is given to one customer, who registers their router. Choose a customer." });
      const c = resale || reservedPhone ? null : s.customers.find((x) => x.id === i.customerId),
        quantity = resale ? Number(i.quantity || 1) : 1;
      if (!plan || (!resale && !reservedPhone && !c)) {
        return json(res, 400, {
          error: resale ? "Choose a valid bundle." : "Customer and bundle are required.",
        });
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        return json(res, 400, { error: "Generate between 1 and 100 vouchers at a time." });
      }
      const requestedResellerId = resale && ["owner", "operator"].includes(role)
        ? String(i.assignedResellerId || "").trim()
        : "";
      let targetReseller = null;
      if (requestedResellerId) {
        targetReseller = (s.adminUsers || []).find(
          (u) => u.id === requestedResellerId && u.role === "reseller" && u.active !== false,
        );
        if (!targetReseller) {
          return json(res, 400, { error: "Choose an active reseller account for this batch." });
        }
      }
      const assignedResellerUser = role === "reseller" && adminUser?.id
        ? adminUser
        : targetReseller || null;
      const assignedResellerId = assignedResellerUser?.id || null;
      const assignedCommissionPercent = assignedResellerUser
        ? resellerRate(s, assignedResellerUser)
        : null;
      const activeVoucher = c ? s.vouchers.find((v) => v.customerId === c.id && v.status === "active") : null;
      // This route runs inside the store's write transaction. Compare before
      // adding a custom plan, voucher, audit entry or router command. Explicit
      // null means the operator saw no active bundle; omission keeps legacy
      // callers compatible.
      if (Object.hasOwn(i, "expectedActiveVoucherId")) {
        const expected = i.expectedActiveVoucherId;
        if (resale || (expected !== null && (typeof expected !== "string" || !expected.trim()))) {
          return json(res, 400, { error: "Expected active voucher must be an ID or null for a customer voucher." });
        }
        if ((activeVoucher?.id || null) !== expected) {
          return json(res, 409, {
            code: "ACTIVE_BUNDLE_CHANGED",
            error: "The customer's active bundle changed. Review it and confirm again.",
            activeBundle: activeVoucher ? {
              id: activeVoucher.id, planId: activeVoucher.planId,
              name: findPlan(s, activeVoucher.planId)?.name || "Active bundle",
              expiresAt: activeVoucher.expiresAt,
            } : null,
          });
        }
      }
      if (activeVoucher) {
        const replaceActive = i.replaceActive === true || i.replaceActive === "true";
        if (!replaceActive) {
          const activePlan = findPlan(s, activeVoucher.planId);
          return json(res, 409, {
            code: "ACTIVE_BUNDLE_EXISTS",
            error: "Customer already has an active voucher. Check 'Replace customer\'s existing active bundle' to replace it.",
            activeBundle: {
              id: activeVoucher.id,
              planId: activeVoucher.planId,
              name: activePlan?.name || "Active bundle",
              expiresAt: activeVoucher.expiresAt,
            },
            canReplace: true,
          });
        }
      }
      if (i.planMode === "custom") s.bundles.push(plan);
      const generated = [], batchReference = resale ? nextBatchReference(s, clock()) : null;
      // A Personal Unlimited bundle given to a customer waits for its first
      // connection (#334); resale stock is started by whoever redeems it.
      const waits = !resale && startsOnFirstConnection(plan);
      for (let index = 0; index < quantity; index++) {
        const t = clock().getTime(),
          v = {
            id: randomUUID(),
            customerId: c?.id || null,
            planId: plan.id,
            code: uniqueActivationCode(s),
            status: resale || reservedPhone || waits ? "available" : "active",
            activatedAt: resale || reservedPhone || waits ? null : new Date(t).toISOString(),
            expiresAt: resale || reservedPhone || waits ? null : new Date(t + plan.validityHours * 36e5).toISOString(),
            ...(waits ? { startsOnFirstConnection: true, validityHours: plan.validityHours } : {}),
            ...(reservedPhone ? { reservation: newReservation(reservedPhone, { type: "admin", ...(adminUser?.id ? { id: adminUser.id } : {}) }, t) } : {}),
            quotaBytes: plan.quotaGb === null ? null : plan.quotaGb * GB,
            usedBytes: 0,
            deviceLimit: plan.deviceLimit,
            // The access terms given (#421, #333): slots and sharing for Unlimited.
            ...accessTerms(plan),
            ...(customGift ? { customTerms: structuredClone(plan) } : {}),
            speedSnapshot: issueSpeedSnapshot(plan),
            generatedByAdmin: true,
            ...(adminUser?.id ? { generatedByAdminId: adminUser.id } : {}),
            ...(assignedResellerId ? { assignedResellerId, commissionPercent: assignedCommissionPercent } : {}),
            resale,
            ...(batchReference ? { batchReference } : {}),
            saleType,
            saleAmount: saleType === "sold" ? plan.price : 0,
            faceValue: plan.price,
            createdAt: new Date(t).toISOString(),
            // Usable for 90 days (owner, 26 Nov); a reserved code keeps its claim window.
            ...(reservedPhone ? {} : { useBy: useByFrom(t) }),
            ...(activeVoucher ? { replacesVoucherId: activeVoucher.id } : {}),
          };
        s.vouchers.unshift(v);
        // A voucher staff give an account also arrives by email, as a bought
        // one does, and in the customer's notifications (#343; owner 26 Nov).
        if (c) { v.givenAt = v.createdAt; queueVoucherEmail(s, v); }
        if (c && isHomeWisp(v)) startHomeWisp(s, c.id, clock());
        if (!resale && !reservedPhone && !waits) {
          enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, clock);
          v.routerSyncStatus = "pending";
        }
        if (activeVoucher) {
          activeVoucher.status = "replaced";
          activeVoucher.replacedAt = new Date(t).toISOString();
          if (adminUser?.id) activeVoucher.replacedByAdminId = adminUser.id;
          activeVoucher.replacedByVoucherId = v.id;
          enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: activeVoucher.id }, clock);
          activeVoucher.routerSyncStatus = "pending";
        }
        const redemptionUrl = voucherQrUrl(v, s.customers.find(c => c.id === v.customerId), customerOrigin);
        const qrCode = await QRCode.toDataURL(redemptionUrl, {
          width: 320, margin: 4, errorCorrectionLevel: "M",
        });
        generated.push({ ...voucherListView(s, v, access), qrCode, qrConnection: redemptionUrl.includes("/voucher-connect.html") });
      }
      if (activeVoucher) {
        audit(s, "voucher.admin_replaced", req, {
          replacedVoucherId: activeVoucher.id,
          newVoucherId: generated[0]?.id,
          customerId: c?.id,
          planId: plan.id,
          saleType,
        });
      }
      audit(s, resale ? "voucher.resale_batch_generated" : "voucher.generated", req, {
        voucherIds: generated.map((v) => v.id),
        ...(reservedPhone ? { reservedFor: maskPhone(reservedPhone) } : {}),
        customerId: c?.id || null,
        planId: plan.id,
        quantity,
        saleType,
        ...(assignedResellerId ? { assignedResellerId } : {}),
        ...(activeVoucher ? { replacedVoucherId: activeVoucher.id } : {}),
      });
      if (customGift) audit(s, "voucher.custom_gift_given", req, {
        voucherId: generated[0]?.id, customerId: c?.id || null, ...(reservedPhone ? { reservedFor: maskPhone(reservedPhone) } : {}),
        terms: { accessType: plan.accessType, validityValue: plan.validityValue, validityUnit: plan.validityUnit, deviceSlots: plan.deviceSlots }, reason: customGift.reason,
      });
      return json(res, 201, {
        voucher: generated[0],
        vouchers: generated,
        plan,
        ...(activeVoucher ? { replacedVoucher: { id: activeVoucher.id, status: activeVoucher.status } } : {}),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/classify") {
      const v = s.vouchers.find((x) => x.id === i.voucherId);
      if (!v || !v.generatedByAdmin || v.paymentId) return json(res, 404, { error: "Generated voucher not found." });
      if (!["sold", "gift"].includes(i.saleType)) return json(res, 400, { error: "Choose sold or gift." });
      const issuer = s.adminUsers.find(u => u.id === voucherResellerId(v)), ledgerSale = v.assignedResellerId || issuer && isResellerLedgerAccount(s, issuer);
      if ((v.cashSale || (v.activatedAt && ledgerSale)) && (v.saleType || "sold") !== i.saleType)
        return json(res, 409, { code: "LEDGER_ADJUSTMENT_REQUIRED", error: "A completed cash sale keeps its recorded classification. Use an audited ledger adjustment for corrections." });
      const previous = v.saleType || null, faceValue = v.faceValue ?? findPlan(s, v.planId)?.price ?? 0;
      Object.assign(v, { saleType: i.saleType, faceValue, saleAmount: i.saleType === "sold" ? faceValue : 0 });
      audit(s, "voucher.sale_classified", req, { voucherId: v.id, previous, saleType: v.saleType });
      return json(res, 200, { voucher: view(v, s) });
    }
    // A reservation's number can change before it is claimed (#254); the old
    // number can no longer claim it, and the wrong-try count starts again.
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/reservation") {
      if (!access.contacts || !access.manage) return json(res, 403, { error: "Your role cannot change who a voucher is reserved for." });
      const v = s.vouchers.find((x) => x.id === i.voucherId && mayReadVoucher(x, access));
      if (!v || !v.reservation) return json(res, 404, { error: "Reserved voucher not found." });
      if (v.status !== "available" || reservationState(v, clock()) !== "waiting") return json(res, 409, { error: "Only a reservation that is still waiting for its claim can change." });
      const next = phone(i.phone);
      if (!phoneOk(next)) return json(res, 400, { error: "Enter a valid Cameroon phone number." });
      if (next === v.reservation.phone) return json(res, 400, { error: "That is already the reserved number." });
      const previous = v.reservation.phone;
      Object.assign(v.reservation, { phone: next, wrongAttempts: 0, numberChangedAt: clock().toISOString() });
      delete v.reservation.lastWrongAttemptAt;
      audit(s, "voucher.reservation_number_changed", req, { voucherId: v.id, from: maskPhone(previous), to: maskPhone(next) });
      return json(res, 200, { voucher: voucherListView(s, v, access) });
    }
    // Revoke one device from a bundle (#334): its session, saved login and
    // binding are removed by the router, and the slot frees once confirmed.
    // Never restarts or extends the bundle.
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/devices/revoke") {
      if (!["owner", "operator"].includes(role)) return json(res, 403, { error: "Your role does not permit this action." });
      const v = s.vouchers.find((x) => x.id === i.voucherId), mac = String(i.mac || "").toUpperCase();
      const reason = typeof i.reason === "string" ? i.reason.trim() : "";
      if (!v || !v.customerId) return json(res, 404, { error: "Voucher not found." });
      if (!reason || reason.length > 300) return json(res, 400, { error: "Give the reason for revoking this device." });
      const grant = (s.wifiDeviceGrants || []).find((g) => g.customerId === v.customerId && g.mac === mac && g.voucherId === v.id);
      if (!grant) return json(res, 404, { error: "This device isn't registered on this bundle." });
      const already = grant.status === "revoked";
      const removal = already ? { pending: Boolean(grant.revocationCommandId && !grant.revocationConfirmedAt) }
        : revokeDeviceGrant(s, v.customerId, grant, clock(), { kind: "admin", actor: adminUser?.id || "admin" });
      if (removal.conflict) return json(res, 409, { error: "This device has a connection being confirmed. Try again in a moment." });
      if (!already) audit(s, "voucher.device_revoked", req, { voucherId: v.id, customerId: v.customerId, macSuffix: mac.slice(-5), reason });
      return json(res, removal.pending ? 202 : 200, { voucher: view(v, s), revocation: removal.pending ? "pending" : "confirmed" });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/vouchers/revoke") {
      const v = s.vouchers.find((x) => x.id === i.voucherId);
      if (!v) return json(res, 404, { error: "Voucher not found." });
      if (v.reservation && reservationState(v, clock()) === "waiting") v.reservation.status = "revoked";
      v.status = "revoked";
      enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, clock);
      v.routerSyncStatus = "pending";
      audit(s, "voucher.revoked", req, { voucherId: v.id });
      return json(res, 200, { voucher: view(v, s) });
    }
    return NOT_HANDLED;
  };
}
