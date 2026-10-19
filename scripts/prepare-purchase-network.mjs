import { resolve4 } from "node:dns/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteRouter } from "../lib/network-router.mjs";

function origin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
      isIP(url.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(url.hostname))
    throw Error("Portal and API must be HTTPS origins with hostnames and no path, custom port or credentials.");
  return url;
}
const localIPv4 = (ip) => {
  const [a, b, c] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113);
};
const nameOk = (name) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,39}$/.test(name || "");
const header = "# Generated review files only. This tool never connects to or changes a router.\n";

// Main-table /32 routes and TCP 443 walled-garden exceptions apply to guests
// before authentication as well as after it. No trial or IP-binding bypass.
export async function preparePurchaseNetwork({ portal, api, gateway, tunnel, server = "ndahi-hotspot" }, lookup = resolve4) {
  const origins = [origin(portal), origin(api)], hosts = [...new Set(origins.map((url) => url.hostname))];
  if (isIP(gateway) !== 4 || !nameOk(tunnel) || !nameOk(server)) throw Error("Provide an IPv4 tunnel gateway and valid tunnel/HotSpot interface names.");
  const results = await Promise.allSettled(hosts.map(async (host) => {
    const addresses = await lookup(host);
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some((ip) => isIP(ip) !== 4 || localIPv4(ip)))
      throw Error(`Refusing non-public or invalid A records for ${host}.`);
    return { host, addresses: [...new Set(addresses)].sort() };
  }));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  const destinations = results.map((r) => r.value), addresses = [...new Set(destinations.flatMap((d) => d.addresses))].sort();
  const fingerprint = createHash("sha256").update(JSON.stringify({ destinations, gateway, tunnel, server })).digest("hex").slice(0, 12);
  const prefix = `ndahi:purchase:${fingerprint}`, q = quoteRouter;
  const checks = [
    "/system resource print", "/system device-mode print", "/ip hotspot print detail",
    "/ip hotspot host print detail", "/ip hotspot walled-garden ip print detail",
    "/ip firewall mangle print detail", "/routing rule print detail", "/ip firewall filter print stats",
    "/ip firewall nat print stats", "/ipv6 nd print detail", "/ipv6 firewall filter print stats",
    "/interface wireguard peers print detail proplist=interface,last-handshake,rx,tx",
    ...destinations.map(({ host }) => `:put [:resolve ${q(host)}]`),
    ...addresses.map((ip) => `/ip route print detail where dst-address=${q(ip + "/32")}`),
  ].join("\n") + "\n";
  const commands = [], undo = [];
  const add = (path, values, tag) => {
    const comment = `${prefix}:${tag}`, where = `[${path} find where comment=${q(comment)}]`;
    // Never silently accept a changed rule bearing our tag.
    const compare = Object.entries(values).filter(([key]) => key !== "disabled").map(([key, value]) => {
      if (key === "blackhole") return value === "yes" ? `(![${path} get $item blackhole])` : `([${path} get $item blackhole])`;
      if (key === "dst-address") return `(([:tostr [${path} get $item ${key}]] != ${q(value)}) && ([:tostr [${path} get $item ${key}]] != ${q(value.replace(/\/32$/, ""))}))`;
      return `([:tostr [${path} get $item ${key}]] != ${q(value)})`;
    }).join(" || ");
    commands.push(`:if ([:len ${where}] = 0) do={ ${path} add ${Object.entries(values).map(([k, v]) => k === "blackhole" ? v === "yes" ? "blackhole" : "" : `${k}=${q(v)}`).filter(Boolean).join(" ")} comment=${q(comment)} }`);
    undo.unshift(`:foreach item in=${where} do={ ${path} remove $item }`);
    return `:if ([:len ${where}] > 1) do={ :error ${q("Duplicate managed entry: " + comment)} }; :foreach item in=${where} do={ :if (${compare} || [${path} get $item disabled]) do={ :error ${q("Changed managed entry: " + comment)} } }`;
  };
  const preflight = [
    `:if ([:pick [/system resource get version] 0 2] != "7.") do={ :error "RouterOS 7 required" }`,
    `:if ([:len [/ip hotspot find where name=${q(server)} disabled=no]] != 1) do={ :error "Expected one enabled HotSpot server" }`,
    `:if ([:len [/interface wireguard find where name=${q(tunnel)} disabled=no]] != 1) do={ :error "Expected enabled WireGuard interface" }`,
  ];
  for (const [index, ip] of addresses.entries()) {
    const dst = ip + "/32";
    preflight.push(`:foreach item in=[/ip route find where dst-address=${q(dst)} routing-table=main disabled=no] do={ :if (![/ip route get $item blackhole]) do={ :local hop [:tostr [/ip route get $item gateway]]; :if (($hop != ${q(gateway)}) && ($hop != ${q(gateway + "%" + tunnel)})) do={ :error ${q("Conflicting main-table route for " + ip + "; review before applying")} } } }`);
    preflight.push(add("/ip route", { "dst-address": dst, gateway: `${gateway}%${tunnel}`, "routing-table": "main", blackhole: "no", distance: "1", disabled: "no" }, `route-${index}`));
    preflight.push(add("/ip route", { "dst-address": dst, "routing-table": "main", blackhole: "yes", distance: "254", disabled: "no" }, `guard-${index}`));
    preflight.push(add("/ip hotspot walled-garden ip", { server, action: "accept", protocol: "tcp", "dst-port": "443", "dst-address": dst, disabled: "no" }, `https-${index}`));
  }
  const apply = header + "# Run checks.rsc first, review routing policies, then use wired Safe Mode.\n{\n" +
    preflight.join("\n") + "\n# All preflight checks above run before any configuration changes.\n" + commands.join("\n") + "\n}\n";
  const rollback = header + `# Removes only entries tagged ${prefix}. Existing entries are preserved.\n` + undo.join("\n") + "\n";
  const readme = `# Unpaid Wi-Fi purchase access\n\nPortal: ${origins[0].origin}\nAPI: ${origins[1].origin}\nResolved IPv4 destinations: ${addresses.join(", ")}\nTunnel: ${tunnel}; next hop: ${gateway}; HotSpot: ${server}\nPlan tag: ${prefix}\n\n` +
    "These files are a DNS snapshot. Regenerate and compare DNS immediately before applying, and whenever the portal/API destinations change. The tool does not read .env, contact a router, disable coverage checks, or change any device.\n\n" +
    "1. From a wired management session, run checks.rsc (read-only). Review main-table routes, guest routing rules, mangle rules, tunnel health, walled-garden exceptions and drop counters. Portal/API routing must apply before HotSpot authentication; a rule matching only hotspot=auth cannot provide unpaid purchase access. Verify DNS on the actual guest network agrees with this snapshot.\n" +
    "2. Check that the cloud gateway accepts and NATs guest traffic from the existing guest subnet and returns it over the tunnel. Keep the existing NAT design. Confirm no source policy or routing mark overrides these main-table routes. Resolve conflicting firewall/routing rules locally before applying; this script does not overwrite them.\n" +
    "3. Review apply.rsc and rollback.rsc, save your router backup, and enter Safe Mode. On a supported router, run /import file-name=apply.rsc verbose=yes dry-run before /import file-name=apply.rsc verbose=yes. The file adds only main-table /32 tunnel routes, fallback blackholes, and TCP 443 IP walled-garden exceptions for the listed destinations/server. It preserves existing rules and refuses conflicting exact main-table routes. Tagged entries must match on repeat imports.\n" +
    "4. On a phone, disable mobile data, forget/login out of the test HotSpot session, join guest Wi-Fi and accept Use without internet. Without an active voucher, open the portal, then the API's /api/purchase/access. It must report allowed:true. Repeat with expired and exhausted test vouchers. Browsing packages and requesting payment must work; unrelated internet must remain blocked until paid access is activated. Use designated test/provider sandbox accounts.\n" +
    "5. Off Wi-Fi, /api/purchase/access must report allowed:false. Simulate tunnel loss and confirm portal/API requests cannot fall back to direct ISP egress. Restore the tunnel and verify a new unpaid request. Keep Safe Mode only after all checks pass; rollback.rsc removes this plan's tagged additions if needed.\n\n" +
    "IP walled-garden exceptions can also allow HTTPS sites sharing these destination IPs. They are limited to TCP 443 and the named HotSpot, but are not hostname isolation. Review that tradeoff on shared hosting; do not whitelist entire CDN ranges, captive-check sites or all destinations. Guest IPv6 must remain blocked as required by this site's IPv4 HotSpot design.\n\n" +
    "The backend gate uses the trusted cloud egress address, independently of voucher balance. Keep COVERAGE_ACCESS_ENABLED=true and its fixed gateway allowlist. If mobile data is off and allowed remains false, trace the pre-auth API connection through routing/NAT; an application login or temporary free-data bypass does not fix its route.\n";
  return { destinations, addresses, prefix, checks: header + checks, apply, rollback, readme };
}

async function main() {
  const options = {}, args = process.argv.slice(2), valid = new Set(["portal", "api", "gateway", "tunnel", "server", "output"]);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, ""), value = args[i + 1];
    if (!args[i].startsWith("--") || !valid.has(name) || !value || value.startsWith("--") || options[name] !== undefined) throw Error("Provide --portal --api --gateway --tunnel --server --output with explicit values.");
    options[name] = value;
  }
  if (!options.output) throw Error("Provide --output for a new directory of review files.");
  const plan = await preparePurchaseNetwork(options), output = resolve(options.output);
  await mkdir(output, { recursive: false });
  for (const [name, contents] of Object.entries({ "checks.rsc": plan.checks, "apply.rsc": plan.apply, "rollback.rsc": plan.rollback, "README.md": plan.readme }))
    await writeFile(resolve(output, name), contents, { flag: "wx" });
  console.log(`Prepared ${plan.addresses.length} IPv4 destinations in ${output}. Review README.md; no router changes were made.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
