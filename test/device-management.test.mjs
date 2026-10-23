import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import argon2 from "argon2";
import { createHandler, createStore } from "../server.mjs";
import { hashSecret, totpSecret, totpCode } from "../lib/security.mjs";
import { RouterHotspot } from "../lib/router-hotspot.mjs";
import { queryRecords } from "../lib/admin-records.mjs";

const origin = "http://customer.test", secret = "device-tests", pinHash = await argon2.hash("2468"), mac = "AA:BB:CC:DD:EE:01";
export async function fixture(t, { mfa = false, router = {} } = {}) {
  let at = new Date("2030-01-01T12:00:00Z");
  const store = createStore({ persistent: false }), otpKey = totpSecret();
  await store.transaction((s) => {
    s.networkSetup = { runtimeRouterEnabled: true, connections: { router: { mode: "live", revision: "router-1" } } };
    s.customers.push({ id: "c1", name: "Owner", phone: "670050001", pinHash, ...(mfa ? { totpSecret: otpKey } : {}) },
      { id: "c2", name: "Other owner", phone: "670050002", pinHash });
    for (const [id, customerId] of [["main", "c1"], ["secondary", "c1"], ["other", "c2"]]) {
      s.dashboardSessions.push({ id, customerId, tokenHash: hashSecret(id, secret), csrfToken: "csrf", expiresAt: "2030-02-01T00:00:00Z" });
    }
    s.vouchers.push({ id: "v1", customerId: "c1", code: "NC-AAAA-1111", status: "active", planId: "family", deviceLimit: 3,
      expiresAt: "2030-02-01T00:00:00Z", activatedAt: at.toISOString(), quotaBytes: 1e9, usedBytes: 20,
      routerSyncStatus: "synchronized", wifiDevicesAt: at.toISOString(), wifiDevices: [1, 2].map((n) => ({
        mac: `AA:BB:CC:DD:EE:0${n}`, name: n === 1 ? "imajin" : "iPad", address: `10.20.0.${n}`,
        sessionId: `*${n}`, startedAt: "2030-01-01T11:55:00Z", usedBytes: 5,
      })) });
  });
  const handler = createHandler({ store, router, now: () => at, validateConfig: false, env: {
    NODE_ENV: "production", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: origin, LOG_LEVEL: "warn", NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false",
    SECURITY_ALERTS_ENABLED: "false", TRUST_PROXY: "render", COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: "203.0.113.10",
  } });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const jar = new Map([["customer_session", "main"]]);
  const call = async (path, input, { session, csrf = "csrf", controller, address = "203.0.113.10" } = {}) => {
    const headers = { origin, "x-csrf-token": csrf, "content-type": "application/json", "cf-connecting-ip": address,
      cookie: session === undefined ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
        : `${session ? `customer_session=${session}` : ""}${controller ? `; ndahi_main_device=${controller}` : ""}` };
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + path, { method: input === undefined ? "GET" : "POST",
      headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (session === undefined) for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(";")[0], i = first.indexOf("="); jar.set(first.slice(0, i), first.slice(i + 1));
    }
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { store, call, jar, handler, now: () => at, otp: () => totpCode(otpKey, +at), advance: (s) => { at = new Date(+at + s * 1000); } };
}

test("owner verification selects a named main device; cookie hashes stay private and the designation survives renewal", async (t) => {
  const f = await fixture(t), selected = await f.call("/api/account/device-management/main", { mac, pin: "2468" });
  assert.equal(selected.status, 200); assert.equal(selected.body.mainDevice.name, "imajin");
  assert.match(selected.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  assert.equal((await f.call("/api/account/device-management")).body.isMainController, true);
  const dashboard = await f.call("/api/account/dashboard");
  assert.equal(dashboard.body.customer.wifiMainDevice, undefined);
  assert.equal(dashboard.body.activeBundle.wifiDevices[0].main, true);
  const state = await f.store.snapshot();
  assert.equal(queryRecords(state, { collection: "customers" }).items[1].wifiMainDevice, undefined);
  await f.store.transaction((s) => { s.vouchers[0].id = "renewed"; });
  assert.equal((await f.call("/api/account/wifi-devices")).body.devices[0].main, true);
});

test("secondary sessions and legacy endpoints cannot disconnect the main device without owner proof", async (t) => {
  const f = await fixture(t);
  await f.call("/api/account/device-management/main", { mac, pin: "2468" });
  assert.equal((await f.call("/api/account/wifi-devices/disconnect", { mac }, { session: "secondary" })).status, 403);
  const denied = await f.call("/api/account/device-management/disconnect", { mac, pin: "bad" }, { session: "secondary" });
  assert.equal(denied.status, 401); assert.equal(denied.body.code, "VERIFICATION_FAILED");
  assert.equal((await f.call("/api/account/wifi-devices/disconnect", { mac: "AA:BB:CC:DD:EE:02" }, { session: "secondary" })).status, 202);
  // Correct verification is tested on a fresh fixture to respect PIN backoff.
  const g = await fixture(t); await g.call("/api/account/device-management/main", { mac, pin: "2468" });
  assert.equal((await g.call("/api/account/device-management/disconnect", { mac, pin: "2468" })).status, 202);
});

test("main-device linking requires CSRF, freshness and ownership with an optional authenticator", async (t) => {
  const f = await fixture(t, { mfa: true }), path = "/api/account/device-management/main";
  assert.equal((await f.call(path, { mac, pin: "2468" }, { csrf: "bad" })).status, 403);
  assert.equal((await f.call(path, { mac, pin: "2468" }, { session: "" })).status, 401);
  assert.equal((await f.call(path, { mac, pin: "2468" }, { session: "other" })).status, 404);
  assert.equal((await f.call(path, { mac, pin: "wrong" })).status, 401);
  f.advance(2);
  assert.equal((await f.call(path, { mac, pin: "2468" })).status, 200);
  assert.equal((await f.call(path, { mac, pin: "2468", otp: f.otp() })).status, 200);
  f.advance(121);
  assert.equal((await f.call(path, { mac, pin: "2468", otp: f.otp() })).status, 409);
});

test("legacy authenticator fields never require an extra factor or replace current PIN ownership proof", async (t) => {
  const f = await fixture(t, { mfa: true });
  assert.equal((await f.call("/api/account/device-management/main", { mac, pin: "2468", otp: "wrong-legacy" })).status, 200);
  assert.equal((await f.call("/api/account/device-management/disconnect", { mac, otp: f.otp() })).status, 401);
  f.advance(2);
  assert.equal((await f.call("/api/account/device-management/disconnect", { mac, pin: "2468" })).status, 202);
});

test("transfer and PIN recovery invalidate the previous main browser, not the bundle", async (t) => {
  const f = await fixture(t);
  await f.call("/api/account/device-management/main", { mac, pin: "2468" });
  const old = f.jar.get("ndahi_main_device");
  assert.equal((await f.call("/api/account/device-management", undefined, { session: "secondary" })).body.isMainController, false);
  await f.call("/api/account/device-management/main", { mac: "AA:BB:CC:DD:EE:02", pin: "2468" });
  assert.equal((await f.call("/api/account/device-management", undefined, { session: "secondary", controller: old })).body.isMainController, false);
  assert.equal((await f.call("/api/account/device-management")).body.isMainController, true);
  await f.store.transaction((s) => { s.customers[0].pinHash = "recovered-credential"; });
  assert.equal((await f.call("/api/account/device-management")).body.isMainController, false);
  assert.equal((await f.store.snapshot()).vouchers[0].status, "active");
});

test("announced names require matching live DHCP address/MAC; unavailable naming never loses usage", async () => {
  const router = new RouterHotspot({ now: () => new Date("2030-01-01T12:00:00Z") });
  const usage = { name: "NC-AAAA-1111", comment: "ndahi:voucher:v1", "bytes-in": "20" };
  let fail = false;
  router.request = async (path) => {
    if (path === "ip/hotspot/user") return [usage];
    if (path === "ip/hotspot/active") return [{ user: usage.name, "mac-address": mac, address: "10.20.0.1", uptime: "1m", "bytes-in": "5" }];
    if (fail) throw Error("DHCP read not permitted");
    return [{ status: "bound", "active-mac-address": mac, "active-address": "10.20.0.9", "host-name": "wrong-device" },
      { status: "bound", "active-mac-address": mac.toLowerCase(), "active-address": "10.20.0.1", "host-name": "  imajin\u0000\u202e " }];
  };
  const result = (await router.readUsage())[0];
  assert.equal(result.devices[0].name, "imajin"); assert.equal(result.usedBytes, 25);
  fail = true;
  const fallback = (await router.readUsage())[0];
  assert.equal(fallback.devices[0].name, undefined); assert.equal(fallback.usedBytes, 25);
});
