// Personal Unlimited sharing rules (#335): the plan the router provisioning
// applies, and which sessions it can match. Pure logic only. The owner proves
// the router behaviour on the test HotSpot with
// docs/operations/unlimited-sharing-rules-test-plan.md, not simulated here.
import test from "node:test";
import assert from "node:assert/strict";
import { sharingRulesPlan, PERSONAL_LIST } from "../lib/sharing-rules.mjs";
import { routerVoucherPayload } from "../lib/routeros.mjs";
import { profileName } from "../lib/router-hotspot.mjs";
import { createNetworkSetup, SimulatedRouter } from "../lib/network-setup.mjs";
import { createStore } from "../server.mjs";

// Shaped like the site RB5009: an adopted HotSpot on vlan20-hotspot and the
// RouterOS 7 default firewall, with FastTrack.
function discovery(extra = {}) {
  return {
    model: "RB5009UPr+S+", version: "7.24.5 (stable)", identity: "ndahi-site", interfaces: [], guards: [],
    tables: {
      "ip/hotspot": [{ ".id": "*1", name: "ndahi-hotspot", interface: "vlan20-hotspot", disabled: "false" }],
      "ip/firewall/filter": [
        { ".id": "*D1", chain: "forward", action: "passthrough", dynamic: "true", comment: "special dummy rule to show fasttrack counters" },
        { ".id": "*A", chain: "input", action: "accept", "connection-state": "established,related,untracked" },
        { ".id": "*B", chain: "forward", action: "accept", "ipsec-policy": "in,ipsec" },
        { ".id": "*C", chain: "forward", action: "fasttrack-connection", "connection-state": "established,related", "hw-offload": "true" },
        { ".id": "*E", chain: "forward", action: "accept", "connection-state": "established,related,untracked" },
      ],
      "ip/firewall/mangle": [],
      "ipv6/address": [{ ".id": "*6", address: "fe80::1/64", interface: "vlan20-hotspot", dynamic: "true", disabled: "false" }],
      "ipv6/firewall/filter": [
        { ".id": "*61", chain: "input", action: "accept", "connection-state": "established,related,untracked" },
        { ".id": "*62", chain: "forward", action: "accept", "connection-state": "established,related,untracked" },
        { ".id": "*63", chain: "forward", action: "drop", "in-interface-list": "!LAN" },
      ],
      ...extra,
    },
  };
}
// The router as it reads back once the plan is in place.
function applied(d, plan) {
  const out = structuredClone(d);
  plan.operations.forEach((op, i) => {
    const rows = out.tables[op.path], at = op.placeBefore ? rows.findIndex((r) => r[".id"] === op.placeBefore) : rows.length;
    rows.splice(at, 0, { ".id": `*N${i}`, ...op.values });
  });
  return out;
}

test("the plan matches only the ndahi-personal list, sets TTL 1 toward the client, and keeps that traffic off FastTrack", () => {
  const plan = sharingRulesPlan(discovery());
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.config, { hotspotInterface: "vlan20-hotspot" });
  const byKey = Object.fromEntries(plan.operations.map((op) => [op.values.comment, op]));
  assert.deepEqual(Object.keys(byKey), ["ndahi:sharing-established-in", "ndahi:sharing-established-out", "ndahi:sharing-ttl", "ndahi:sharing-ipv6-in", "ndahi:sharing-ipv6-out"]);
  assert.ok(plan.operations.every((op) => op.action === "create"));
  const ttl = byKey["ndahi:sharing-ttl"];
  assert.deepEqual([ttl.path, ttl.values.chain, ttl.values.action, ttl.values["new-ttl"], ttl.values["out-interface"], ttl.values["in-interface"], ttl.values["dst-address-list"]],
    ["ip/firewall/mangle", "forward", "change-ttl", "set:1", "vlan20-hotspot", "!vlan20-hotspot", PERSONAL_LIST]);
  // Every IPv4 rule is scoped to Personal Unlimited sessions.
  for (const op of plan.operations.filter((op) => op.path.startsWith("ip/"))) assert.ok([op.values["dst-address-list"], op.values["src-address-list"]].includes(PERSONAL_LIST), op.values.comment);
  // Established Personal traffic is accepted just before FastTrack, never the dynamic counter rule.
  assert.equal(byKey["ndahi:sharing-established-in"].placeBefore, "*C");
  assert.equal(byKey["ndahi:sharing-established-out"].placeBefore, "*C");
  // IPv6 forwarding on the HotSpot is blocked ahead of every forward rule.
  assert.equal(byKey["ndahi:sharing-ipv6-in"].placeBefore, "*62");
  assert.deepEqual([byKey["ndahi:sharing-ipv6-out"].values.action, byKey["ndahi:sharing-ipv6-out"].values["out-interface"]], ["drop", "vlan20-hotspot"]);
  assert.match(plan.warnings.join(" "), /do(es)? not guarantee that all proxying or packet rewriting is blocked/);
});

