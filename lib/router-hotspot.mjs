import { RouterRest, quoteRouter } from "./network-router.mjs";
import { routerVoucherPayload } from "./routeros.mjs";

// Restricted bridge implementation: only NDAHI-owned Hotspot resources can
// be mutated. Device disconnection requires a trusted MAC address, not a
// browser-generated local-storage identifier.
export class RouterHotspot extends RouterRest {
  async upsert(path, name, values) {
    const rows = await this.request(path), existing = rows.filter((r) => r.name === name);
    if (existing.length > 1 || existing.some((r) => r.comment !== values.comment)) throw Error("Conflicting unmanaged Hotspot resource.");
    return this.request(path + (existing[0] ? `/${encodeURIComponent(existing[0][".id"])}` : ""), existing[0] ? "PATCH" : "PUT", { name, ...values });
  }
  async syncVoucher(voucher) { return this.syncPayload(routerVoucherPayload(voucher)); }
  async syncPayload(payload) {
    const p = payload;
    if (p.schemaVersion !== 1 || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.voucherId || "") || !/^NC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(p.username || "") || p.password !== p.username || !Number.isInteger(p.simultaneousUsers) || p.simultaneousUsers < 1 || p.simultaneousUsers > 100 || !Number.isFinite(Date.parse(p.expiresAt)) || (p.limitBytesTotal !== null && (!Number.isSafeInteger(p.limitBytesTotal) || p.limitBytesTotal < 0)) || typeof p.enabled !== "boolean") throw Error("Invalid voucher enforcement payload.");
    const comment = `ndahi:voucher:${p.voucherId}`, profile = `ndahi-users-${p.simultaneousUsers}`;
    await this.upsert("ip/hotspot/user/profile", profile, { comment: `ndahi:users:${p.simultaneousUsers}`, "shared-users": String(p.simultaneousUsers) });
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
    if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(deviceId || "")) throw Error("Device disconnection requires a trusted hotspot MAC mapping. Browser-generated device IDs cannot identify router sessions.");
    const users = new Set((await this.request("ip/hotspot/user")).filter((u) => u.comment?.startsWith("ndahi:voucher:")).map((u) => u.name));
    for (const path of ["ip/hotspot/active", "ip/hotspot/cookie"]) for (const item of await this.request(path)) {
      if (item["mac-address"]?.toLowerCase() === deviceId.toLowerCase() && users.has(item.user)) await this.request(`${path}/${encodeURIComponent(item[".id"])}`, "DELETE");
    }
    return { disconnected: true, deviceId };
  }
  async readUsage() {
    return (await this.request("ip/hotspot/user")).filter((u) => u.comment?.startsWith("ndahi:voucher:")).map((u) => ({ voucherId: u.comment.slice("ndahi:voucher:".length), usedBytes: Number(u["bytes-in"] || 0) + Number(u["bytes-out"] || 0) }));
  }
  async readState() {
    const users = (await this.request("ip/hotspot/user")).filter((u) => u.comment?.startsWith("ndahi:voucher:"));
    // The application currently uses browser IDs. Do not claim MAC sessions
    // are equivalent or mark unrelated customer sessions inactive.
    return { vouchers: users.map((u) => ({ voucherId: u.comment.slice("ndahi:voucher:".length), enabled: u.disabled !== "true" })), sessions: null };
  }
  async markInactive() {
    const users = (await this.request("ip/hotspot/user")).filter((u) => u.comment?.startsWith("ndahi:voucher:") && u.disabled === "true");
    for (const u of users) await this.disconnectVoucher(u.comment.slice("ndahi:voucher:".length));
    return { synchronized: true };
  }
}
