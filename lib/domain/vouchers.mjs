import { randomUUID } from "node:crypto";
import { safeEqual, normalizeActivationCode, secureToken } from "../security.mjs";
import { phone, phoneOk, findPlan, voucherPlan, log, sec, view } from "../api/state.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { approvalPolicy } from "../wifi-approval.mjs";
import { activeSubscription } from "../subscription-policy.mjs";
import { claimReservation, recordWrongClaim, reservedAgainst, waitingFor } from "../reservations.mjs";
import { startedByCustomer, claimBonus, startBonus } from "../store-promotion-bonus.mjs";
import { startWaitingBundle } from "../device-slots.mjs";
import { isHomeWisp, startHomeWisp, HOME_WISP_ROUTER_REQUIRED } from "../home-wisp.mjs";
import { currentHome } from "../home.mjs";

// Voucher redemption business rules (ARCH-002). Operates on application state
// inside a store transaction and returns an outcome; it performs no I/O and
// knows nothing about HTTP. `requester.ip` identifies the caller for throttling.
export function redeemVoucher(s, input, { clock, requester, generic }) {
  if (approvalPolicy(s)) return { status: 409, body: { code: "DEVICE_APPROVAL_REQUIRED", error: "Use the portal to request access from your main device or finish first-device account setup." } };
  const source = { clientIp: requester.ip }, ph = phone(input.phone),
    recent = s.securityEvents.filter((x) => x.type === "redeem.failed" && new Date(x.at) > new Date(clock() - 9e5));
  // Customers share a hotspot IP. Limit guesses for each number,
  // with a larger IP limit to deter distributed guesses. Older events without
  // a phone still count against the aggregate IP limit until they expire.
  if (recent.filter((x) => x.meta?.phone === ph).length >= 20 ||
      recent.filter((x) => x.ip === requester.ip).length >= 100) {
    return { status: 429, body: { error: "Too many attempts. Try again later." } };
  }
  let routerCommandId;
  const v = s.vouchers.find((x) => safeEqual(x.code, normalizeActivationCode(input.code)));
  let c = s.customers.find((x) => x.phone === phone(input.phone));
  // A voucher reserved for a number (#254) is taken only by that number, and
  // once claimed only by the account that claimed it.
  if (v && (reservedAgainst(v, phone(input.phone), clock()) || (v.reservation && v.customerId && v.customerId !== c?.id))) {
    recordWrongClaim(v, clock());
    sec(s, "redeem.failed", source, { phone: ph });
    return { status: 401, body: { error: generic } };
  }
  // A store promotion's free month (#423) in an account is started only by
  // that account.
  if (v?.status === "available" && startedByCustomer(v) && v.customerId && v.customerId !== c?.id) {
    sec(s, "redeem.failed", source, { phone: ph });
    return { status: 401, body: { error: generic } };
  }
  // A claimed bundle waits a limited time to be started.
  if (v?.status === "available" && v.customerId && v.customerId === c?.id && v.startBy && !(Date.parse(v.startBy) > +clock())) {
    return { status: 409, body: { code: "START_WINDOW_ENDED", error: `This bundle had to be started by ${new Date(v.startBy).toISOString().slice(0, 10)}.` } };
  }
  if (v?.status === "available" && !c && phoneOk(input.phone)) {
    c = {
      id: randomUUID(),
      phone: phone(input.phone),
      name: "Voucher customer",
      email: "",
      createdAt: clock().toISOString(),
    };
    s.customers.push(c);
  }
  // Home WISP (#336) is never started or used here, on the direct HotSpot path:
  // its registered router starts it. The code claims it for its number; a
  // linked router starts it at once, otherwise the customer registers one.
  if (v?.status === "available" && isHomeWisp(v)) {
    if (c && !v.customerId && waitingFor(v, c.phone, clock())) {
      claimReservation(v, c, clock(), "code");
      log(s, "voucher.reservation_claimed", { voucherId: v.id, customerId: c.id, how: "redeem" });
    }
    if (c && v.customerId === c.id) {
      v.startsOnFirstConnection = true; v.validityHours ??= voucherPlan(s, v)?.validityHours;
      if (startHomeWisp(s, c.id, clock())) return { status: 202, body: { code: "HOME_WISP_STARTED", message: "Your Home WISP Unlimited is starting on your registered router." } };
      if (currentHome(s, c.id)) return { status: 409, body: { code: "ACTIVE_BUNDLE_EXISTS", error: "Your current bundle is still running. Home WISP Unlimited stays saved: enter this code again once it ends." } };
    }
    return { status: 409, body: { ...HOME_WISP_ROUTER_REQUIRED } };
  }
  // Entering a free month's code starts it (#423): claimed first when it waits
  // for this number, then started with its own length. A bundle already
  // running pauses and resumes afterwards with the time it had left.
  if (v?.status === "available" && c && startedByCustomer(v)) {
    if (!v.customerId && waitingFor(v, c.phone, clock())) {
      claimReservation(v, c, clock(), "code");
      claimBonus(s, v, c, clock());
      log(s, "voucher.reservation_claimed", { voucherId: v.id, customerId: c.id, how: "redeem" });
    }
    if (v.customerId === c.id) {
      if (!(Date.parse(v.promotion.startBy) > +clock()))
        return { status: 409, body: { code: "START_WINDOW_ENDED", error: `This free month had to be started by ${new Date(v.promotion.startBy).toISOString().slice(0, 10)}.` } };
      startBonus(s, v, c, clock());
      routerCommandId = `router:sync_voucher:${v.id}`;
    }
  }
  // A Personal Unlimited bundle waiting for its first connection (#334):
  // entering its code with its own account's number starts it now.
  if (v?.status === "available" && c && v.customerId === c.id && v.startsOnFirstConnection === true && !startedByCustomer(v)) {
    const other = activeSubscription(s, c.id, clock());
    if (other && other.id !== v.id) return { status: 409, body: { code: "ACTIVE_BUNDLE_EXISTS", error: "An active bundle is already associated with this account. This voucher was not used. Sign in to connect with your existing bundle." } };
    startWaitingBundle(s, v, clock(), "code");
    routerCommandId = `router:sync_voucher:${v.id}`;
  }
  if (v?.status === "available" && c && !startedByCustomer(v)) {
    const active = activeSubscription(s, c.id, clock());
    // The bundle waiting for its first connection is this one: entering its
    // code is that connection (#334).
    if (active && active.id !== v.id) {
      return {
        status: 409,
        body: {
          code: "ACTIVE_BUNDLE_EXISTS",
          error: "An active bundle is already associated with this account. This voucher was not used. Sign in to connect with your existing bundle.",
        },
      };
    }
    const plan = voucherPlan(s, v),
      activatedAt = clock();
    if (plan && waitingFor(v, c.phone, activatedAt)) {
      claimReservation(v, c, activatedAt, "code");
      log(s, "voucher.reservation_claimed", { voucherId: v.id, customerId: c.id, how: "redeem" });
    }
    if (!plan) return { status: 409, body: { error: "This voucher's bundle is unavailable." } };
    Object.assign(v, {
      customerId: c.id,
      status: "active",
      activatedAt: activatedAt.toISOString(),
      // The validity it was bought or given with (#334), else the plan's.
      expiresAt: new Date(activatedAt.getTime() + (v.validityHours ?? plan.validityHours) * 36e5).toISOString(),
    });
    routerCommandId = enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, clock).id;
    v.routerSyncStatus = "pending";
    log(s, "voucher.resale_claimed", { voucherId: v.id, customerId: c.id });
  }
  if (!v || !c || v.customerId !== c.id) {
    sec(s, "redeem.failed", source, { phone: ph });
    return { status: 401, body: { error: generic } };
  }
  if (v.accessMode === "home" || v.accessTransitionId) return { status: 409, body: { code: "HOME_ACCESS_SELECTED", error: "This bundle is assigned to Home access or is changing mode." } };
  if (v.status !== "active") {
    return { status: 409, body: { error: `This code is ${v.status}.` }, routerCommandId };
  }
  const deviceId = String(input.deviceId || "").slice(0, 200) || secureToken(16);
  let session = s.sessions.find(
    (x) => x.voucherId === v.id && x.deviceId === deviceId && x.status === "online",
  );
  const active = s.sessions.filter((x) => x.voucherId === v.id && x.status === "online");
  if (!session && active.length >= v.deviceLimit) {
    return {
      status: 409,
      body: { error: `Device limit reached (${v.deviceLimit}). Disconnect another device first.` },
      routerCommandId,
    };
  }
  if (!session) {
    session = {
      id: randomUUID(),
      voucherId: v.id,
      deviceId,
      label: String(input.label || "Device").slice(0, 80),
      status: "online",
      connectedAt: clock().toISOString(),
    };
    s.sessions.push(session);
  }
  session.lastSeenAt = clock().toISOString();
  log(s, "device.connected", { voucherId: v.id, deviceId });
  return { status: 200, body: { voucher: view(v, s), session }, routerCommandId };
}
