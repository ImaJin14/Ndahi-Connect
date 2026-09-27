import { createHash } from "node:crypto";

export const routerTables = ["interface/bridge", "interface/bridge/port", "ip/address", "ip/pool", "ip/dhcp-server", "ip/dhcp-server/network", "ip/dhcp-client", "ip/firewall/nat", "ip/firewall/filter", "ip/hotspot/profile", "ip/hotspot"];
export const quoteRouter = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`;
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function ipv4(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4 || parts.some((v) => !/^(0|[1-9]\d{0,2})$/.test(v) || Number(v) > 255)) throw Error("Enter valid IPv4 addresses.");
  return parts.reduce((n, v) => n * 256 + Number(v), 0);
}
export function subnet(value) {
  const [address, size, extra] = String(value).split("/"), prefix = Number(size), ip = ipv4(address);
  if (extra !== undefined || !/^\d{1,2}$/.test(size || "") || prefix < 8 || prefix > 30) throw Error("Use an IPv4 subnet prefix between /8 and /30.");
  const block = 2 ** (32 - prefix), start = Math.floor(ip / block) * block;
  return { address, prefix, ip, start, end: start + block - 1 };
}
const addressOf = (n) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");
export function validateRouterConfig(input) {
  const config = Object.fromEntries(["wan", "apPort", "gateway", "poolStart", "poolEnd", "dns", "hotspotName"].map((k) => [k, String(input[k] || "").trim()]));
  for (const field of ["wan", "apPort"]) if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(config[field])) throw Error("Select valid physical interfaces.");
  if (config.wan === config.apPort) throw Error("WAN and AP interfaces must be different.");
  const net = subnet(config.gateway), first = ipv4(config.poolStart), last = ipv4(config.poolEnd);
  if (net.ip <= net.start || net.ip >= net.end || first <= net.start || last >= net.end || first > last || (first <= net.ip && last >= net.ip)) throw Error("DHCP range must fit inside the subnet and exclude the gateway, network, and broadcast addresses.");
  if (!((net.start >= ipv4("10.0.0.0") && net.end <= ipv4("10.255.255.255")) || (net.start >= ipv4("172.16.0.0") && net.end <= ipv4("172.31.255.255")) || (net.start >= ipv4("192.168.0.0") && net.end <= ipv4("192.168.255.255")))) throw Error("Use a private hotspot subnet.");
  const dns = config.dns.split(",").map((v) => v.trim());
  if (!dns.length || dns.length > 3) throw Error("Enter one to three DNS server addresses.");
  dns.forEach(ipv4); config.dns = dns.join(",");
  if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(config.hotspotName)) throw Error("Enter a valid hotspot DNS name.");
  return { ...config, network: `${addressOf(net.start)}/${net.prefix}` };
}

export class RouterRest {
  constructor(connection, fetcher = fetch) { this.connection = connection; this.fetcher = fetcher; }
  async request(path, method = "GET", payload) {
    const { url, username, password } = this.connection;
    const response = await this.fetcher(`${url}/rest/${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok) throw Error(`Router request failed (${response.status}); check reachability, certificate, and service permissions.`);
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : null; } catch { throw Error("Router returned an invalid response."); }
    if (result?.error) throw Error("Router rejected the management request.");
    return result;
  }
  async discover() {
    const [resources, identity, interfaces, schedulers, ...tables] = await Promise.all([
      this.request("system/resource"), this.request("system/identity"), this.request("interface"), this.request("system/scheduler"),
      ...routerTables.map((path) => this.request(path)),
    ]);
    const resource = resources[0] || resources, id = identity[0] || identity;
    if (!/^7\./.test(resource.version || "")) throw Error("Provisioning requires RouterOS 7; this router version is unsupported.");
    return { model: resource["board-name"], version: resource.version, identity: id.name,
      interfaces: interfaces.filter((v) => v.type === "ether").map((v) => ({ name: v.name, mac: v["mac-address"], running: v.running === "true" })),
      guards: schedulers.filter((v) => v.name?.startsWith("ndahi-rollback-") && v.disabled !== "true").map((v) => v.name),
      tables: Object.fromEntries(routerTables.map((path, index) => [path, tables[index]])) };
  }
  async backup(id, password) {
    await this.request("system/backup/save", "POST", { name: `ndahi-${id}`, password, "dont-encrypt": "no" });
    return `ndahi-${id}.backup`;
  }
  async arm(id, operations) {
    const name = `ndahi-rollback-${id}`;
    const undo = [...operations].reverse().map((op) => {
      const path = "/" + op.path.replaceAll("/", " ");
      const find = `[${path} find where comment=${quoteRouter(op.values.comment)}]`;
      if (op.action === "create") return `{ :local ids ${find}; :if ([:len $ids] > 0) do={${path} remove $ids} }`;
      return `{ :local ids ${find}; :if ([:len $ids] = 0) do={:error "Managed resource missing during rollback"}; ${path} set $ids ${Object.entries(op.before).map(([key, value]) => `${key}=${quoteRouter(value)}`).join(" ")} }`;
    });
    const source = [...undo, `/system scheduler remove [find where name=${quoteRouter(name)}]`, `/system scheduler remove [find where name=${quoteRouter(name + "-boot")}]`].join(";\n");
    await this.request("system/script", "PUT", { name, source, policy: "read,write,policy,test,sensitive" });
    // An on-router watchdog survives loss of the API/backend. A separate startup
    // scheduler also rolls back after a router reboot during an unconfirmed job.
    await this.request("system/scheduler", "PUT", { name, interval: "00:01:00", "on-event": `:if ([/system scheduler get [find where name=${quoteRouter(name)}] run-count] >= 10) do={/system script run ${quoteRouter(name)}}`, policy: "read,write,policy,test,sensitive" });
    await this.request("system/scheduler", "PUT", { name: name + "-boot", "start-time": "startup", interval: "0s", "on-event": name, policy: "read,write,policy,test,sensitive" });
  }
  async applyOperation(op) {
    return this.request(op.path + (op.action === "update" ? `/${encodeURIComponent(op.id)}` : ""), op.action === "update" ? "PATCH" : "PUT", op.values);
  }
  async pending(id) {
    const schedulers = await this.request("system/scheduler");
    return schedulers.some((v) => v.name === `ndahi-rollback-${id}` && v.disabled !== "true");
  }
  async confirm(id) {
    const name = `ndahi-rollback-${id}`;
    for (const item of await this.request("system/scheduler")) if ([name, name + "-boot"].includes(item.name)) await this.request(`system/scheduler/${encodeURIComponent(item[".id"])}`, "DELETE");
  }
  async rollback(id) {
    const script = (await this.request("system/script")).find((v) => v.name === `ndahi-rollback-${id}`);
    if (!script) throw Error("Rollback script is missing; restore the saved router backup locally.");
    await this.request("system/script/run", "POST", { ".id": script[".id"] });
  }
}

