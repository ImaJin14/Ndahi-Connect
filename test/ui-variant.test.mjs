import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStaticServer } from "../static-server.mjs";
import { selectUiVariant, uiRolloutConfig } from "../lib/ui-variant.mjs";

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const site = (t, kind, env = {}, options = {}) =>
  listen(t, createStaticServer(kind, { apiUrl: "https://api.test", env, ...options }));
const get = (base, path, cookie) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
const isV2 = async (response) => /<html[^>]* data-ui-variant="v2"/.test(await response.text());
const select = (kind, path, { cookie = "", env = {}, random = () => 0.5 } = {}) =>
  selectUiVariant({ kind, url: new URL(path, "http://portal.test"), cookieHeader: cookie, config: uiRolloutConfig(env), random });

test("the kill switch serves v1 over every query, cookie and percentage", async (t) => {
  const env = { UI_V2_OFF: "true", UI_V2_PERCENT: "100" };
  for (const kind of ["customer", "admin"]) {
    assert.deepEqual(select(kind, "/login?ui=new", { cookie: "ndahi_ui=v2", env, random: () => 0 }), { variant: "v1" });
    const base = await site(t, kind, env, { random: () => 0 });
    for (const [path, cookie] of [["/login?ui=new"], ["/login", "ndahi_ui=v2"], ["/login"]]) {
      const response = await get(base, path, cookie);
      assert.equal(response.status, 200, `${kind} ${path}`);
      assert.equal(response.headers.get("set-cookie"), null, "the visitor's saved choice is left alone");
      assert.equal(await isV2(response), false, `${kind} ${path} ${cookie}`);
    }
  }
});

test("?ui=new and ?ui=old set the cookie and redirect without the parameter", async (t) => {
  const base = await site(t, "customer");
  const opted = await get(base, "/login?account=1&ui=new", "ndahi_ui=v1");
  assert.equal(opted.status, 302);
  assert.equal(opted.headers.get("location"), "/login?account=1");
  assert.equal(opted.headers.get("cache-control"), "no-store");
  assert.match(opted.headers.get("set-cookie"), /^ndahi_ui=v2;/);
  assert.equal(await isV2(await get(base, "/login?account=1", "ndahi_ui=v2")), true);
  const back = await get(base, "/dashboard?ui=old", "ndahi_ui=v2");
  assert.equal(back.headers.get("location"), "/dashboard");
  assert.match(back.headers.get("set-cookie"), /^ndahi_ui=v1;/);
  // Unknown values are not overrides; a path like //host stays on this site.
  assert.deepEqual(select("customer", "/login?ui=beta", { cookie: "ndahi_ui=v2" }), { variant: "v2" });
  assert.equal(select("customer", "/.//evil.test?ui=new").redirect, "/evil.test");
});

test("a saved cookie wins over sampling until it expires", () => {
  assert.deepEqual(select("customer", "/login", { cookie: "theme=dark; ndahi_ui=v1", env: { UI_V2_PERCENT: "100" }, random: () => 0 }), { variant: "v1" });
  assert.deepEqual(select("customer", "/login", { cookie: "ndahi_ui=v2", env: { UI_V2_PERCENT: "0" } }), { variant: "v2" });
  // Malformed values are treated as a new visitor.
  assert.equal(select("customer", "/login", { cookie: "ndahi_ui=v3", env: { UI_V2_PERCENT: "0" } }).persist, true);
});

test("new customer visitors are sampled at UI_V2_PERCENT and keep the result", async (t) => {
  const sample = (percent, random) => select("customer", "/login", { env: { UI_V2_PERCENT: percent }, random: () => random });
  for (const random of [0, 0.5, 0.999]) {
    assert.deepEqual(sample("0", random), { variant: "v1", persist: true });
    assert.deepEqual(sample("100", random), { variant: "v2", persist: true });
  }
  assert.equal(sample("50", 0.49).variant, "v2");
  assert.equal(sample("50", 0.5).variant, "v1");
  assert.equal(select("customer", "/login").variant, "v1", "the default is 0%");
  const base = await site(t, "customer", { UI_V2_PERCENT: "50" }, { random: () => 0.25 });
  const response = await get(base, "/login");
  assert.match(response.headers.get("set-cookie"), /^ndahi_ui=v2;/);
  assert.equal(await isV2(response), true);
});

test("admin ignores UI_V2_PERCENT; staff opt in with ?ui=new", async (t) => {
  assert.equal(select("admin", "/login", { env: { UI_V2_PERCENT: "100" }, random: () => 0 }).variant, "v1");
  const base = await site(t, "admin", { UI_V2_PERCENT: "100" }, { random: () => 0 });
  const response = await get(base, "/login");
  assert.match(response.headers.get("set-cookie"), /^ndahi_ui=v1;/);
  assert.equal(await isV2(response), false);
  const opted = await get(base, "/login?ui=new");
  assert.equal(opted.headers.get("location"), "/login");
  assert.match(opted.headers.get("set-cookie"), /^ndahi_ui=v2;/);
  assert.equal(await isV2(await get(base, "/login", "ndahi_ui=v2")), true);
});

