import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { RouterRest, quoteRouter as q } from "./network-router.mjs";
import { homeError, homeSecret } from "./home.mjs";
import { homeGatewayCheckIds } from "./home-compatibility.mjs";

const yes = v => [true, "true", "yes"].includes(v);
const enabled = row => row && !yes(row.disabled) && !yes(row.invalid);
const macOk = mac => /^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(mac || "") &&
  mac !== "00:00:00:00:00:00" && (parseInt(mac.slice(0, 2), 16) & 1) === 0;
const tag = value => createHash("sha256").update(value).digest("hex").slice(0, 24);
const fail = message => homeError("HOME_NETWORK_UNVERIFIED", message, 503);
export const homeNames = v => {
  const id = tag(`${v.id}:${v.homeMeterId || v.homeGeneration}`);
  return { username: `nh_${id}`, profile: `nhp_${id}`, epoch: `nh${id}`, guard: `nhg_${id}`, arm: `nha_${id}`,
    comment: `ndahi:home:${v.id}:${v.homeGeneration}` };
};
// RouterOS includes counters and default flags in print results. Any other
// non-default matcher would narrow a guard and could allow a bypass.
const exactRule = (row, expected) => row && !yes(row.invalid) &&
  Object.entries(expected).every(([key,value]) => row[key] === value) &&
  Object.entries(row).every(([key,value]) => key in expected ||
    [".id","comment","bytes","packets","dynamic"].includes(key) ||
    value === "" || value === false || value === "false" || value === "no");
const meterEpoch = v => v.homeMeterId || v.homeGeneration;
const bytes = row => Number(row?.["bytes-in"] || 0) + Number(row?.["bytes-out"] || 0);

