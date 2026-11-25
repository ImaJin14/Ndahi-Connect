// Personal Unlimited device slots (#334; spec §3, decisions.md → "Unlimited
// catalogue and device locking"). Only bundles whose own terms say Personal
// Unlimited (`accessType`, carried from the purchase or gift snapshot, #333
// and #421) follow these rules; every other bundle keeps its own device rule
// ("Current customers keep their terms until their bundle ends").
//
// - A slot is a device approval bound to the MAC RouterOS observed during the
//   authenticated connection (wifi-approval.mjs); a MAC sent by a browser is
//   never trusted. A device counts against its bundle while approved, online
//   or not, and while its removal is still unconfirmed by the router: full
//   slots refuse a new device even if a registered one is offline.
// - Replacing a device = removing one (owner-verified forget, or an admin
//   revoke), waiting for the router to confirm it is gone, then connecting the
//   new one. Removal never restarts or extends the bundle.
// - Time starts at the first connection (owner, #333): a Personal Unlimited
//   bundle waits unstarted after payment or a gift, and its first connection
//   (the code at the HotSpot, or a device's access request) starts it.
import { randomUUID } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";
import { routerRevision } from "./device-identities.mjs";
import { invalidateAppDevice } from "./wifi-app-associations.mjs";

const HOUR = 36e5;
export const isPersonalUnlimited = (v) => v?.accessType === "personal_unlimited";
// The bundle's terms make it wait for its first connection: a device's for
// Personal Unlimited, the registered router's for Home WISP (#336).
export const startsOnFirstConnection = (plan) => ["personal_unlimited", "home_wisp_unlimited"].includes(plan?.accessType);

// The MACs holding this bundle's slots: approved for it on the current router,
// or removed but not yet confirmed gone by the router.
export function occupiedSlots(s, v) {
  const revision = routerRevision(s);
  return (s.wifiDeviceGrants || []).filter((g) => g.customerId === v.customerId && g.voucherId === v.id && g.routerRevision === revision &&
    (g.status === "approved" || (g.revocationCommandId && !g.revocationConfirmedAt))).map((g) => g.mac);
}

// Null when `mac` may take (or already holds) a slot; otherwise the refusal.
// `reserved` counts other devices already being connected to this bundle.
export function slotRefusal(s, v, mac, reserved = 0) {
  if (!isPersonalUnlimited(v)) return null;
  const taken = occupiedSlots(s, v), mine = taken.includes(String(mac || "").toUpperCase());
  if (mine) return null;
  const slots = v.deviceSlots || v.deviceLimit || 1;
  if (taken.length + reserved < slots) return null;
  return { status: 409, body: { code: "DEVICE_SLOTS_FULL", slots, error: slots === 1
    ? "This bundle's device slot is in use, even when that device is offline. Replace the device to use this one."
    : `All ${slots} device slots are in use, even when a device is offline. Replace a device to use this one.` } };
}

// A bundle bought or given, waiting for its first connection.
export function waitingBundle(s, customerId) {
  return s.vouchers.find((v) => v.customerId === customerId && v.status === "available" && v.startsOnFirstConnection === true && v.accessType !== "home_wisp_unlimited");
}

// The first connection starts the bundle: its validity runs from now, once.
// Never a Home WISP bundle: only its registered router starts it (home-wisp.mjs).
export function startWaitingBundle(s, v, now, how) {
  if (v.status !== "available" || v.startsOnFirstConnection !== true || v.accessType === "home_wisp_unlimited") return false;
  const at = new Date(now), hours = v.validityHours;
  v.status = "active";
  v.activatedAt = at.toISOString();
  v.expiresAt = new Date(+at + hours * HOUR).toISOString();
  v.startedBy = how;
  delete v.startBy;
  enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, () => at);
  v.routerSyncStatus = "pending";
  s.auditLogs ??= [];
  s.auditLogs.unshift({ id: randomUUID(), action: "voucher.started_on_first_connection", actor: "system", meta: { voucherId: v.id, customerId: v.customerId, how, expiresAt: v.expiresAt }, at: at.toISOString() });
  return true;
}

// Removes one device's slot: cancels its pending connection, revokes its
// approval and asks the router to remove its session, saved login and
// binding; the slot stays taken until the router confirms. Shared by the
// customer's verified "forget" and the admin's revoke. Returns
// { conflict } when a connection is being confirmed right now.
export function revokeDeviceGrant(s, customerId, grant, now, by) {
  const at = new Date(now).toISOString();
  const requests = (s.wifiPairingRequests || []).filter((p) => p.customerId === customerId && p.mac === grant.mac && ["pending", "awaiting_code", "connecting"].includes(p.status));
  if (requests.some((p) => (s.routerCommands || []).some((c) => c.id === p.commandId && c.status === "processing"))) return { conflict: true };
  for (const p of requests) {
    p.status = "cancelled"; p.updatedAt = at; p.message = "Saved device approval was removed. Request fresh access.";
    delete p.codeHash; delete p.codeNonce;
    const command = (s.routerCommands || []).find((c) => c.id === p.commandId);
    if (command && ["queued", "retry"].includes(command.status)) {
      command.status = "processed"; command.result = "cancelled"; command.processedAt = at; command.nextAttemptAt = null;
      delete command.leaseToken; delete command.leaseUntil;
    }
  }
  grant.status = "revoked"; grant.revokedAt = at;
  invalidateAppDevice(s, customerId, grant.mac, new Date(now));
  if (grant.routerRevision === routerRevision(s)) {
    const command = enqueueRouterCommand(s, { action: "revoke_wifi_device", targetId: randomUUID() }, () => new Date(now));
    grant.revocationCommandId = command.id;
    command.customerId = customerId; command.grantId = grant.id; command.routerRevision = grant.routerRevision;
  }
  // Shown on the customer's detail: how often a Personal Unlimited bundle's devices were replaced.
  const v = s.vouchers.find((x) => x.id === grant.voucherId);
  if (isPersonalUnlimited(v)) v.deviceReplacements = (v.deviceReplacements || 0) + 1;
  s.auditLogs ??= [];
  s.auditLogs.unshift({ id: randomUUID(), action: "voucher.device_slot_released", actor: by?.actor || "customer",
    meta: { customerId, voucherId: grant.voucherId || null, macSuffix: grant.mac.slice(-5), by: by?.kind || "customer" }, at });
  return { conflict: false, pending: Boolean(grant.revocationCommandId) };
}
