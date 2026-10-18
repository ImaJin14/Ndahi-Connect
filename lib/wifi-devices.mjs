import { createHash } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";

export const liveRouter = (s, env = {}) => s.networkSetup?.runtimeRouterEnabled === true || env.MIKROTIK_MODE === "live";
const pending = (c) => ["queued", "processing", "retry"].includes(c.status);
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
  const commands = (s.routerCommands || []).filter((c) => c.action === "disconnect_wifi_device" && c.device?.voucherId === voucher?.id);
  const disconnects = commands.slice(-20).map(disconnectView);
  return {
    deviceLimit: voucher?.deviceLimit ?? null,
    devices: (voucher?.wifiDevices || []).map((d) => {
      const c = commands.findLast((c) => c.device.sessionId === d.sessionId && c.device.mac === d.mac &&
        c.device.startedAt === d.startedAt && (pending(c) || c.status === "dead_letter"));
      return { ...d, ...(c ? { disconnect: disconnectView(c) } : {}) };
    }),
    syncedAt: voucher?.wifiDevicesAt || null,
    disconnects,
  };
}
export function requestWifiDisconnect(s, voucher, input, now = () => new Date()) {
  const mac = String(input.mac || "").toUpperCase();
  const device = voucher?.wifiDevices?.find((d) => d.mac === mac && (!input.sessionId || input.sessionId === d.sessionId));
  if (!device) return { status: 404, body: { error: "That device is no longer connected. Refresh the list." } };
  if (!device.sessionId || !Number.isFinite(Date.parse(device.startedAt)) ||
      !Number.isFinite(Date.parse(voucher.wifiDevicesAt)) || +now() - Date.parse(voucher.wifiDevicesAt) > 120000) {
    return { status: 409, body: { code: "DEVICE_REFRESH_REQUIRED", error: "A fresh router reading is required before disconnecting this device. Refresh the list in a moment." } };
  }
  const target = { voucherId: voucher.id, username: voucher.code, mac, sessionId: device.sessionId, startedAt: device.startedAt };
  const targetId = createHash("sha256").update(JSON.stringify(target)).digest("hex").slice(0, 32);
  const command = enqueueRouterCommand(s, { action: "disconnect_wifi_device", targetId }, now);
  command.device = target;
  command.customerId = voucher.customerId;
  return { status: 202, body: { operation: disconnectView(command), ...wifiDeviceView(s, voucher) } };
}