// Native HotSpot accounting, one upstream session, and a volatile authorization
// gate. The gate disappears on reboot; a missing accounting epoch never rearms
// an existing entitlement automatically. This adapter never installs topology.
export class HomeRouter extends RouterRest {
  constructor(options = {}, fetcher) { super(options, fetcher); this.key = options.approvalKey; this.now = options.now || (() => new Date()); }
  async inspectHomeReadiness() {
    try {
      const { checks } = await this.homeSafetySnapshot();
      return { status: checks.every(check => check.status === "passed") ? "configuration_verified" : "blocked",
        nativePilot: "pending", checks, code: checks.every(check => check.status === "passed") ? null : "HOME_NETWORK_UNVERIFIED" };
    } catch {
      return { status: "blocked", nativePilot: "pending", checks: [], code: "HOME_ROUTER_UNAVAILABLE" };
    }
  }
  async owned(path, name, comment, values) {
    const rows = (await this.request(path)).filter(r => r.name === name);
    if (rows.length > 1 || rows.some(r => r.comment !== comment)) throw fail("A Home resource conflicts with an unmanaged router resource.");
    return this.request(path + (rows[0] ? `/${encodeURIComponent(rows[0][".id"])}` : ""), rows[0] ? "PATCH" : "PUT", { name, comment, ...values });
  }
  async profile(name, values) {
    const rows = (await this.request("ip/hotspot/user/profile")).filter(r => r.name === name);
    if (rows.length > 1 || rows.some(r => Object.entries(values).some(([k,v]) => String(r[k] ?? "") !== String(v))))
      throw fail("The reserved Home profile differs from its reviewed policy.");
    if (!rows.length) await this.request("ip/hotspot/user/profile", "PUT", { name, ...values });
  }
  async homeSafetySnapshot() {
    const [servers, filters, ipv6, ipv6Filters, profiles, bindings, addresses] = await Promise.all([
      this.request("ip/hotspot"), this.request("ip/firewall/filter"), this.request("ipv6/settings"),
      this.request("ipv6/firewall/filter"), this.request("ip/hotspot/profile"), this.request("ip/hotspot/ip-binding"), this.request("ip/firewall/address-list"),
    ]);
    const checks = [], note = (id, passed, message) => checks.push({ id, status: passed ? "passed" : "not_verified", message });
    const server = servers.find(s => s.name === "ndahi-hotspot" && enabled(s));
    const profile = profiles.find(p => p.name === server?.profile);
    note(homeGatewayCheckIds[0], Boolean(server && typeof server.interface === "string" && server.interface && server.interface !== "all" &&
      enabled(profile) && String(profile["login-by"] || "").split(",").includes("https") &&
      !String(profile["login-by"] || "").split(",").includes("trial") && profile["ssl-certificate"] && profile["ssl-certificate"] !== "none" &&
      /^[a-z0-9.-]+$/i.test(profile["dns-name"] || "")), "Home enrollment requires the existing configured HTTPS HotSpot.");
    const forward = filters.filter(r => enabled(r) && r.chain === "forward");
    const entries = [
      ["ndahi-home-enrollment", "ndahi-home-enroll"], ["ndahi-home-clients", "ndahi-home-forward"],
    ];
    for (const [index, [list, chain]] of entries.entries()) {
      const rules = filters.filter(r => enabled(r) && r.chain === chain);
      const expected = [
        ...(index === 1 ? [{ action: "return", "src-address-list": "ndahi-home-live" }] : []),
        { action: "return", "dst-address-list": "ndahi-home-required" }, { action: "drop" },
      ];
      const matches = exactRule(forward[index], { chain: "forward", action: "jump", "src-address-list": list,
        "jump-target": chain, comment: `ndahi:home:entry:${index}` }) && rules.length === expected.length &&
        expected.every((rule, i) => rules[i].comment?.startsWith("ndahi:home:") && exactRule(rules[i], { chain, ...rule }));
      note(homeGatewayCheckIds[index + 1], matches, "Install and review the exact scoped Home forwarding guard before enabling access.");
    }
    const destinations = addresses.filter(a => a.list === "ndahi-home-required" && enabled(a));
    note(homeGatewayCheckIds[3], destinations.length > 0 && destinations.every(a => {
      const address = String(a.address || "").replace(/\/32$/, "");
      return a.comment?.startsWith("ndahi:home:required:") && isIP(address) === 4 && !["0.0.0.0", "255.255.255.255"].includes(address);
    }), "Review the exact owned portal/payment destination IPv4 allow-list before Home enrollment.");
    note(homeGatewayCheckIds[4], Boolean(server) && !filters.some(r => enabled(r) && r.action === "fasttrack-connection" &&
      !(r["in-interface"] === `!${server.interface}` && r["out-interface"] === `!${server.interface}`)),
      "FastTrack must explicitly exclude the guest interface in both directions.");
    const settings = Array.isArray(ipv6) ? ipv6[0] : ipv6;
    const first6 = ipv6Filters.find(r => enabled(r) && r.chain === "forward");
    note(homeGatewayCheckIds[5], yes(settings?.["disable-ipv6"]) || Boolean(server) &&
      exactRule(first6, { chain: "forward", action: "drop", "in-interface": server.interface }),
      "Unaccounted guest IPv6 forwarding must be blocked before Home activation.");
    return { server, profile, bindings, checks };
  }
  async assertHomeSafety() {
    const result = await this.homeSafetySnapshot(), failed = result.checks.find(check => check.status !== "passed");
    if (failed) throw fail(failed.message);
    return result;
  }
  async beginHomeEnrollment(challenge) {
    const { profile } = await this.assertHomeSafety();
    const username = `he_${tag(challenge.id)}`, comment = `ndahi:home:enroll:${challenge.id}`;
    await this.profile("ndahi-home-enrollment-v1", { "shared-users":"1", "session-timeout":"2m", "idle-timeout":"none",
      "keepalive-timeout":"2m", "address-list":"ndahi-home-enrollment", "rate-limit":"", "add-mac-cookie":"no" });
    const source = `:if ([:timestamp] >= [:totime ${q(Math.floor(Date.parse(challenge.expiresAt)/1000)+"s")}]) do={/ip hotspot user disable [find where comment=${q(comment)}]; /ip hotspot active remove [find where user=${q(username)}]; /ip hotspot cookie remove [find where user=${q(username)}]}`;
    await this.owned("system/scheduler", `heg_${tag(challenge.id)}`, comment, { interval:"00:00:30", "on-event":source, policy:"read,write,policy,test" });
    const password = homeSecret(challenge.id, this.key);
    await this.owned("ip/hotspot/user", username, comment, { password, profile:"ndahi-home-enrollment-v1", server:"ndahi-hotspot", disabled:"false", "limit-uptime":"2m" });
    return { username, password, url:`https://${profile["dns-name"]}/login` };
  }
  async verifyHomeEnrollment(challenge) {
    const { bindings } = await this.assertHomeSafety(), username = `he_${tag(challenge.id)}`;
    const sessions = (await this.request("ip/hotspot/active")).filter(s => s.user === username && s.server === "ndahi-hotspot");
    if (sessions.length !== 1) throw homeError("HOME_PROOF_REQUIRED", "Complete the local router sign-in, then confirm linking.");
    const session = sessions[0], mac = String(session["mac-address"] || "").toUpperCase();
    const hosts = (await this.request("ip/hotspot/host")).filter(h => h.server === "ndahi-hotspot" &&
      h["mac-address"]?.toUpperCase() === mac && (h.address === session.address || h["to-address"] === session.address) && !yes(h.bypassed));
    if (!macOk(mac) || isIP(session.address) !== 4 || !session[".id"] || hosts.length !== 1 || !hosts[0][".id"] ||
      bindings.some(b => b.type === "bypassed" && (!b["mac-address"] || b["mac-address"]?.toUpperCase() === mac)))
      throw homeError("HOME_PROOF_REQUIRED", "The gateway did not verify a unique restricted upstream connection.");
    return { challengeId:challenge.id, mac, address:session.address, sessionId:session[".id"], hostId:hosts[0][".id"] };
  }
  async endHomeEnrollment(challenge) { return this.removeUser(`he_${tag(challenge.id)}`, `ndahi:home:enroll:${challenge.id}`); }
  async removeUser(username, comment) {
    const users = (await this.request("ip/hotspot/user")).filter(u => u.name === username && u.comment === comment);
    for (const user of users) await this.request(`ip/hotspot/user/${encodeURIComponent(user[".id"])}`, "PATCH", { disabled:"true" });
    for (const path of ["ip/hotspot/cookie", "ip/hotspot/active"]) for (const row of await this.request(path))
      if (row.user === username) await this.request(`${path}/${encodeURIComponent(row[".id"])}`, "DELETE");
    if ((await this.request("ip/hotspot/active")).some(s => s.user === username)) throw Error("Router revocation remains unconfirmed.");
    return { confirmed:true };
  }
  async readHome(v) {
    const n = homeNames(v);
    const environments = await this.request("system/script/environment");
    const value = environments.find(e => e.name === n.epoch)?.value || null;
    const epoch = value === `revoked:${meterEpoch(v)}` ? meterEpoch(v) : value;
    for (let attempt=0; attempt<3; attempt++) {
      const user = (await this.request("ip/hotspot/user")).find(u => u.name === n.username && u.comment === n.comment);
      const sessions = (await this.request("ip/hotspot/active")).filter(a => a.user === n.username);
      const after = (await this.request("ip/hotspot/user")).find(u => u.name === n.username && u.comment === n.comment);
      if (!user || !after) return { bytes:0, epoch:null, generation:v.homeGeneration, connected:false };
      if (bytes(user) !== bytes(after)) continue;
      const count = bytes(after) + sessions.reduce((total,row)=>total+bytes(row),0);
      if (!Number.isSafeInteger(count) || count<0 || sessions.length>1) throw fail("Home accounting returned an invalid aggregate.");
      return { bytes:count, epoch, generation:v.homeGeneration, connected:sessions.length===1,
        address:sessions[0]?.address || null };
    }
    throw Error("Home accounting changed during observation; retry safely.");
  }
  async authorizeHome({ voucher:v, connection:h }) {
    const { bindings } = await this.assertHomeSafety(), n = homeNames(v);
    if (!macOk(h.mac) || isIP(h.address)!==4 || !Number.isFinite(Date.parse(v.expiresAt)) || Date.parse(v.expiresAt)<=+this.now())
      throw fail("The verified Home connection or entitlement is unavailable.");
    if (bindings.some(b => b.type === "bypassed" && (!b["mac-address"] || b["mac-address"]?.toUpperCase() === h.mac)))
      throw fail("Remove the conflicting unrestricted bypass before Home activation.");
    if (v.homeAccounting) {
      const reading = await this.readHome(v);
      if (reading.epoch !== v.homeAccounting.epoch || reading.bytes < v.homeAccounting.raw)
        throw homeError("HOME_ACCOUNTING_REVIEW", "Router accounting continuity needs review; allowance was not reset.");
    }
    const base = v.homeAccounting?.base ?? (v.usedBytes || 0), limit = v.quotaBytes === null ? null : v.quotaBytes-base;
    if (limit!==null && (!Number.isSafeInteger(limit) || limit<=0)) throw homeError("HOME_EXHAUSTED", "This household bundle is out of data.");
    const hosts = (await this.request("ip/hotspot/host")).filter(host => host.server === "ndahi-hotspot" && host["mac-address"]?.toUpperCase() === h.mac && !yes(host.bypassed));
    if (hosts.length !== 1) throw Error("Linked router is not currently visible; activation remains pending.");
    const address = hosts[0]["to-address"] || hosts[0].address;
    if (isIP(address)!==4) throw Error("Linked router address needs a new observation.");
    const sessions = await this.request("ip/hotspot/active");
    if(sessions.some(a=>a["mac-address"]?.toUpperCase()===h.mac && a.user!==n.username))
      throw homeError("HOME_LINK_CHANGED","Another account session is using this connection; it was not disconnected.");
    const active = sessions.filter(a => a.user === n.username);
    const queues=await this.request("queue/simple");
    if(queues.some(row=>enabled(row) && String(row.target||"").split(",").some(target=>[address,address+"/32"].includes(target.trim())) && !["","0/0"].includes(String(row["max-limit"]||""))))
      throw fail("Review the existing household-specific queue cap before Home activation.");
    const password = homeSecret(`${v.id}:${v.homeGeneration}`, this.key), expires = Math.floor(Date.parse(v.expiresAt)/1000);
    const removePermit = `/ip firewall address-list remove [find where list="ndahi-home-live" and comment=${q(n.comment)}]`;
    await this.profile(n.profile, { "shared-users":"1", "idle-timeout":"none", "keepalive-timeout":"2m", "rate-limit":"",
      "address-list":"ndahi-home-clients", "add-mac-cookie":"yes", "mac-cookie-timeout":"1d",
      "on-login":`:global ${n.epoch}; :if ($${n.epoch} != ${q(meterEpoch(v))}) do={/ip hotspot active remove [find where user=${q(n.username)}]}`,
      "on-logout":removePermit });
    // A volatile permit is renewed locally, only for a live single session and
    // an in-memory generation. Both disappear on reboot. Required services are
    // still reachable through the independently reviewed restricted chain.
    const source = `:global ${n.epoch}; ${removePermit}; :local uid [/ip hotspot user find where comment=${q(n.comment)}]; :if ([:timestamp] >= [:totime ${q(expires+"s")}]) do={/ip hotspot user disable $uid; /ip hotspot active remove [find where user=${q(n.username)}]; /ip hotspot cookie remove [find where user=${q(n.username)}]} else={:if ($${n.epoch} = ${q(meterEpoch(v))}) do={:foreach sid in=[/ip hotspot active find where user=${q(n.username)}] do={/ip firewall address-list add list="ndahi-home-live" address=[/ip hotspot active get $sid address] timeout=3s comment=${q(n.comment)}}}}`;
    await this.owned("system/scheduler", n.guard, n.comment, { interval:"00:00:01", "on-event":source, policy:"read,write,policy,test", disabled:"false" });
    await this.owned("ip/hotspot/user", n.username, n.comment, { password, profile:n.profile, server:"ndahi-hotspot",
      "mac-address":h.mac, "limit-bytes-total":String(limit ?? 0), disabled:"false" });
    await this.owned("system/script", n.arm, n.comment, { source:`:global ${n.epoch}; :set ${n.epoch} ${q(meterEpoch(v))}`, policy:"read,write,policy,test" });
    const arm=(await this.request("system/script")).find(s=>s.name===n.arm && s.comment===n.comment);
    await this.request("system/script/run", "POST", { ".id":arm[".id"] });
    if (!active.length) await this.request("ip/hotspot/active/login", "POST", { user:n.username, password, ip:address, "mac-address":h.mac });
    const reading = await this.readHome(v);
    if (!reading.connected || reading.epoch !== meterEpoch(v)) throw Error("Home authorization is not yet confirmed by the router.");
    return { ...reading, base, confirmed:true };
  }
  async prepareDirect(v) {
    await this.assertHomeSafety();
    const n=homeNames(v), epoch=meterEpoch(v), expected=`revoked:${epoch}`;
    const environments=await this.request("system/script/environment");
    const users=await this.request("ip/hotspot/user");
    const user=users.find(u=>u.name===v.code && u.comment===`ndahi:voucher:${v.id}`);
    const raw=bytes(user);
    if(environments.find(e=>e.name===n.epoch)?.value!==expected ||
      !Number.isSafeInteger(raw) || raw<(v.homeDirectRaw||0))
      throw homeError("HOME_ACCOUNTING_REVIEW","Direct accounting continuity needs review; allowance was not reset.");
    const name=`nhd_${tag(`${v.id}:${epoch}`)}`, comment=`ndahi:home:direct:${v.id}:${epoch}`;
    const remove=`/ip firewall address-list remove [find where list="ndahi-home-live" and comment=${q(comment)}]`;
    await this.profile(name,{"shared-users":String(v.deviceLimit),"idle-timeout":"none","keepalive-timeout":"2m",
      "rate-limit":"","address-list":"ndahi-home-clients","add-mac-cookie":"no",
      "on-login":`:global ${n.epoch}; :if ($${n.epoch} != ${q(expected)}) do={/ip hotspot active remove [find where user=${q(v.code)}]}`,
      "on-logout":remove});
    const expires=Math.floor(Date.parse(v.expiresAt)/1000);
    const source=`:global ${n.epoch}; ${remove}; :if ([:timestamp] >= [:totime ${q(expires+"s")}]) do={/ip hotspot user disable [find where comment=${q("ndahi:voucher:"+v.id)}]; /ip hotspot active remove [find where user=${q(v.code)}]; /ip hotspot cookie remove [find where user=${q(v.code)}]} else={:if ($${n.epoch} = ${q(expected)}) do={:foreach sid in=[/ip hotspot active find where user=${q(v.code)}] do={/ip firewall address-list add list="ndahi-home-live" address=[/ip hotspot active get $sid address] timeout=3s comment=${q(comment)}}}}`;
    await this.owned("system/scheduler",name,comment,{interval:"00:00:01","on-event":source,policy:"read,write,policy,test",disabled:"false"});
    return name;
  }
  async revokeHome(v) {
    const n=homeNames(v);
    const result=await this.removeUser(n.username,n.comment);
    const reading=await this.readHome(v);
    const scripts=(await this.request("system/script")).find(r=>r.name===n.arm && r.comment===n.comment);
    // Stop local refresh before confirming revocation; do not delete accounting.
    for(const row of await this.request("system/scheduler")) if(row.name===n.guard && row.comment===n.comment)
      await this.request(`system/scheduler/${encodeURIComponent(row[".id"])}`,"PATCH",{disabled:"true"});
    if(scripts) await this.request(`system/script/${encodeURIComponent(scripts[".id"])}`,"PATCH",{source: `:global ${n.epoch}; :set ${n.epoch} ${q("revoked:"+meterEpoch(v))}`});
    if(scripts) await this.request("system/script/run","POST",{".id":scripts[".id"]});
    for (const row of await this.request("ip/firewall/address-list")) if (row.list==="ndahi-home-live" && row.comment===n.comment)
      await this.request(`ip/firewall/address-list/${encodeURIComponent(row[".id"])}`,"DELETE");
    return {...result,reading};
  }
}