export function routerPlan(input, discovery, { ignoreGuard } = {}) {
  const c = validateRouterConfig(input), t = discovery.tables, operations = [], conflicts = [];
  for (const guard of discovery.guards || []) if (![ `ndahi-rollback-${ignoreGuard}`, `ndahi-rollback-${ignoreGuard}-boot` ].includes(guard)) conflicts.push(`Unresolved rollback watchdog ${guard}; recover the previous job first.`);
  for (const name of [c.wan, c.apPort]) if (!discovery.interfaces.some((v) => v.name === name)) conflicts.push(`Interface ${name} is unavailable.`);
  for (const p of t["interface/bridge/port"]) if ([c.wan, c.apPort].includes(p.interface) && !(p.interface === c.apPort && p.comment === "ndahi:ap-port")) conflicts.push(`${p.interface} already belongs to bridge ${p.bridge}; move it locally before provisioning.`);
  const net = subnet(c.gateway);
  for (const a of t["ip/address"]) {
    if (a.comment === "ndahi:address") continue;
    try { const n = subnet(a.address); if (n.start <= net.end && net.start <= n.end) conflicts.push(`Hotspot subnet overlaps ${a.address} on ${a.interface}.`); } catch { conflicts.push(`Review unsupported existing address ${a.address}.`); }
    if (a.interface === c.apPort) conflicts.push("The AP port has an existing IP address; use an unused port.");
  }
  function add(path, key, values, identity = "name") {
    const comment = `ndahi:${key}`, existing = t[path].filter((v) => v.comment === comment);
    if (existing.length > 1) { conflicts.push(`Duplicate managed resource ${key}.`); return; }
    if (values[identity] && t[path].some((v) => v[identity] === values[identity] && v.comment !== comment)) { conflicts.push(`Existing unmanaged ${path} resource conflicts with ${values[identity]}.`); return; }
    const desired = { ...values, comment }, current = existing[0];
    if (current && Object.entries(desired).every(([k, v]) => String(current[k] ?? "") === v)) return;
    operations.push({ path, action: current ? "update" : "create", ...(current ? { id: current[".id"], before: Object.fromEntries(Object.keys(desired).map((k) => [k, String(current[k] ?? "")])) } : {}), values: desired });
  }
  add("interface/bridge", "bridge", { name: "ndahi-hotspot", "protocol-mode": "rstp" });
  add("interface/bridge/port", "ap-port", { bridge: "ndahi-hotspot", interface: c.apPort }, "interface");
  add("ip/address", "address", { address: c.gateway, interface: "ndahi-hotspot" }, "address");
  add("ip/pool", "pool", { name: "ndahi-pool", ranges: `${c.poolStart}-${c.poolEnd}` });
  add("ip/dhcp-server/network", "dhcp-network", { address: c.network, gateway: net.address, "dns-server": c.dns }, "address");
  add("ip/dhcp-server", "dhcp", { name: "ndahi-dhcp", interface: "ndahi-hotspot", "address-pool": "ndahi-pool", "lease-time": "1h", disabled: "false" });
  if (!t["ip/dhcp-client"].some((v) => v.interface === c.wan && v.comment !== "ndahi:wan" && v.disabled !== "true")) add("ip/dhcp-client", "wan", { interface: c.wan, "add-default-route": "yes", "use-peer-dns": "no", disabled: "false" }, "interface");
  add("ip/firewall/nat", "nat", { chain: "srcnat", "src-address": c.network, "out-interface": c.wan, action: "masquerade" });
  add("ip/firewall/filter", "isolation", { chain: "forward", "in-interface": "ndahi-hotspot", "out-interface": "ndahi-hotspot", action: "drop" });
  add("ip/hotspot/profile", "profile", { name: "ndahi-profile", "hotspot-address": net.address, "dns-name": c.hotspotName, "login-by": "http-chap,cookie" });
  add("ip/hotspot", "hotspot", { name: "ndahi-hotspot", interface: "ndahi-hotspot", "address-pool": "ndahi-pool", profile: "ndahi-profile", disabled: "false" });
  return { config: c, operations, conflicts: [...new Set(conflicts)], fingerprint: digest({ operations, identity: discovery.identity, model: discovery.model, version: discovery.version, interfaces: discovery.interfaces.map(({ name, mac }) => ({ name, mac })) }), warnings: ["Voucher enforcement must be connected through the shipped management bridge or the saved-router activation control after provisioning.", "The AP port must be dedicated to hotspot traffic; keep management on a separate port or VPN.", "Existing firewall rules are preserved. Verify internet forwarding and management isolation during the pilot.", "Wireless client isolation must also be enabled on the AP/controller.", "Changes roll back after roughly 10 minutes unless confirmed after testing Wi-Fi access."] };
}
