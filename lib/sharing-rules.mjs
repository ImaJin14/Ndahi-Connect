// Sharing rules for Personal Unlimited bundles (#335; spec §4; decisions.md →
// "Unlimited catalogue and device locking" and "Current customers keep their
// terms until their bundle ends").
//
// - IPv4: forwarded replies leaving the router toward a Personal Unlimited
//   session get TTL 1, so a phone hotspot or a router behind it can't forward
//   them on. The rule keys on the ndahi-personal address list, which only the
//   Personal Unlimited HotSpot user profiles fill (router-hotspot.mjs), so it
//   follows the access type, never a list of bundle ids, and never matches a
//   legacy session or a Home WISP router.
// - FastTracked packets skip mangle, so established Personal traffic is
//   accepted just before the first FastTrack rule, which keeps it on the slow
//   path where the TTL rule runs. Every other connection keeps FastTrack.
// - IPv6: HotSpot sign-in covers IPv4 only, and IPv6 authorization (per device
//   and subscription) isn't built yet. Until it is and its Hop Limit rule
//   passes testing, IPv6 forwarding stays blocked on the HotSpot interface.
//   The preview refuses if that interface has an IPv6 address, so the block
//   can't take IPv6 away from anyone using it today.
//
// The plan is applied by Network setup (network-setup.mjs): preview, then an
// encrypted backup, an on-router rollback watchdog, the changes, a read-back
// check, and the owner's confirmation. It is idempotent: a second preview of
// an applied router has no operations.
//
// TTL and Hop Limit restrict ordinary forwarding; they do not guarantee that
// all proxying or packet rewriting is blocked. Customer copy says "restricts
// sharing", never "prevents".
import { createHash } from "node:crypto";

export const PERSONAL_LIST = "ndahi-personal";
// Read by discovery when the router allows it; a missing table refuses the plan.
export const sharingTables = ["ip/firewall/mangle", "ipv6/address", "ipv6/firewall/filter"];

const yes = (value) => [true, "true", "yes"].includes(value);
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const flag = (value) => ({ true: "yes", false: "no" })[value] ?? value;
const same = (current, desired) => Object.entries(desired).every(([k, v]) => flag(String(current[k] ?? "")) === flag(v));

export function sharingRulesPlan(discovery, { ignoreGuard } = {}) {
  const t = discovery.tables || {}, operations = [], conflicts = [];
  const warnings = [
    "TTL restricts ordinary forwarding by Personal Unlimited devices. It does not guarantee that all proxying or packet rewriting is blocked.",
    "Only sessions on Personal Unlimited bundles are matched. Legacy bundles and Home WISP routers keep sharing as before.",
    "Established Personal Unlimited traffic skips FastTrack so the TTL rule applies. If FastTrack rules change later, preview these rules again.",
    "IPv6 forwarding stays blocked on the HotSpot until IPv6 authorization and its Hop Limit rule are built and tested.",
    "Changes roll back after roughly 10 minutes unless confirmed after the on-site tests.",
  ];
  const result = (config = {}) => ({ kind: "sharing", config, operations, conflicts: [...new Set(conflicts)], warnings,
    fingerprint: digest({ kind: "sharing", operations, identity: discovery.identity, model: discovery.model, version: discovery.version, config }) });
  for (const guard of discovery.guards || []) if (![`ndahi-rollback-${ignoreGuard}`, `ndahi-rollback-${ignoreGuard}-boot`].includes(guard)) conflicts.push(`Unresolved rollback watchdog ${guard}; recover the previous job first.`);
  const servers = (t["ip/hotspot"] || []).filter((row) => row.name === "ndahi-hotspot" && !yes(row.disabled));
  if (servers.length !== 1 || !servers[0].interface) { conflicts.push("An enabled ndahi-hotspot server is required."); return result(); }
  const hotspot = servers[0].interface, config = { hotspotInterface: hotspot };
  for (const path of ["ip/firewall/filter", ...sharingTables]) if (!Array.isArray(t[path])) conflicts.push(`Couldn't read ${path} on the router. Give the API user read access and preview again.`);
  if (conflicts.length) return result(config);

  const v6 = t["ipv6/address"].filter((row) => row.interface === hotspot && !yes(row.disabled) && !/^fe80:/i.test(row.address || ""));
  for (const row of v6) conflicts.push(`The HotSpot interface ${hotspot} has IPv6 address ${row.address}. HotSpot sign-in covers IPv4 only, so IPv6 there would bypass bundles, device slots and these rules. Review it locally before applying: IPv6 stays off on the HotSpot until IPv6 authorization is built and tested.`);

  // One managed rule, found by its comment. `before` lists the rules it must
  // precede (only static rules can be placed before); a rule that already
  // exists in the wrong place is a conflict, because moving rules isn't automated.
  function add(path, key, values, before = []) {
    const comment = `ndahi:${key}`, rows = t[path], existing = rows.filter((row) => row.comment === comment);
    if (existing.length > 1) { conflicts.push(`Duplicate managed rule ${comment}.`); return; }
    const desired = { ...values, comment }, current = existing[0];
    const anchors = before.filter((row) => !String(row.comment || "").startsWith("ndahi:sharing-") && !yes(row.dynamic));
    if (current) {
      const at = rows.indexOf(current);
      if (anchors.some((row) => rows.indexOf(row) < at)) { conflicts.push(`Managed rule ${comment} is below a rule it must precede. Remove it locally and preview again.`); return; }
      if (same(current, desired)) return;
      operations.push({ path, action: "update", id: current[".id"], before: Object.fromEntries(Object.keys(desired).map((k) => [k, String(current[k] ?? "")])), values: desired });
      return;
    }
    const first = anchors.map((row) => rows.indexOf(row)).sort((a, b) => a - b)[0];
    operations.push({ path, action: "create", values: desired, ...(first === undefined ? {} : { placeBefore: rows[first][".id"] }) });
  }
  const fasttrack = t["ip/firewall/filter"].filter((row) => row.chain === "forward" && row.action === "fasttrack-connection");
  add("ip/firewall/filter", "sharing-established-in", { chain: "forward", action: "accept", "connection-state": "established,related", "out-interface": hotspot, "dst-address-list": PERSONAL_LIST }, fasttrack);
  add("ip/firewall/filter", "sharing-established-out", { chain: "forward", action: "accept", "connection-state": "established,related", "in-interface": hotspot, "src-address-list": PERSONAL_LIST }, fasttrack);
  // First in the forward chain, so a later mark rule with passthrough off
  // (queues, #326) can't skip it. passthrough stays on (the default).
  add("ip/firewall/mangle", "sharing-ttl", { chain: "forward", action: "change-ttl", "new-ttl": "set:1", "in-interface": `!${hotspot}`, "out-interface": hotspot, "dst-address-list": PERSONAL_LIST },
    t["ip/firewall/mangle"].filter((row) => row.chain === "forward"));
  const v6forward = t["ipv6/firewall/filter"].filter((row) => row.chain === "forward");
  add("ipv6/firewall/filter", "sharing-ipv6-in", { chain: "forward", action: "drop", "in-interface": hotspot }, v6forward);
  add("ipv6/firewall/filter", "sharing-ipv6-out", { chain: "forward", action: "drop", "out-interface": hotspot }, v6forward);
  return result(config);
}
