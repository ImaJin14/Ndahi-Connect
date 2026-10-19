import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";

// Deliberate allowlists: RouterOS rows may also contain passwords, keys,
// scripts and free-text comments. None of those belong in a shareable report.
const tables = {
  "ip/hotspot": ["name", "interface", "profile", "disabled", "invalid"],
  "ip/hotspot/walled-garden/ip": ["server", "dst-host", "dst-address", "src-address", "protocol", "dst-port", "action", "disabled", "invalid", "dynamic"],
  "ip/route": ["dst-address", "gateway", "immediate-gw", "routing-table", "distance", "active", "inactive", "blackhole", "disabled"],
  "routing/rule": ["src-address", "dst-address", "interface", "action", "table", "disabled"],
  "ip/firewall/mangle": ["chain", "action", "in-interface", "out-interface", "src-address", "dst-address", "src-address-list", "dst-address-list", "hotspot", "new-routing-mark", "routing-mark", "passthrough", "disabled"],
  "ip/firewall/nat": ["chain", "action", "in-interface", "out-interface", "out-interface-list", "src-address", "dst-address", "dst-address-list", "disabled"],
  "ip/firewall/filter": ["chain", "action", "in-interface", "out-interface", "src-address", "dst-address", "dst-address-list", "hotspot", "packets", "disabled"],
  "interface/wireguard": ["name", "running", "disabled"],
  "ip/address": ["interface", "address", "disabled"],
  "system/device-mode": ["hotspot", "proxy", "flagged"],
  "ipv6/nd": ["interface", "disabled"],
  "ipv6/firewall/filter": ["chain", "action", "in-interface", "out-interface", "src-address", "dst-address", "disabled"],
  "ip/dns/cache": ["name", "type", "data", "ttl"],
};
const yes = (v) => [true, "true", "yes"].includes(v);
const enabled = (r) => !yes(r.disabled) && !yes(r.invalid);
const integer = (ip) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
async function bounded(task, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Reading timed out")), ms); })]); }
  finally { clearTimeout(timer); }
}
function contains(cidr, ip) {
  if (typeof cidr !== "string" || isIP(ip) !== 4) return false;
  const [address, size = "32", extra] = cidr.split("/");
  if (extra !== undefined || isIP(address) !== 4 || !/^\d{1,2}$/.test(size) || Number(size) > 32) return false;
  const block = 2 ** (32 - Number(size));
  return Math.floor(integer(address) / block) === Math.floor(integer(ip) / block);
}

