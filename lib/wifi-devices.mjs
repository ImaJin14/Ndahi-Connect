import { createHash } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";
import { isMainDevice, mainDeviceView, deviceName } from "./device-identities.mjs";
import { deviceGrant } from "./wifi-approval.mjs";

export const liveRouter = (s, env = {}) => s.networkSetup?.runtimeRouterEnabled === true || env.MIKROTIK_MODE === "live";
const pending = (c) => ["queued", "processing", "retry"].includes(c.status);
export const wifiReadingMaxAgeMs = 120000;
const freshReading = (at, now) => Number.isFinite(Date.parse(at)) && +now - Date.parse(at) >= -5000 && +now - Date.parse(at) <= wifiReadingMaxAgeMs;

// A single source for the admin count and paginated live-device list. Legacy
// browser sessions do not establish a physical Wi-Fi connection.
export function observedWifiDevices(s, now = new Date()) {
  const devices = new Map();
  for (const v of s.vouchers.filter((v) => v.status === "active")) {
    for (const d of wifiDeviceView(s, v).devices) {
      const id = JSON.stringify([v.id, d.mac, d.sessionId, d.startedAt]);
      devices.set(id, { ...d, id, voucherId: v.id, customerId: v.customerId,
        syncedAt: v.wifiDevicesAt || null, fresh: freshReading(v.wifiDevicesAt, now) });
    }
  }
  return [...devices.values()];
}
export function adminWifiSummary(s, now = new Date()) {
  const vouchers = s.vouchers.filter((v) => v.status === "active"), devices = observedWifiDevices(s, now);
  const read = (s.routerCommands || []).find((c) => c.id === "router:sync_usage:global");
  const unread = vouchers.filter((v) => !freshReading(v.wifiDevicesAt, now)).length;
  const checked = vouchers.map((v) => Date.parse(v.wifiDevicesAt)).filter(Number.isFinite);
  return {
    state: read?.status === "dead_letter" ? "failed" : read && pending(read) ? read.status === "retry" ? "retrying" : "refreshing"
      : !vouchers.length ? "idle" : unread ? "stale" : "ready",
    activeCount: devices.filter((d) => d.fresh).length,
    staleCount: devices.filter((d) => !d.fresh).length,
    observedCount: devices.length, unreadVouchers: unread,
    syncedAt: checked.length ? new Date(Math.min(...checked)).toISOString() : null,
    refresh: read ? { id: read.id, status: read.status, error: read.lastError || null,
      canReplay: ["retry", "dead_letter"].includes(read.status) } : null,
  };
}
export function requestWifiRefresh(s, now = () => new Date()) {
  const summary = adminWifiSummary(s, now());
  if (summary.refresh?.status === "dead_letter") return { status: 409, body: { ...summary,
    error: "The router reading needs review. Fix the connection, then retry the failed reading.", code: "ROUTER_READ_FAILED" } };
  if (!s.vouchers.some((v) => v.status === "active")) return { status: 200, body: summary };
  const read = (s.routerCommands || []).find((c) => c.id === "router:sync_usage:global");
  if (read?.status === "processed" && +now() - Date.parse(read.processedAt) < 5000) return { status: 200, body: summary };
  enqueueRouterCommand(s, { action: "sync_usage" }, now);
  return { status: 202, body: adminWifiSummary(s, now()) };
}
export function disconnectView(command) {
  return {
    id: command.id, mac: command.device.mac, sessionId: command.device.sessionId,
    status: command.status === "processed" ? command.result === "superseded" ? "superseded" : "disconnected"
      : command.status === "dead_letter" ? "failed" : command.status === "retry" ? "retrying" : "disconnecting",
    message: command.status === "dead_letter" ? "Could not disconnect this device. Try again or contact support."
      : command.status === "retry" ? "Router unavailable—retrying. The slot is not confirmed free."
      : command.status === "processed" ? command.result === "superseded" ? "This device has a newer session. Refresh before disconnecting it." : "Disconnection confirmed."
      : "Waiting for the router to confirm disconnection…",
    updatedAt: command.processedAt || command.lastAttemptAt || command.at,
  };
}
export function wifiDeviceView(s, voucher) {
  const customer = s.customers?.find((c) => c.id === voucher?.customerId);
  const commands = (s.routerCommands || []).filter((c) => c.action === "disconnect_wifi_device" && c.device?.voucherId === voucher?.id);
  const disconnects = commands.slice(-20).map(disconnectView);
  return {
    deviceLimit: voucher?.deviceLimit ?? null,
    mainDevice: mainDeviceView(s, customer),
    devices: (voucher?.wifiDevices || []).map((d) => {
      const main = isMainDevice(s, customer, d.mac), announced = deviceName(d.name);
      const name = announced || deviceName(customer && deviceGrant(s, customer.id, d.mac)?.name) || (main ? deviceName(customer.wifiMainDevice.name) : "");
      const { name: _rawName, ...device } = d;
      const c = commands.findLast((c) => c.device.sessionId === d.sessionId && c.device.mac === d.mac &&
        c.device.startedAt === d.startedAt && (pending(c) || c.status === "dead_letter"));
      return { ...device, ...(name ? { name, ...(!announced ? { nameLastReported: true } : {}) } : {}), ...(main ? { main: true } : {}), ...(c ? { disconnect: disconnectView(c) } : {}) };
    }),
    syncedAt: voucher?.wifiDevicesAt || null,
    disconnects,
  };
}
export function requestWifiDisconnect(s, voucher, input, now = () => new Date(), { ownerVerified = false } = {}) {
  const mac = String(input.mac || "").toUpperCase();
  const device = voucher?.wifiDevices?.find((d) => d.mac === mac && (!input.sessionId || input.sessionId === d.sessionId) &&
    (!input.startedAt || input.startedAt === d.startedAt));
  if (!device) return { status: 404, body: { error: "That device is no longer connected. Refresh the list." } };
  if (!ownerVerified && isMainDevice(s, s.customers?.find((c) => c.id === voucher.customerId), mac)) {
    return { status: 403, body: { code: "MAIN_DEVICE_VERIFICATION_REQUIRED", error: "Verify account ownership before disconnecting the main device." } };
  }
  if (!device.sessionId || !Number.isFinite(Date.parse(device.startedAt)) ||
      !freshReading(voucher.wifiDevicesAt, now())) {
    return { status: 409, body: { code: "DEVICE_REFRESH_REQUIRED", error: "A fresh router reading is required before disconnecting this device. Refresh the list in a moment." } };
  }
  const target = { voucherId: voucher.id, username: voucher.code, mac, sessionId: device.sessionId, startedAt: device.startedAt };
  const targetId = createHash("sha256").update(JSON.stringify(target)).digest("hex").slice(0, 32);
  const command = enqueueRouterCommand(s, { action: "disconnect_wifi_device", targetId }, now);
  for (const grant of s.wifiDeviceGrants || []) if (grant.customerId === voucher.customerId && grant.mac === mac) {
    grant.status = "revoked"; grant.revokedAt = now().toISOString();
  }
  for (const request of s.wifiPairingRequests || []) if (request.customerId === voucher.customerId && request.mac === mac && ["pending", "awaiting_code"].includes(request.status)) {
    request.status = "cancelled"; request.updatedAt = now().toISOString(); request.message = "Device access was revoked. Request fresh approval to reconnect.";
    delete request.codeHash; delete request.codeNonce;
  }
  command.device = target;
  command.customerId = voucher.customerId;
  return { status: 202, body: { operation: disconnectView(command), ...wifiDeviceView(s, voucher) } };
}
