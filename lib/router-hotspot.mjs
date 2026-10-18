import { RouterRest, quoteRouter } from "./network-router.mjs";
import { routerVoucherPayload } from "./routeros.mjs";

const MAC = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i;
const profileName = (limit) => `ndahi-users-${limit}-presence-v1`;
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
  constructor(options = {}) { super(options); this.now = options.now || (() => new Date()); }
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
    const comment = `ndahi:voucher:${p.voucherId}`, profile = profileName(p.simultaneousUsers);
    await this.ensureUserProfile(profile, String(p.simultaneousUsers));
    const enabled = p.enabled && Date.parse(p.expiresAt) > Date.now() && p.limitBytesTotal !== 0;
    // Install the expiry guard BEFORE enabling credentials. It operates even
    // when the backend is unreachable; router clock/NTP must be correct.
    const seconds = Math.floor(Date.parse(p.expiresAt) / 1000), user = quoteRouter(p.username);
    const guard = `:if ([:timestamp] >= [:totime ${quoteRouter(seconds + "s")}]) do={/ip hotspot user disable [find where comment=${quoteRouter(comment)}]; /ip hotspot active remove [find where user=${user}]; /ip hotspot cookie remove [find where user=${user}]}`;
    await this.upsert("system/scheduler", `ndahi-expiry-${p.voucherId}`, { comment, interval: "00:00:30", "on-event": guard, policy: "read,write,policy,test" });
    await this.upsert("ip/hotspot/user", p.username, { comment, password: p.password, profile, server: "ndahi-hotspot", "limit-bytes-total": String(p.limitBytesTotal ?? 0), disabled: enabled ? "false" : "true" });
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
  // RouterOS adds a session's traffic to its user's counters only at logout,
  // and limits each concurrent session separately, so total usage must include
  // live sessions. Users are read first: a session ending between the two reads
  // is briefly missed rather than counted twice.
  async readUsage() {
    const users = (await this.request("ip/hotspot/user")).filter((u) => u.comment?.startsWith("ndahi:voucher:")),
      sessions = await this.request("ip/hotspot/active"),
      bytes = (row) => Number(row["bytes-in"] || 0) + Number(row["bytes-out"] || 0);
    return users.map((u) => {
      const live = sessions.filter((x) => x.user === u.name);
      return {
        voucherId: u.comment.slice("ndahi:voucher:".length),
        usedBytes: live.reduce((total, x) => total + bytes(x), bytes(u)),
        devices: live.filter((x) => MAC.test(x["mac-address"] || "")).map((x) => ({
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
      const limit = u.profile?.match(/^ndahi-users-(\d+)-presence-v1$/)?.[1];
      return { voucherId: u.comment.slice("ndahi:voucher:".length), enabled: u.disabled !== "true",
        sessionPolicyReady: Boolean(limit && hasPresencePolicy(profiles.find((p) => p.name === u.profile), limit)) };
    }), sessions: null };
  }
  async markInactive() {
    const users = (await this.request("ip/hotspot/user")).filter((u) => u.comment?.startsWith("ndahi:voucher:") && u.disabled === "true");
    for (const u of users) await this.disconnectVoucher(u.comment.slice("ndahi:voucher:".length));
    return { synchronized: true };
  }
}
