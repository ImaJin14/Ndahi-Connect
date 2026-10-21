import { routerRevision, isMainDevice } from "./device-identities.mjs";
import { wifiReadingMaxAgeMs, disconnectView } from "./wifi-devices.mjs";
import { deviceRevocation, deviceGrant } from "./wifi-approval.mjs";

export const currentIdentityMaxAgeMs = 15 * 60 * 1000;
const recent = (at, now, limit) => Number.isFinite(Date.parse(at)) && +now - Date.parse(at) >= -5000 && +now - Date.parse(at) <= limit;

// A browser association identifies a router-verified candidate, never account
// ownership. Connection state still needs a fresh reading of that exact device.
export function currentWifiView(s, customerId, binding, now, { inCoverage = true, sessionId } = {}) {
  const result = { state: "unknown", checkedAt: null, message: "Open Wi-Fi sign-in on this device to identify its connection." };
  if (!inCoverage) return { ...result, message: "Join NDAHI Wi-Fi, then refresh this device's connection." };
  if (s.networkSetup?.runtimeRouterEnabled !== true || s.networkSetup.connections?.router?.mode !== "live") return { ...result, message: "The live router connection is unavailable. Refresh after it is restored." };
  const customer = s.customers.find((c) => c.id === customerId), voucher = s.vouchers.find((v) => v.customerId === customerId && v.status === "active");
  if (!customer || customer.status === "suspended" || !voucher) return { ...result, state: "unavailable", message: "An active bundle is required to connect." };
  const connecting = sessionId && s.wifiPairingRequests.find((p) => p.customerId === customerId && p.browserSessionId === sessionId && p.status === "connecting" && p.routerRevision === routerRevision(s));
  if (connecting) return { state: "connecting", checkedAt: null, message: "Waiting for the router to confirm this connection." };
  if (!binding || binding.routerRevision !== routerRevision(s) || !recent(binding.verifiedAt, now, currentIdentityMaxAgeMs)) return result;
  const checkedAt = voucher.wifiDevicesAt || null;
  const device = (voucher.wifiDevices || []).find((d) => d.mac === binding.mac && d.address === binding.loginAddress);
  const safeDevice = device && { mac: device.mac, sessionId: device.sessionId, startedAt: device.startedAt, main: isMainDevice(s, customer, device.mac) };
  const commands = s.routerCommands.filter((c) => c.action === "disconnect_wifi_device" && c.customerId === customerId &&
    c.device?.voucherId === voucher.id && c.device.mac === binding.mac && (!device || c.device.sessionId === device.sessionId && c.device.startedAt === device.startedAt));
  const operation = commands.at(-1);
  const info = { checkedAt, identityCheckedAt: binding.verifiedAt, candidate: { mac: binding.mac, address: binding.address }, ...(safeDevice ? { device: safeDevice } : {}) };
  const removal = deviceRevocation(s, customerId, binding.mac);
  if (removal) return { ...info, device: undefined, state: removal.status === "dead_letter" ? "failed" : "disconnecting",
    message: removal.status === "dead_letter" ? "Saved approval was revoked. Router removal needs support review." : "Saved approval was revoked. Waiting for router removal; its slot is not confirmed free." };
  if (operation && ["queued", "processing", "retry"].includes(operation.status)) return { ...info, state: "disconnecting", operation: disconnectView(operation), message: "Waiting for the router to confirm disconnection. Its slot is still occupied." };
  if (operation?.status === "dead_letter") return { ...info, state: "failed", operation: disconnectView(operation), message: "Disconnection is not confirmed. Refresh and retry, or contact support." };
  if (!device) {
    if ((voucher.wifiDevices || []).some((d) => d.mac === binding.mac)) return { ...info, state: "unknown", message: "This device's Wi-Fi address changed. Open Wi-Fi sign-in again to identify it." };
    if (operation?.status === "processed" && ["disconnected", "absent"].includes(operation.result) && recent(operation.processedAt, now, wifiReadingMaxAgeMs)) {
      return { ...info, checkedAt: operation.processedAt, state: "disconnected", message: deviceGrant(s, customerId, binding.mac)
        ? "Disconnection confirmed. Saved approval is kept unless you forget this device." : "Disconnection confirmed. Saved approval is unavailable; request access again." };
    }
  }
  const read = s.routerCommands.find((c) => c.id === "router:sync_usage:global");
  if (!recent(checkedAt, now, wifiReadingMaxAgeMs) || read?.status === "dead_letter") return { ...info, state: "stale", message: "The router reading is out of date. Refresh before relying on connection status." };
  if (!device) return { ...info, state: "disconnected", message: "This device was not connected at the last router check." };
  if (!device.sessionId || !Number.isFinite(Date.parse(device.startedAt))) return { ...info, state: "unknown", message: "The router did not identify this session. Refresh or open Wi-Fi sign-in again." };
  return { ...info, state: "connected", message: "This device is connected, confirmed by the router." };
}
