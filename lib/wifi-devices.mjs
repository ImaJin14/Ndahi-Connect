import { createHash } from "node:crypto";
import { enqueueRouterCommand } from "./router-queue.mjs";
import { isMainDevice, mainDeviceView, deviceName } from "./device-identities.mjs";
import { deviceGrant, deviceRevocation } from "./wifi-approval.mjs";
import { routerRevision } from "./device-identities.mjs";
import { invalidateAppDevice } from "./wifi-app-associations.mjs";
import { isPersonalUnlimited, occupiedSlots } from "./device-slots.mjs";
import { currentHome } from "./home.mjs";
import { doualaDay, usedToday } from "./session-day.mjs";

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
// Live devices, one row per customer (#381; owner, 24 Nov; canvas
// AdminDevices). Each customer's devices from the last router reading, with
// what their bundle allows: slots for Personal Unlimited, the device rule of an
// older plan, one router for Home WISP (NDAHI can't see the devices behind it).
// A session on a code with no account shows by its code. `names` and `codes`
// follow the caller's access; `planOf` gives a bundle's purchased terms.
export function adminWifiCustomers(s, now = new Date(), { names = true, codes = true, planOf = () => null } = {}) {
  const rows = new Map(), today = doualaDay(now);
  for (const v of s.vouchers.filter((v) => v.status === "active")) {
    const home = v.accessMode === "home";
    let devices = [];
    if (home) {
      // The Home reading (every 15 s) says whether the registered router is on.
      if (v.homeStatus === "connected") devices = [{ id: `home:${v.id}`, router: true, mac: currentHome(s, v.customerId)?.mac || null, slot: null,
        startedAt: v.homeOnlineSince || null, todayBytes: v.homeDay?.date === today ? Math.max(0, (v.usedBytes || 0) - (v.homeDay.bytes || 0)) : 0, fresh: freshReading(v.lastUsageSyncAt, now) }];
    } else {
      const slots = isPersonalUnlimited(v) ? occupiedSlots(s, v) : [];
      devices = wifiDeviceView(s, v).devices.map((d) => ({ id: JSON.stringify([v.id, d.mac, d.sessionId, d.startedAt]), name: d.name || null, mac: d.mac,
        slot: slots.indexOf(d.mac) + 1 || null, sessionId: d.sessionId || null, startedAt: d.startedAt || null, todayBytes: usedToday(d, now),
        fresh: freshReading(v.wifiDevicesAt, now), ...(d.main ? { main: true } : {}), ...(d.disconnect ? { disconnect: d.disconnect } : {}) }));
    }
    if (!devices.length) continue;
    const key = v.customerId || `voucher:${v.id}`, plan = planOf(v) || {};
    if (!rows.has(key)) rows.set(key, {
      id: key, voucherId: v.id, customerId: v.customerId || null,
      name: v.customerId && names ? s.customers?.find((c) => c.id === v.customerId)?.name || null : null,
      // For "Name, number or voucher code"; contact data, so only with names.
      phone: v.customerId && names ? s.customers?.find((c) => c.id === v.customerId)?.phone || null : null,
      code: !v.customerId && codes ? v.code || null : null,
      accessType: v.accessType || null, planName: plan.name || null, validityHours: v.validityHours ?? plan.validityHours ?? null,
      slots: isPersonalUnlimited(v) ? v.deviceSlots || v.deviceLimit || 1 : null, router: home, endsAt: v.expiresAt || null, devices: [],
    });
    rows.get(key).devices.push(...devices);
  }
  // Most devices first, then the longest online, as drawn.
  return [...rows.values()].map((row) => ({ ...row, todayBytes: row.devices.reduce((sum, d) => sum + d.todayBytes, 0),
    since: row.devices.map((d) => d.startedAt).filter(Boolean).sort()[0] || null }))
    .sort((a, b) => b.devices.length - a.devices.length || String(a.since).localeCompare(String(b.since)));
}
export function adminWifiSummary(s, now = new Date()) {
  // A Home WISP bundle is read by the Home worker, never by this reading, so
  // it would count as unread for ever and mark every reading stale (#381).
  const vouchers = s.vouchers.filter((v) => v.status === "active" && v.accessMode !== "home"), devices = observedWifiDevices(s, now);
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
    mainDevice: voucher?.status === "active" && voucher.deviceLimit > 1 ? mainDeviceView(s, customer) : null,
    approvedDevices: customer ? (s.wifiDeviceGrants || []).filter((g) => g.customerId === customer.id &&
      (g.status === "approved" || deviceRevocation(s, customer.id, g.mac))).map((g) => {
        const nickname = customer.deviceNicknames?.[g.mac] || "";
        return { id: g.id, mac: g.mac, nickname, name: nickname || deviceName(g.name),
          main: voucher?.status === "active" && voucher.deviceLimit > 1 && customer.wifiMainDevice?.mac === g.mac && customer.wifiMainDevice.routerRevision === g.routerRevision,
          routerChanged: g.routerRevision !== routerRevision(s), removal: deviceRevocation(s, customer.id, g.mac)?.status };
      }) : [],
    devices: (voucher?.wifiDevices || []).map((d) => {
      const main = voucher?.status === "active" && voucher.deviceLimit > 1 && isMainDevice(s, customer, d.mac), announced = deviceName(d.name);
      const nickname = customer?.deviceNicknames?.[d.mac] || "";
      const name = nickname || announced || deviceName(customer && deviceGrant(s, customer.id, d.mac)?.name) || (main ? deviceName(customer.wifiMainDevice.name) : "");
      const { name: _rawName, ...device } = d;
      const c = commands.findLast((c) => c.device.sessionId === d.sessionId && c.device.mac === d.mac &&
        c.device.startedAt === d.startedAt && (pending(c) || c.status === "dead_letter"));
      return { ...device, nickname, ...(name ? { name, ...(!announced && !nickname ? { nameLastReported: true } : {}) } : {}), ...(main ? { main: true } : {}), ...(c ? { disconnect: disconnectView(c) } : {}) };
    }),
    syncedAt: voucher?.wifiDevicesAt || null,
    disconnects,
  };
}
export function requestWifiDisconnect(s, voucher, input, now = () => new Date(), { ownerVerified = false, retainApproval = false } = {}) {
  const mac = String(input.mac || "").toUpperCase();
  if (retainApproval && (!input.sessionId || !Number.isFinite(Date.parse(input.startedAt)))) return { status: 400, body: { error: "An exact current session is required to end a connection." } };
  const device = voucher?.wifiDevices?.find((d) => d.mac === mac && (!input.sessionId || input.sessionId === d.sessionId) &&
    (!input.startedAt || input.startedAt === d.startedAt));
  if (!device) return { status: 404, body: { error: "That device is no longer connected. Refresh the list." } };
  if (!ownerVerified && isMainDevice(s, s.customers?.find((c) => c.id === voucher.customerId), mac, now())) {
    return { status: 403, body: { code: "MAIN_DEVICE_VERIFICATION_REQUIRED", error: "Verify account ownership before disconnecting the main device." } };
  }
  if (!device.sessionId || !Number.isFinite(Date.parse(device.startedAt)) ||
      !freshReading(voucher.wifiDevicesAt, now())) {
    return { status: 409, body: { code: "DEVICE_REFRESH_REQUIRED", error: "A fresh router reading is required before disconnecting this device. Refresh the list in a moment." } };
  }
  const connections = (s.wifiPairingRequests || []).filter((p) => p.customerId === voucher.customerId && p.mac === mac && p.status === "connecting");
  if (connections.some((p) => s.routerCommands.some((c) => c.id === p.commandId && c.status === "processing"))) return { status: 409, body: { error: "Wait for the pending connection to finish before disconnecting." } };
  const target = { voucherId: voucher.id, username: voucher.code, mac, sessionId: device.sessionId, startedAt: device.startedAt, ...(retainApproval ? { retainApproval: true } : {}) };
  const targetId = createHash("sha256").update(JSON.stringify(target)).digest("hex").slice(0, 32);
  const command = enqueueRouterCommand(s, { action: "disconnect_wifi_device", targetId }, now);
  // Older API workers would revoke approval when handling a disconnect. Keep
  // these jobs invisible to them throughout a rolling deployment.
  if (retainApproval) command.kind = "wifi_session_disconnect";
  for (const grant of s.wifiDeviceGrants || []) if (!retainApproval && grant.customerId === voucher.customerId && grant.mac === mac) {
    grant.status = "revoked"; grant.revokedAt = now().toISOString();
    invalidateAppDevice(s, voucher.customerId, mac, now());
  }
  for (const request of s.wifiPairingRequests || []) if (request.customerId === voucher.customerId && request.mac === mac && ["pending", "awaiting_code", "connecting"].includes(request.status)) {
    request.status = "cancelled"; request.updatedAt = now().toISOString(); request.message = retainApproval ? "Connection cancelled because this device was explicitly disconnected." : "Device access was revoked. Request fresh approval to reconnect.";
    delete request.codeHash; delete request.codeNonce;
    const queued = s.routerCommands.find((c) => c.id === request.commandId);
    if (queued && ["queued", "retry"].includes(queued.status)) { queued.status = "processed"; queued.result = "cancelled"; queued.processedAt = now().toISOString(); queued.nextAttemptAt = null; }
  }
  command.device = target;
  command.customerId = voucher.customerId;
  return { status: 202, body: { operation: disconnectView(command), ...wifiDeviceView(s, voucher) } };
}