test("the cookie is host-only and follows the session cookie Secure rule", async (t) => {
  const cookieFor = async (options, env = {}) => (await get(await site(t, "customer", env, options), "/login")).headers.get("set-cookie");
  const local = await cookieFor({ production: false });
  assert.equal(local, "ndahi_ui=v1; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly");
  assert.doesNotMatch(local, /Domain=/i);
  assert.equal(await cookieFor({ production: true }), `${local}; Secure`);
  assert.equal(await cookieFor({ production: true }, { SESSION_COOKIE_SECURE: "false" }), local);
  assert.equal(await cookieFor({ production: false }, { SESSION_COOKIE_SECURE: "true" }), `${local}; Secure`);
});

test("pages, the service worker and release checks come from the chosen folder", async (t) => {
  for (const [kind, cache] of [["customer", "ndahi-shell-v2"], ["admin", "ndahi-admin-shell-v2"]]) {
    const base = await site(t, kind);
    const [v1, v2] = await Promise.all(["ndahi_ui=v1", "ndahi_ui=v2"].map(async (cookie) => {
      const html = await (await get(base, "/login", cookie)).text();
      const worker = await (await get(base, "/sw.js", cookie)).text();
      const manifest = await get(base, "/manifest.webmanifest", cookie);
      const { revision } = await (await get(base, "/version.json", cookie)).json();
      const script = html.match(/src="(\/static\/login\.[0-9a-f]{20}\.js)"/)[1];
      return { html, worker, manifest, revision, script };
    }));
    assert.doesNotMatch(v1.html, /data-ui-variant/);
    assert.match(v2.html, /<html lang="en" data-ui-variant="v2">/);
    assert.ok(!v1.worker.includes(cache) && v2.worker.includes(cache), `${kind} service worker cache name`);
    assert.equal(v1.manifest.status, 200);
    assert.equal(v2.manifest.headers.get("vary"), "Accept-Encoding, Cookie");
    assert.notEqual(v1.revision, v2.revision, "each variant has its own release");
    assert.match(v2.html, new RegExp(`content="${v2.revision}"`));
    assert.notEqual(v1.script, v2.script);
    // A tab still open on the other variant can load its versioned files.
    const crossed = await get(base, v1.script, "ndahi_ui=v2");
    assert.equal(crossed.status, 200);
    assert.equal(crossed.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(crossed.headers.get("vary"), "Accept-Encoding");
    assert.equal(crossed.headers.get("set-cookie"), null);
  }
  // The kill switch never serves v2 bytes, even content-addressed ones.
  const v2Script = (await (await get(await site(t, "customer"), "/login", "ndahi_ui=v2")).text()).match(/src="(\/static\/login\.[^"]+)"/)[1];
  assert.equal((await get(await site(t, "customer", { UI_V2_OFF: "true" }), v2Script, "ndahi_ui=v2")).status, 404);
});

test("pages, the service worker and /version.json are private and vary by cookie", async (t) => {
  const base = await site(t, "customer", {}, { production: true });
  for (const path of ["/login", "/dashboard", "/onboarding.html", "/sw.js"]) {
    const response = await get(base, path, "ndahi_ui=v2");
    assert.equal(response.headers.get("cache-control"), "private, no-cache", path);
    assert.equal(response.headers.get("vary"), "Accept-Encoding, Cookie", path);
  }
  const version = await get(base, "/version.json");
  assert.equal(version.headers.get("cache-control"), "private, no-store");
  assert.equal(version.headers.get("vary"), "Cookie");
  // Security headers and the CSP are unchanged.
  const page = await get(base, "/login");
  assert.match(page.headers.get("content-security-policy"), /^default-src 'self'; .*script-src 'self'; .*report-uri https:\/\/api\.test\/api\/csp-report$/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("strict-transport-security"), /includeSubDomains/);
  // The store has no variants and keeps its previous headers.
  const store = await get(await site(t, "store", { UI_V2_PERCENT: "100" }), "/");
  assert.equal(store.headers.get("set-cookie"), null);
  assert.equal(store.headers.get("vary"), "Accept-Encoding");
  assert.equal(store.headers.get("cache-control"), "no-cache");
});

test("invalid rollout settings stop the customer and admin servers at startup", async () => {
  for (const UI_V2_PERCENT of ["-1", "101", "5.5", "010", "ten", " 5"]) {
    for (const kind of ["customer", "admin"]) {
      assert.throws(() => createStaticServer(kind, { env: { UI_V2_PERCENT } }), /UI_V2_PERCENT must be a whole number from 0 to 100/, UI_V2_PERCENT);
    }
  }
  for (const UI_V2_OFF of ["TRUE", "1", "yes"]) {
    assert.throws(() => createStaticServer("customer", { env: { UI_V2_OFF } }), /UI_V2_OFF must be exactly "true" or "false"/);
  }
  assert.doesNotThrow(() => createStaticServer("store", { env: { UI_V2_PERCENT: "ten" } }));
  assert.deepEqual(uiRolloutConfig({ UI_V2_PERCENT: "", UI_V2_OFF: "" }), { percent: 0, off: false });
  const started = await promisify(execFile)(process.execPath, ["static-server.mjs"], {
    env: { PATH: process.env.PATH, APP_KIND: "customer", PORT: "0", HOST: "127.0.0.1", UI_V2_PERCENT: "150" }, timeout: 10000,
  }).then(() => ({ code: 0, stderr: "" }), (error) => error);
  assert.notEqual(started.code, 0);
  assert.match(started.stderr, /UI_V2_PERCENT must be a whole number from 0 to 100/);
});
