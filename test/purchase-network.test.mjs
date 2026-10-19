import test from "node:test";
import assert from "node:assert/strict";
import { preparePurchaseNetwork } from "../scripts/prepare-purchase-network.mjs";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = { portal: "https://portal.example.test", api: "https://api.example.test", gateway: "10.77.0.1", tunnel: "wg-ndahi" };
const lookup = async (host) => host.startsWith("portal.") ? ["216.24.57.16", "216.24.57.18"] : ["216.24.57.18"];

test("pre-auth repair covers every current portal/API A record without allowing general internet", async () => {
  const plan = await preparePurchaseNetwork(config, lookup);
  assert.deepEqual(plan.addresses, ["216.24.57.16", "216.24.57.18"]);
  assert.equal((plan.apply.match(/\/ip hotspot walled-garden ip add /g) || []).length, 2);
  for (const line of plan.apply.split("\n").filter((l) => l.includes("/ip hotspot walled-garden ip add "))) {
    assert.match(line, /server="ndahi-hotspot" action="accept" protocol="tcp" dst-port="443"/);
    assert.match(line, /dst-address="216\.24\.57\.(16|18)\/32"/);
  }
  assert.equal((plan.apply.match(/\/ip route add /g) || []).length, 4);
  for (const line of plan.apply.split("\n").filter((l) => l.includes("/ip route add "))) {
    assert.match(line, /routing-table="main"/);
    assert.match(line, /gateway="10\.77\.0\.1%wg-ndahi"|blackhole distance="254"/);
  }
  assert.doesNotMatch(plan.apply, /blackhole=|hotspot=auth|ip-binding|trial|0\.0\.0\.0\/0|firewall filter add|firewall nat add|\bset\b|\bremove\b/);
  assert.ok(plan.apply.lastIndexOf("Changed managed entry:") < plan.apply.indexOf("/ip route add "), "all preflights precede writes");
  assert.match(plan.apply, /Conflicting main-table route/);
  assert.doesNotMatch(plan.checks, /\b(add|set|remove|run|fetch|export)\b/);
  for (const line of plan.rollback.split("\n").filter((l) => l && !l.startsWith("#"))) {
    assert.ok(line.includes(`comment="${plan.prefix}:`)); assert.match(line, / remove \$item/);
  }
});

test("repeat generation is stable and DNS changes produce a separately reviewable plan", async () => {
  const first = await preparePurchaseNetwork(config, lookup), repeat = await preparePurchaseNetwork(config, lookup);
  assert.deepEqual(repeat, first);
  const changed = await preparePurchaseNetwork(config, async () => ["216.24.57.20"]);
  assert.notEqual(changed.prefix, first.prefix);
  assert.match(changed.readme, /DNS snapshot/); assert.match(changed.readme, /allowed:true/);
});

test("malformed origins, router names and non-public DNS cannot broaden a repair", async () => {
  for (const extra of [
    { portal: "http://portal.example.test" }, { api: "https://user:password@api.example.test" },
    { portal: "https://portal.example.test/path" }, { api: "https://api.example.test:8443" },
    { portal: "https://127.0.0.1" }, { gateway: "not-ip" }, { tunnel: 'wg"; :error "injection' }, { server: "*" },
  ]) await assert.rejects(preparePurchaseNetwork({ ...config, ...extra }, lookup));
  for (const addresses of [[], ["127.0.0.1"], ["10.20.0.1"], ["100.64.0.1"], ["169.254.1.1"], ["198.18.0.1"], ["0.0.0.0"], ["224.0.0.1"], ["::1"], ["216.24.57.16", "192.168.1.1"]])
    await assert.rejects(preparePurchaseNetwork(config, async () => addresses), /Refusing/);
  await assert.rejects(preparePurchaseNetwork(config, async () => { throw Error("DNS unavailable"); }), /DNS unavailable/);
});

test("prepared captive-portal entry pages show bundles before login, while router errors retain retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ndahi-landing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await promisify(execFile)(process.execPath, ["scripts/prepare-hotspot-pages.mjs", config.portal, directory]);
  assert.deepEqual((await readdir(directory)).sort(), ["flogin.html", "login.html", "rlogin.html"]);
  for (const name of ["login.html", "rlogin.html"]) {
    const html = await readFile(join(directory, name), "utf8");
    assert.match(html, /https:\/\/portal.example.test\/onboarding.html/);
    assert.match(html, /\?mac=\$\(mac\)&amp;address=\$\(ip\)/);
    assert.doesNotMatch(html, /https:\/\/portal.example.test\/login/);
  }
  assert.match(await readFile(join(directory, "flogin.html"), "utf8"), /\/hotspot\?router-error=1/);
  assert.match(await readFile(join(directory, "flogin.html"), "utf8"), /&amp;mac=\$\(mac\)&amp;address=\$\(ip\)/);
});
