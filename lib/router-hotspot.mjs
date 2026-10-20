import { RouterRest, quoteRouter } from "./network-router.mjs";
import { routerVoucherPayload } from "./routeros.mjs";
import { deviceName } from "./device-identities.mjs";
import { isIP } from "node:net";
import { privateWifiPassword } from "./wifi-approval.mjs";

const MAC = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i;
const connectionError = (message, code) => Object.assign(Error(message), { code, permanent: true });
const profileName = (limit, approvalRequired = false) => `ndahi-users-${limit}-${approvalRequired ? "approval" : "presence"}-v1`;
export function routerSeconds(value) {
  if (value === "none" || value === "0" || value === "0s") return 0;
  const text = String(value || "");
  if (/^(?:\d+w)?(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(text) && text) {
    return [...text.matchAll(/(\d+)([wdhms])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * ({ w: 604800, d: 86400, h: 3600, m: 60, s: 1 })[unit], 0);
  }
  const clock = text.match(/^(?:(\d+)d)?(\d+):(\d{2}):(\d{2})$/);
  return clock ? Number(clock[1] || 0) * 86400 + Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]) : null;
}
const hasPresencePolicy = (p, limit) => p && String(p["shared-users"]) === String(limit) &&
  routerSeconds(p["keepalive-timeout"]) === 120 && routerSeconds(p["idle-timeout"]) === 0;

