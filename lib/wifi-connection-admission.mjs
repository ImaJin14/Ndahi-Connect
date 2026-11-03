import { deviceCapabilities } from "./device-capabilities.mjs";

export const sameSession = (a, b) => Boolean(a && b && a.mac === b.mac && a.sessionId === b.sessionId && a.startedAt === b.startedAt);
export const exactSession = d => ({ mac: d.mac, sessionId: d.sessionId, startedAt: d.startedAt });
export function connectionAdmission(s, p, v, now) {
  const capabilities = deviceCapabilities(s, p.customerId, now);
  if (capabilities.voucherId !== v?.id) return { code: "BUNDLE_UNAVAILABLE", error: "The purchased bundle changed. Connect again." };
  const age = +now - Date.parse(v.wifiDevicesAt);
  if (!Number.isFinite(age) || age < -5000 || age > 120000) return { code: "DEVICE_REFRESH_REQUIRED", error: "A fresh router device reading is required before connecting." };
  const occupied = (v.wifiDevices || []).filter(d => d.mac !== p.mac).length;
  const reserved = (s.wifiPairingRequests || []).filter(x => x.id !== p.id && x.voucherId === v.id && x.status === "connecting").length;
  if (occupied + reserved >= capabilities.deviceLimit) return { code: "DEVICE_SLOTS_FULL", error: "All device slots are in use. Wait for confirmed disconnection." };
  return null;
}
export function singleSwitchState(s, p, now) {
  const capabilities = deviceCapabilities(s, p.customerId, now);
  if (capabilities.connectionMode !== "single" || capabilities.voucherId !== p.voucherId) return { error: "The single-device bundle changed. Connect again.", code: "BUNDLE_UNAVAILABLE" };
  const command = s.routerCommands.find(c => c.id === p.disconnectCommandId && c.singleSwitchId === p.id);
  if (!command || !sameSession(command.device, p.replacedSession)) return { error: "Replacement authorization changed.", code: "PAIRING_REVOKED" };
  if (["queued", "retry", "processing"].includes(command.status)) return { waiting: true };
  if (command.status !== "processed" || !["disconnected", "absent"].includes(command.result)) return { error: "Disconnection is not confirmed. Check the current device before trying again.", code: "DISCONNECT_UNCONFIRMED" };
  return null;
}
