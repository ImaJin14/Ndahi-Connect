import { createHmac } from "node:crypto";
import { hashSecret, safeEqual } from "./security.mjs";
import { routerRevision } from "./device-identities.mjs";
import { approvalAvailable, deviceGrant } from "./wifi-approval.mjs";

export const pairingLifetimeMs = 300000;
export const pendingPairing = (p) => ["pending", "awaiting_code", "awaiting_confirmation", "connecting"].includes(p.status);
export const pairingEnabled = (s) => s.networkSetup?.runtimeRouterEnabled === true &&
  s.networkSetup.connections?.router?.mode === "live" && s.networkSetup.assistedConnections?.enabled === true &&
  s.networkSetup.assistedConnections.revision === routerRevision(s) && approvalAvailable(s);
export const pairingCode = (id, key, secret) => String(Number.parseInt(createHmac("sha256", secret)
  .update(JSON.stringify(["wifi-pairing", id, key])).digest("hex").slice(0, 8), 16) % 1000000).padStart(6, "0");
export const matchesPairingSecret = (value, hash, secret, previous = "") => [secret, previous].filter(Boolean)
  .some((pepper) => safeEqual(hash || "", hashSecret(value, pepper)));
export function pairingView(p) {
  return { id: p.id, name: p.name, macSuffix: p.mac.slice(-5), status: p.status, expiresAt: p.expiresAt,
    updatedAt: p.updatedAt || p.at, ...(p.message ? { message: p.message } : {}) };
}
export function pairingVoucher(s, p, now) {
  const c = s.customers.find((c) => c.id === p.customerId), v = s.vouchers.find((v) => v.id === p.voucherId && v.customerId === p.customerId);
  if (!c || c.status === "suspended" || c.suspended || !v || v.status !== "active" || !(Date.parse(v.expiresAt) > +now) ||
      (v.quotaBytes !== null && (!Number.isFinite(v.quotaBytes) || !(v.quotaBytes > (v.usedBytes || 0)))) || v.routerSyncStatus !== "synchronized") return null;
  if (v.paymentId && !s.payments.some((payment) => payment.id === v.paymentId && payment.customerId === c.id &&
      payment.confirmedAt && ["paid", "refund-pending"].includes(payment.status))) return null;
  return v;
}
export function expireWifiPairings(s, now) {
  for (const p of s.wifiPairingRequests || []) {
    if (p.protocol === 3 && p.status === "awaiting_confirmation") {
      const main = s.customers.find(c => c.id === p.customerId)?.wifiMainDevice;
      if (!pairingEnabled(s) || p.requestedController && p.requestedController !== main?.controllerHash) {
        p.status = "cancelled"; p.updatedAt = now.toISOString(); p.message = "Network or main-device control changed. Request access again.";
        delete p.referenceNonce; delete p.referenceHash; continue;
      }
    }
    if (!pendingPairing(p) || Date.parse(p.expiresAt) > +now) continue;
    const command = (s.routerCommands || []).find((c) => c.id === p.commandId);
    // Let an in-flight operation finish its bounded confirmation; never issue
    // another login after expiry. A crashed worker has a finite lease.
    if (command?.status === "processing" && Date.parse(command.leaseUntil) > +now) continue;
    p.status = "expired"; p.updatedAt = now.toISOString(); p.message = p.protocol === 3 ? "Connection request expired. Request access again." : "Connection request expired. Request a new code on the device.";
    if (command && ["queued", "retry", "processing"].includes(command.status)) {
      command.status = "processed"; command.result = "expired"; command.processedAt = now.toISOString(); command.nextAttemptAt = null;
      delete command.leaseToken; delete command.leaseUntil;
    }
  }
  s.wifiPairingRequests = (s.wifiPairingRequests || []).filter((p) => pendingPairing(p) || Date.parse(p.expiresAt) > +now - 7 * 86400000);
}

// Rechecked when a queued job is claimed. Only a recorded main-browser approval
// can authorize a write; a voucher, display name or pairing code cannot.
export function connectAuthorization(s, command, now, secret, previousSecret = "") {
  const p = (s.wifiPairingRequests || []).find((p) => p.id === command.targetId),
    c = p && s.customers.find((c) => c.id === p.customerId), main = c?.wifiMainDevice;
  if (!p || p.status !== "connecting" || p.commandId !== command.id || !(Date.parse(p.expiresAt) > +now)) return { error: "Connection request expired or is no longer active.", code: "PAIRING_EXPIRED" };
  if (["reconnect", "bootstrap", "recovery"].includes(p.kind)) {
    const grant = deviceGrant(s, p.customerId, p.mac), session = s.dashboardSessions.find((a) => a.id === p.ownerSessionId && a.customerId === p.customerId && Date.parse(a.expiresAt) > +now);
    const valid = p.kind === "reconnect" ? grant?.approvedAt === p.grantApprovedAt : session && matchesPairingSecret(c?.pinHash || "", p.ownerPinVersion, secret, previousSecret);
    if (!valid || !approvalAvailable(s) || p.routerRevision !== routerRevision(s)) return { error: "Device authorization changed. Verify ownership or request access again.", code: "PAIRING_REVOKED" };
    const v = pairingVoucher(s, p, now);
    return v ? { pairing: p, voucher: v } : { error: "The bundle is unavailable.", code: "BUNDLE_UNAVAILABLE" };
  }
  if (!pairingEnabled(s) || p.routerRevision !== routerRevision(s) || !main || main.routerRevision !== p.routerRevision ||
      main.controllerHash !== p.approvedBy || !matchesPairingSecret(c.pinHash || "", main.pinVersion, secret, previousSecret)) {
    return { error: "Connection approval is no longer valid. Request approval again.", code: "PAIRING_REVOKED" };
  }
  const v = pairingVoucher(s, p, now);
  if (!v) return { error: "The bundle is unavailable, expired or out of data.", code: "BUNDLE_UNAVAILABLE" };
  return { pairing: p, voucher: v };
}