// Restricted bridge implementation: only NDAHI-owned Hotspot resources can
// be mutated. Device disconnection requires a trusted MAC address, not a
// browser-generated local-storage identifier.
export class RouterHotspot extends RouterRest {
  constructor(options = {}) { super(options); this.now = options.now || (() => new Date()); this.approvalKey = options.approvalKey; }
  startedAt(session) {
    const seconds = routerSeconds(session.uptime);
    return seconds === null ? null : new Date(+this.now() - seconds * 1000).toISOString();
  }
  async upsert(path, name, values) {
    const rows = await this.request(path), existing = rows.filter((r) => r.name === name);
    if (existing.length > 1 || existing.some((r) => r.comment !== values.comment)) throw Error("Conflicting unmanaged Hotspot resource.");
    return this.request(path + (existing[0] ? `/${encodeURIComponent(existing[0][".id"])}` : ""), existing[0] ? "PATCH" : "PUT", { name, ...values });
  }
  // RouterOS rejects comments on HotSpot user profiles, so the reserved name is
  // the ownership marker. Create a missing profile; reuse an existing one only
  // when it already has the expected limit, and never modify it.
  async ensureUserProfile(name, sharedUsers) {
    const existing = (await this.request("ip/hotspot/user/profile")).filter((r) => r.name === name);
    if (existing.length > 1 || existing.some((r) => !hasPresencePolicy(r, sharedUsers))) throw Error("Conflicting unmanaged Hotspot resource.");
    if (!existing.length) await this.request("ip/hotspot/user/profile", "PUT", { name, "shared-users": sharedUsers, "keepalive-timeout": "2m", "idle-timeout": "none" });
  }
  async syncVoucher(voucher) { return this.syncPayload(routerVoucherPayload(voucher)); }
  async syncPayload(payload) {
    const p = payload;
    if (p.schemaVersion !== 1 || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.voucherId || "") || !/^NC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(p.username || "") || p.password !== p.username || !Number.isInteger(p.simultaneousUsers) || p.simultaneousUsers < 1 || p.simultaneousUsers > 100 || !Number.isFinite(Date.parse(p.expiresAt)) || (p.limitBytesTotal !== null && (!Number.isSafeInteger(p.limitBytesTotal) || p.limitBytesTotal < 0)) || typeof p.enabled !== "boolean") throw Error("Invalid voucher enforcement payload.");
    const comment = `ndahi:voucher:${p.voucherId}`, profile = profileName(p.simultaneousUsers, p.approvalRequired);
    await this.ensureUserProfile(profile, String(p.simultaneousUsers));
    const enabled = p.enabled && Date.parse(p.expiresAt) > Date.now() && p.limitBytesTotal !== 0;
    // Install the expiry guard BEFORE enabling credentials. It operates even
    // when the backend is unreachable; router clock/NTP must be correct.
    const seconds = Math.floor(Date.parse(p.expiresAt) / 1000), user = quoteRouter(p.username);
    const guard = `:if ([:timestamp] >= [:totime ${quoteRouter(seconds + "s")}]) do={/ip hotspot user disable [find where comment=${quoteRouter(comment)}]; /ip hotspot active remove [find where user=${user}]; /ip hotspot cookie remove [find where user=${user}]}`;
    await this.upsert("system/scheduler", `ndahi-expiry-${p.voucherId}`, { comment, interval: "00:00:30", "on-event": guard, policy: "read,write,policy,test" });
    const password = p.approvalRequired ? privateWifiPassword(p.voucherId, this.approvalKey) : p.password;
    if (p.approvalRequired) {
      const old = (await this.request("ip/hotspot/user")).find((u) => u.name === p.username);
      // Invalidate remembered public credentials when changing policy.
      if (old?.profile !== profile) for (const row of await this.request("ip/hotspot/cookie")) {
        if (row.user === p.username) await this.request(`ip/hotspot/cookie/${encodeURIComponent(row[".id"])}`, "DELETE");
      }
    }
    await this.upsert("ip/hotspot/user", p.username, { comment, password, profile, server: "ndahi-hotspot", "limit-bytes-total": String(p.limitBytesTotal ?? 0), disabled: enabled ? "false" : "true" });
    if (!enabled) await this.disconnectVoucher(p.voucherId);
    return { synchronized: true, mode: "live", voucherId: p.voucherId };
  }
  async disconnectVoucher(voucherId) {
    const users = (await this.request("ip/hotspot/user")).filter((u) => u.comment === `ndahi:voucher:${voucherId}`);
    for (const user of users) {
      await this.request(`ip/hotspot/user/${encodeURIComponent(user[".id"])}`, "PATCH", { disabled: "true" });
      for (const path of ["ip/hotspot/active", "ip/hotspot/cookie"]) for (const item of await this.request(path)) {
        if (item.user === user.name) await this.request(`${path}/${encodeURIComponent(item[".id"])}`, "DELETE");
      }
    }
    return { disconnected: true, voucherId };
  }
  async disconnectDevice(deviceId) {
    if (!MAC.test(deviceId || "")) throw Error("Device disconnection requires a trusted hotspot MAC mapping. Browser-generated device IDs cannot identify router sessions.");
    throw Object.assign(Error("This legacy disconnect is not scoped to a router session. Refresh the device list and try again."), { code: "UNSCOPED_DISCONNECT" });
  }
  async disconnectWifiDevice(device) {
    if (!device || !MAC.test(device.mac || "") || !device.sessionId || !Number.isFinite(Date.parse(device.startedAt)) ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(device.voucherId || "") || !/^NC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(device.username || "")) throw Error("A trusted voucher and router session mapping is required.");
    const users = await this.request("ip/hotspot/user");
    if (!users.some((u) => u.name === device.username && u.comment === `ndahi:voucher:${device.voucherId}`)) {
      return { confirmed: true, outcome: "superseded" };
    }
    const sameDevice = (s) => s.user === device.username && s["mac-address"]?.toUpperCase() === device.mac.toUpperCase();
    const sameSession = (s) => sameDevice(s) && s[".id"] === device.sessionId &&
      Math.abs(Date.parse(this.startedAt(s)) - Date.parse(device.startedAt)) <= 5000;
    let sessions = (await this.request("ip/hotspot/active")).filter(sameDevice);
    if (sessions.some((s) => !sameSession(s))) return { confirmed: true, outcome: "superseded" };
    // Clear remembered login before removing the session. If a new session is
    // seen on a retry, leave its cookie and active row untouched.
    for (const item of await this.request("ip/hotspot/cookie")) if (sameDevice(item)) {
      await this.request(`ip/hotspot/cookie/${encodeURIComponent(item[".id"])}`, "DELETE");
    }
    // Read again after cookie work to avoid acting on a session replaced meanwhile.
    sessions = (await this.request("ip/hotspot/active")).filter(sameDevice);
    if (sessions.some((s) => !sameSession(s))) return { confirmed: true, outcome: "superseded" };
    const existed = sessions.length > 0;
    for (const session of sessions) await this.request(`ip/hotspot/active/${encodeURIComponent(session[".id"])}`, "DELETE");
    const remaining = (await this.request("ip/hotspot/active")).filter(sameDevice);
    if (remaining.some(sameSession)) throw Error("The router still reports this session as active.");
    return { confirmed: true, outcome: remaining.length ? "superseded" : existed ? "disconnected" : "absent" };
  }
  async readGuestDevice(input) {
    const mac = String(input?.mac || "").toUpperCase(), address = String(input?.address || "");
    if (!MAC.test(mac) || isIP(address) !== 4) throw connectionError("Open the portal from the device on NDAHI Wi-Fi, or enter its Wi-Fi address details.", "INVALID_WIFI_TARGET");
    const hosts = await this.request("ip/hotspot/host");
    const matches = hosts.filter((host) => host.server === "ndahi-hotspot" && host["mac-address"]?.toUpperCase() === mac && host.address === address && host.bypassed !== "true");
    if (matches.length !== 1 || !matches[0][".id"]) throw connectionError("That device is no longer visible on NDAHI Wi-Fi. Open the portal on it and try again.", "WIFI_TARGET_CHANGED");
    const host = matches[0], loginAddress = host["to-address"] || host.address;
    if (isIP(loginAddress) !== 4) throw connectionError("Refresh the device's Wi-Fi connection and request a new code.", "WIFI_TARGET_CHANGED");
    let leases = [];
    try { leases = await this.request("ip/dhcp-server/lease", "GET", undefined, { timeoutMs: 2500 }); } catch { /* Naming is optional. */ }
    const lease = Array.isArray(leases) && leases.find((l) => l.status === "bound" &&
      (l["active-mac-address"] || l["mac-address"])?.toUpperCase() === mac && (l["active-address"] || l.address) === address);
    return { mac, address, loginAddress, hostId: host[".id"], server: "ndahi-hotspot", name: deviceName(lease?.["host-name"]) };
  }
  async connectWifiDevice(device) {
    if (!device || !MAC.test(device.mac || "") || isIP(device.address) !== 4 || !device.hostId ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(device.voucherId || "") || !/^NC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(device.username || "") ||
        !Number.isFinite(Date.parse(device.expiresAt)) || !Number.isFinite(Date.parse(device.deadline)) ||
        !Number.isInteger(device.deviceLimit) || device.deviceLimit < 1 || device.deviceLimit > 100 ||
        (device.quotaBytes !== null && (!Number.isSafeInteger(device.quotaBytes) || device.quotaBytes <= 0))) {
      throw connectionError("A verified Wi-Fi target and active bundle are required.", "INVALID_WIFI_TARGET");
    }
    // Re-read the exact guest row. Never authorize an arbitrary browser MAC/IP,
    // a reused DHCP address, another HotSpot, or another voucher's live session.
    const target = await this.readGuestDevice(device);
    if (target.hostId !== device.hostId || target.loginAddress !== device.loginAddress) throw connectionError("This device's connection changed. Request a new pairing code.", "WIFI_TARGET_CHANGED");
    const users = await this.request("ip/hotspot/user"), user = users.find((u) => u.name === device.username && u.comment === `ndahi:voucher:${device.voucherId}`);
    if (!user || user.disabled === "true" || user.server !== "ndahi-hotspot") throw connectionError("The bundle is not enabled on this router.", "BUNDLE_UNAVAILABLE");
    const sessions = await this.request("ip/hotspot/active"), onTarget = sessions.filter((s) => s["mac-address"]?.toUpperCase() === device.mac);
    const owned = (s) => s.user === device.username && s.server === "ndahi-hotspot" && s["mac-address"]?.toUpperCase() === device.mac && s.address === target.loginAddress;
    if (onTarget.some((s) => !owned(s))) throw connectionError("This device already has another Wi-Fi session. Disconnect it before pairing.", "WIFI_ALREADY_CONNECTED");
    const confirmed = (rows) => {
      const session = rows.find(owned);
      if (!session?.[".id"] || !Number.isFinite(Date.parse(this.startedAt(session)))) return null;
      return { confirmed: true, device: { mac: device.mac, name: target.name, address: session.address, sessionId: session[".id"],
        startedAt: this.startedAt(session), uptime: session.uptime || null, usedBytes: Number(session["bytes-in"] || 0) + Number(session["bytes-out"] || 0) } };
    };
    // A lost response can be confirmed without starting a second session.
    const existing = confirmed(onTarget);
    if (existing) return existing;
    if (sessions.filter((s) => s.user === device.username).length >= device.deviceLimit) throw connectionError("All device slots are in use. Disconnect another device and request a new code.", "DEVICE_LIMIT");
    const bytes = (s) => Number(s["bytes-in"] || 0) + Number(s["bytes-out"] || 0), used = sessions.filter((s) => s.user === device.username).reduce((n, s) => n + bytes(s), bytes(user));
    if (!Number.isFinite(used) || (device.quotaBytes !== null && used >= device.quotaBytes)) throw connectionError("Your bundle's data is used up. Renew before connecting another device.", "QUOTA_EXHAUSTED");
    const profiles = await this.request("ip/hotspot/user/profile");
    if (user.profile !== profileName(device.deviceLimit, device.approvalRequired) || !hasPresencePolicy(profiles.find((p) => p.name === user.profile), device.deviceLimit)) {
      throw connectionError("The router's device-limit profile needs an update before assisted connection.", "SESSION_POLICY_OUTDATED");
    }
    const remaining = Math.min(Date.parse(device.deadline), Date.parse(device.expiresAt)) - +this.now();
    if (remaining <= 2000) throw connectionError("The connection request expired. Request a new pairing code.", "PAIRING_EXPIRED");
    const password = device.approvalRequired ? privateWifiPassword(device.voucherId, this.approvalKey) : device.username;
    let failure;
    try {
      await this.request("ip/hotspot/active/login", "POST", { user: device.username, password,
        ip: target.loginAddress, "mac-address": device.mac }, { timeoutMs: Math.min(5000, remaining - 1000) });
    } catch (error) { failure = error; }
    const result = confirmed(await this.request("ip/hotspot/active"));
    if (result) return result;
    if (failure) throw failure;
    throw Error("The router has not confirmed the connection yet.");
  }
  // RouterOS adds a session's traffic to its user's counters only at logout,
  // and limits each concurrent session separately, so total usage must include
  // live sessions. Users are read first: a session ending between the two reads
  // is briefly missed rather than counted twice.
  async readUsage() {
    const leaseRead = this.request("ip/dhcp-server/lease", "GET", undefined, { timeoutMs: 2500 }).catch(() => []);
    const users = (await this.request("ip/hotspot/user")).filter((u) => u.comment?.startsWith("ndahi:voucher:")),
      sessions = await this.request("ip/hotspot/active"),
      bytes = (row) => Number(row["bytes-in"] || 0) + Number(row["bytes-out"] || 0);
    // Naming is optional: a lease-read permission failure must not stop quota
    // enforcement. Require the live MAC AND address, never hostname alone.
    const leaseRows = await leaseRead, leases = Array.isArray(leaseRows) ? leaseRows : [];
    return users.map((u) => {
      const live = sessions.filter((x) => x.user === u.name);
      return {
        voucherId: u.comment.slice("ndahi:voucher:".length),
        usedBytes: live.reduce((total, x) => total + bytes(x), bytes(u)),
        devices: live.filter((x) => MAC.test(x["mac-address"] || "")).map((x) => ({
          ...(() => {
            const lease = leases.find((l) => l.status === "bound" &&
              (l["active-mac-address"] || l["mac-address"])?.toUpperCase() === x["mac-address"].toUpperCase() &&
              (l["active-address"] || l.address) === x.address);
            const name = deviceName(lease?.["host-name"]);
            return name ? { name } : {};
          })(),
          mac: x["mac-address"].toUpperCase(), address: x.address || null, uptime: x.uptime || null, usedBytes: bytes(x),
          sessionId: x[".id"] || null, startedAt: this.startedAt(x),
        })),
      };
    });
  }
  async readState() {
    const users = (await this.request("ip/hotspot/user")).filter((u) => u.comment?.startsWith("ndahi:voucher:")),
      profiles = await this.request("ip/hotspot/user/profile");
    // The application currently uses browser IDs. Do not claim MAC sessions
    // are equivalent or mark unrelated customer sessions inactive.
    return { vouchers: users.map((u) => {
      const limit = u.profile?.match(/^ndahi-users-(\d+)-(?:presence|approval)-v1$/)?.[1];
      return { voucherId: u.comment.slice("ndahi:voucher:".length), enabled: u.disabled !== "true",
        sessionPolicyReady: Boolean(limit && hasPresencePolicy(profiles.find((p) => p.name === u.profile), limit)), approvalPolicyReady: Boolean(u.profile?.endsWith("-approval-v1")) };
    }), sessions: null };
  }
  async markInactive() {
    const users = (await this.request("ip/hotspot/user")).filter((u) => u.comment?.startsWith("ndahi:voucher:") && u.disabled === "true");
    for (const u of users) await this.disconnectVoucher(u.comment.slice("ndahi:voucher:".length));
    return { synchronized: true };
  }
}