export async function inspectPurchaseNetwork(router, env, { lookup = resolve4, now = () => new Date() } = {}) {
  const origins = [env.CUSTOMER_APP_URL, env.API_URL].map((value) => {
    let url;
    try { url = new URL(value || ""); } catch { throw Error("Set CUSTOMER_APP_URL and API_URL to the production HTTPS origins before checking purchase access."); }
    const credentialLength = url.username.length + url.password.length;
    if (credentialLength || url.protocol !== "https:" || url.port || url.pathname !== "/" || url.search || url.hash)
      throw Error("Set CUSTOMER_APP_URL and API_URL to the production HTTPS origins before checking purchase access.");
    return url;
  });
  if (typeof router.request !== "function") throw Error("Purchase access checks require a saved live router REST connection.");
  const hosts = [...new Set(origins.map((url) => url.hostname))], paths = Object.keys(tables);
  const [reads, dns] = await Promise.all([
    Promise.allSettled(paths.map((path) => bounded(() => router.request(path, "GET"), 16000))),
    Promise.allSettled(hosts.map((host) => bounded(() => lookup(host), 5000))),
  ]);
  const readings = paths.map((path, index) => {
    const result = reads[index];
    if (result.status !== "fulfilled") return { path, error: "Reading unavailable. Check router connectivity and read permissions.", rows: [] };
    let rows = Array.isArray(result.value) ? result.value : result.value && typeof result.value === "object" ? [result.value] : [];
    if (path === "ip/dns/cache") rows = rows.filter((r) => hosts.includes(String(r.name).toLowerCase()) && ["A", "AAAA"].includes(r.type));
    const truncated = rows.length > 150;
    return { path, truncated, rows: rows.slice(0, 150).map((row) => Object.fromEntries(tables[path]
      .filter((key) => ["string", "number", "boolean"].includes(typeof row[key]))
      .map((key) => [key, typeof row[key] === "string" ? row[key].slice(0, 200) : row[key]]))) };
  });
  const rows = (path) => readings.find((r) => r.path === path)?.rows || [];
  const garden = rows("ip/hotspot/walled-garden/ip"), routes = rows("ip/route"), hotspot = rows("ip/hotspot").filter((r) => r.name === "ndahi-hotspot" && enabled(r));
  const findings = [{ label: "Coverage gate", status: env.COVERAGE_ACCESS_ENABLED === "true" ? "configured" : "review",
    detail: env.COVERAGE_ACCESS_ENABLED === "true" ? "Purchases require the configured cloud egress address." : "Coverage restriction is disabled. Review the API deployment settings." }];
  findings.push({ label: "HotSpot server", status: hotspot.length === 1 ? "configured" : "review", detail: hotspot.length === 1 ? `Enabled on ${hotspot[0].interface}.` : "Expected one enabled ndahi-hotspot server." });
  const targets = hosts.map((host, index) => {
    const addresses = dns[index].status === "fulfilled" && Array.isArray(dns[index].value) ? dns[index].value.filter((ip) => isIP(ip) === 4).slice(0, 32) : [];
    const cached = rows("ip/dns/cache").filter((r) => r.name?.toLowerCase() === host);
    if (!addresses.length) findings.push({ label: `DNS: ${host}`, status: "review", detail: "The API server could not resolve this host's IPv4 destinations." });
    for (const ip of addresses) {
      const ipRules = garden.filter((r) => enabled(r) && r.action === "accept" && [undefined, "", "all", "ndahi-hotspot"].includes(r.server) &&
        [undefined, "", "tcp", "6"].includes(r.protocol) && [undefined, "", "443"].includes(r["dst-port"]) && contains(r["dst-address"], ip));
      const hostRules = garden.filter((r) => enabled(r) && r.action === "accept" && r["dst-host"] === host && [undefined, "", "all", "ndahi-hotspot"].includes(r.server));
      findings.push({ label: `Before-login HTTPS: ${ip}`, status: ipRules.length ? "configured" : "review",
        detail: ipRules.length ? "An IP walled-garden accept rule covers this destination. Check source restrictions and rule order below."
          : hostRules.length ? "Only a hostname exception was found. Check its active state, DNS and proxy permission on the router." : "No matching HTTPS IP exception was found for this HotSpot. Inspect the walled garden." });
      const candidates = routes.filter((r) => enabled(r) && !yes(r.inactive) && ![false, "false"].includes(r.active) && !yes(r.blackhole) && (r["routing-table"] || "main") === "main" && contains(r["dst-address"], ip));
      candidates.sort((a, b) => Number((b["dst-address"].split("/")[1] || 32)) - Number((a["dst-address"].split("/")[1] || 32)) || Number(a.distance || 0) - Number(b.distance || 0));
      const best = candidates[0], hop = String(best?.gateway || "").split(/[ %@]/)[0];
      const tunnel = rows("interface/wireguard").filter(enabled).find((wg) => String(best?.gateway).includes(`%${wg.name}`) || rows("ip/address").some((r) => enabled(r) && r.interface === wg.name && contains(r.address, hop)));
      findings.push({ label: `Main route: ${ip}`, status: best && tunnel ? "configured" : "review", detail: best && tunnel
        ? `Route ${best["dst-address"]} uses ${tunnel.name}. Check source policies and mangle rules before authentication.`
        : "A main-table route through the saved WireGuard interface was not confirmed. Compare routes and policy rules below." });
      if (cached.some((r) => r.type === "A") && !cached.some((r) => r.type === "A" && r.data === ip))
        findings.push({ label: `Router DNS: ${host}`, status: "review", detail: "Router cached A records differ from an API-server destination. Compare guest DNS and both route sets." });
    }
    return { host, addresses, routerDns: cached };
  });
  if (rows("ip/firewall/mangle").some((r) => enabled(r) && r.action === "mark-routing" && String(r.hotspot || "").split(",").includes("auth")))
    findings.push({ label: "Authentication-dependent routing", status: "review", detail: "An auth-only routing mark exists. Verify portal/API traffic has the same allowed egress before and after HotSpot login." });
  if (rows("ipv6/nd").some((r) => enabled(r) && ["all", hotspot[0]?.interface].includes(r.interface)))
    findings.push({ label: "Guest IPv6", status: "review", detail: "IPv6 advertisements may reach guests. Verify guest IPv6 forwarding is blocked; IPv4 HotSpot does not enforce IPv6 access." });
  for (const reading of readings.filter((r) => r.error || r.truncated)) findings.push({ label: reading.path, status: "review", detail: reading.error || "Reading truncated; inspect the full table locally." });
  return { checkedAt: now().toISOString(), clientTestRequired: true, findings, targets, readings,
    allowedEgress: String(env.COVERAGE_ALLOWED_IPS || "").split(",").map((ip) => ip.trim()).filter((ip) => isIP(ip) === 4),
    nextStep: "On an unpaid guest phone with mobile data off, open the API /api/purchase/access. It must report allowed:true. This router reading cannot prove the phone's actual egress or the cloud gateway NAT. Copy this report for support if it fails." };
}
