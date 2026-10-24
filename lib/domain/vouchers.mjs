import { randomUUID } from "node:crypto";
import { safeEqual, normalizeActivationCode, secureToken } from "../security.mjs";
import { phone, phoneOk, findPlan, log, sec, view } from "../api/state.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { approvalPolicy } from "../wifi-approval.mjs";
import { activeSubscription } from "../subscription-policy.mjs";

// Voucher redemption business rules (ARCH-002). Operates on application state
// inside a store transaction and returns an outcome; it performs no I/O and
// knows nothing about HTTP. `requester.ip` identifies the caller for throttling.
export function redeemVoucher(s, input, { clock, requester, generic }) {
  if (approvalPolicy(s)) return { status: 409, body: { code: "DEVICE_APPROVAL_REQUIRED", error: "Use the portal to request access from your main device or finish first-device account setup." } };
  const source = { clientIp: requester.ip };
  if (
    s.securityEvents.filter(
      (x) =>
        x.type === "redeem.failed" &&
        x.ip === requester.ip &&
        new Date(x.at) > new Date(clock() - 9e5),
    ).length >= 20
  ) {
    return { status: 429, body: { error: "Too many attempts. Try again later." } };
  }
  let routerCommandId;
  const v = s.vouchers.find((x) => safeEqual(x.code, normalizeActivationCode(input.code)));
  let c = s.customers.find((x) => x.phone === phone(input.phone));
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
  if (v?.status === "available" && c) {
    const active = activeSubscription(s, c.id, clock());
    if (active) {
      return {
        status: 409,
        body: {
          code: "ACTIVE_BUNDLE_EXISTS",
          error: "An active bundle is already associated with this account. This voucher was not used. Sign in to connect with your existing bundle.",
        },
      };
    }
    const plan = findPlan(s, v.planId),
      activatedAt = clock();
    if (!plan) return { status: 409, body: { error: "This voucher's bundle is unavailable." } };
    Object.assign(v, {
      customerId: c.id,
      status: "active",
      activatedAt: activatedAt.toISOString(),
      expiresAt: new Date(activatedAt.getTime() + plan.validityHours * 36e5).toISOString(),
    });
    routerCommandId = enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, clock).id;
    v.routerSyncStatus = "pending";
    log(s, "voucher.resale_claimed", { voucherId: v.id, customerId: c.id });
  }
  if (!v || !c || v.customerId !== c.id) {
    sec(s, "redeem.failed", source);
    return { status: 401, body: { error: generic } };
  }
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