test("applied rules read back with no operations; the fingerprint changes when the router does", () => {
  const d = discovery(), plan = sharingRulesPlan(d), after = applied(d, plan);
  assert.deepEqual([sharingRulesPlan(after).operations, sharingRulesPlan(after).conflicts], [[], []]);
  // RouterOS reads booleans back as true/false; values set as yes/no still match.
  after.tables["ip/firewall/mangle"][0].passthrough = "true";
  assert.deepEqual(sharingRulesPlan(after).operations, []);
  assert.equal(sharingRulesPlan(discovery()).fingerprint, plan.fingerprint);
  const moved = discovery(); moved.tables["ip/firewall/filter"].splice(2, 0, { ".id": "*Z", chain: "forward", action: "fasttrack-connection" });
  assert.notEqual(sharingRulesPlan(moved).fingerprint, plan.fingerprint, "a new FastTrack rule needs a fresh preview");
});

test("a TTL rule left below a mark rule, or a managed rule edited by hand, is caught on read-back", () => {
  const d = discovery({ "ip/firewall/mangle": [{ ".id": "*M1", chain: "forward", action: "mark-packet", "new-packet-mark": "q", passthrough: "false" }] });
  const plan = sharingRulesPlan(d);
  assert.equal(plan.operations.find((op) => op.values.comment === "ndahi:sharing-ttl").placeBefore, "*M1", "first in the forward chain (#326 queues)");
  const wrong = applied(d, plan), mangle = wrong.tables["ip/firewall/mangle"];
  mangle.push(mangle.shift());
  assert.match(sharingRulesPlan(wrong).conflicts.join(" "), /ndahi:sharing-ttl is below a rule it must precede/);
  const edited = applied(d, plan);
  edited.tables["ip/firewall/mangle"][0]["new-ttl"] = "set:64";
  const fix = sharingRulesPlan(edited).operations;
  assert.deepEqual([fix.length, fix[0].action, fix[0].before["new-ttl"], fix[0].values["new-ttl"]], [1, "update", "set:64", "set:1"]);
});

test("refused: IPv6 on the HotSpot interface, no HotSpot, unreadable tables, or an unresolved watchdog", () => {
  const v6 = discovery({ "ipv6/address": [{ ".id": "*7", address: "2001:db8:20::1/64", interface: "vlan20-hotspot", disabled: "false" }] });
  assert.match(sharingRulesPlan(v6).conflicts.join(" "), /has IPv6 address 2001:db8:20::1\/64/);
  assert.deepEqual(sharingRulesPlan(discovery({ "ip/hotspot": [] })).conflicts, ["An enabled ndahi-hotspot server is required."]);
  assert.match(sharingRulesPlan(discovery({ "ip/firewall/mangle": null })).conflicts.join(" "), /Couldn't read ip\/firewall\/mangle/);
  assert.match(sharingRulesPlan({ ...discovery(), guards: ["ndahi-rollback-old"] }).conflicts.join(" "), /Unresolved rollback watchdog/);
  assert.deepEqual(sharingRulesPlan({ ...discovery(), guards: ["ndahi-rollback-job1"] }, { ignoreGuard: "job1" }).conflicts, []);
});

test("a legacy bundle is unaffected: its HotSpot user keeps its old profile, outside the ndahi-personal list", () => {
  const legacy = { id: "v-weekly", code: "NC-WEEK-0001", planId: "weekly", status: "active", expiresAt: "2026-12-01T10:00:00.000Z", quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 2 };
  const payload = routerVoucherPayload(legacy);
  assert.equal("personalUnlimited" in payload, false);
  assert.equal(profileName(payload.simultaneousUsers, payload.approvalRequired, payload.personalUnlimited === true), "ndahi-users-2-presence-v1", "the profile legacy sessions use today");
  // A Personal Unlimited bundle gets its own profile; the old profiles are never changed.
  const personal = routerVoucherPayload({ ...legacy, id: "v-personal", planId: "unlimited-24h-1", accessType: "personal_unlimited", deviceSlots: 1, deviceLimit: 1, quotaBytes: null });
  assert.equal(personal.personalUnlimited, true);
  assert.equal(profileName(personal.simultaneousUsers, true, true), "ndahi-users-1-approval-personal-v1");
  // Home WISP and custom gifts with other access types never join the list.
  assert.equal("personalUnlimited" in routerVoucherPayload({ ...legacy, accessType: "home_wisp_unlimited" }), false);
});

test("Network setup previews the sharing rules as their own router job, owner flow unchanged", async () => {
  const store = createStore({ persistent: false }), adapter = new SimulatedRouter();
  const env = { NODE_ENV: "test", NETWORK_CONFIG_KEY: "a".repeat(64), NETWORK_ALLOWED_ORIGINS: "https://router.test", NETWORK_PROVISIONING_ENABLED: "true" };
  const service = createNetworkSetup({ store, env, routerFactory: () => adapter }), call = (action, input = {}) => service.handle(action, input, "owner");
  await call("connection", { kind: "router", mode: "live", url: "https://router.test", username: "service-user", password: "private-router-password" });
  await assert.rejects(call("preview", { kind: "omada", plan: "sharing" }), /applied to the router/);
  const { job } = await call("preview", { kind: "router", plan: "sharing" });
  assert.deepEqual([job.kind, job.planKind, job.plan.kind], ["router", "sharing", "sharing"]);
  assert.deepEqual(job.plan.conflicts, ["An enabled ndahi-hotspot server is required."], "nothing to apply without the HotSpot");
  await assert.rejects(call("apply", { jobId: job.id, reviewed: true }), /conflict-free preview/);
  const s = await store.snapshot();
  assert.equal(s.auditLogs.find((a) => a.action === "network.setup.previewed").meta.plan, "sharing");
});
