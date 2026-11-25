import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";
import { blank, createStore } from "../lib/api/state.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createRouterCommandProcessor, enqueueRouterCommand } from "../lib/router-queue.mjs";
import { adminWifiCustomers, adminWifiSummary } from "../lib/wifi-devices.mjs";
import { sessionDay, usedToday, uptimeSeconds } from "../lib/session-day.mjs";
import { applyHomeUsage, ensureHome, queueHome, reserveHomeLink, requestHomeMode } from "../lib/home.mjs";
import { createHomeService } from "../lib/home-service.mjs";

// Live devices (#381, canvas AdminDevices; owner 24-25 Nov): one row per
// customer, data used today (from midnight in Douala), a Home WISP router as
// one device, Disconnect that ends the session only, Disconnect all, and the
// Home "end session" step.

const now = new Date("2026-11-25T16:30:00Z"); // 17:30 in Douala

test("today counts each session from midnight in Douala", () => {
  assert.deepEqual(sessionDay(null, "2026-11-25T07:12:00Z", 420e6, now), { day: "2026-11-25", dayStartBytes: 0 }, "started today: all of it");
  assert.deepEqual(sessionDay(null, "2026-11-24T20:00:00Z", 5e9, now), { day: "2026-11-25", dayStartBytes: 5e9 }, "first seen today: from now on");
  assert.deepEqual(sessionDay({ day: "2026-11-25", dayStartBytes: 3e9, usedBytes: 4e9 }, "2026-11-24T20:00:00Z", 6e9, now), { day: "2026-11-25", dayStartBytes: 3e9 });
  // 23:00:30 UTC is 00:00:30 in Douala: the last reading before midnight starts the day.
  assert.deepEqual(sessionDay({ day: "2026-11-24", dayStartBytes: 0, usedBytes: 3e9 }, "2026-11-24T20:00:00Z", 3.2e9, new Date("2026-11-24T23:00:30Z")), { day: "2026-11-25", dayStartBytes: 3e9 });
  assert.equal(usedToday({ day: "2026-11-25", usedBytes: 6e9, dayStartBytes: 3e9 }, now), 3e9);
  assert.equal(usedToday({ day: "2026-11-24", usedBytes: 6e9, dayStartBytes: 3e9 }, now), 0, "an old reading says nothing about today");
  assert.equal(uptimeSeconds("1d02:03:04"), 93784);
  assert.equal(uptimeSeconds("2h5m10s"), 7510);
});

test("the router reading keeps each session's start of day, across midnight", async () => {
  const store = createStore({ persistent: false }), device = { mac: "AA:BB:CC:DD:EE:01", sessionId: "*A", startedAt: "2026-11-24T08:00:00Z" };
  await store.transaction((s) => {
    s.networkSetup = { runtimeRouterEnabled: true };
    s.vouchers.push({ id: "v1", customerId: "c1", code: "NC-DAY", status: "active", usedBytes: 0, quotaBytes: null, expiresAt: "2026-11-30T00:00:00Z" });
  });
  const read = async (at, usedBytes) => {
    await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, () => at));
    await createRouterCommandProcessor({ store, now: () => at, router: { readUsage: async () => [{ voucherId: "v1", usedBytes: 0, devices: [{ ...device, usedBytes }] }] } }).process();
    return (await store.snapshot()).vouchers[0].wifiDevices[0];
  };
  const before = await read(new Date("2026-11-24T22:50:00Z"), 3e9); // 23:50 in Douala
  assert.deepEqual([before.day, before.dayStartBytes], ["2026-11-24", 0]);
  const after = await read(new Date("2026-11-24T23:10:00Z"), 3.3e9); // 00:10 the next day
  assert.deepEqual([after.day, after.dayStartBytes], ["2026-11-25", 3e9]);
  assert.equal(usedToday(after, new Date("2026-11-24T23:10:00Z")), 0.3e9);
});

// The artboard's five customers.
function liveState() {
  const s = blank(), read = new Date(+now - 20000).toISOString();
  s.customers.push({ id: "amina", name: "Amina N.", phone: "670001245" }, { id: "fon", name: "J. Fon", phone: "690004417" },
    { id: "ngum", name: "Ngum family", phone: "650002233", homeConnectionId: "h1" }, { id: "grace", name: "Grace T.", phone: "670007788" });
  s.bundles.push({ id: "gig-standard", name: "Gig Standard", price: 5000, quotaGb: 20, validityHours: 168, deviceLimit: 2, status: "archived" });
  const dev = (mac, startedAt, usedBytes) => ({ mac, sessionId: "*" + mac.slice(-2), startedAt, usedBytes, day: "2026-11-25", dayStartBytes: 0 });
  const v = (id, customerId, more) => ({ id, customerId, code: `NC-${id}`, status: "active", quotaBytes: null, usedBytes: 0, expiresAt: "2026-11-27T10:00:00Z", wifiDevicesAt: read, ...more });
  s.vouchers.push(
    v("va", "amina", { accessType: "personal_unlimited", deviceSlots: 4, deviceLimit: 4, validityHours: 168,
      wifiDevices: [dev("AA:00:00:00:00:01", "2026-11-25T07:12:00Z", 420e6), dev("AA:00:00:00:00:02", "2026-11-25T08:40:00Z", 1.1e9), dev("AA:00:00:00:00:03", "2026-11-25T09:05:00Z", 650e6), dev("AA:00:00:00:00:04", "2026-11-25T09:30:00Z", 2.8e9)] }),
    v("vf", "fon", { planId: "gig-standard", deviceLimit: 2, wifiDevices: [dev("BB:00:00:00:00:01", "2026-11-25T06:55:00Z", 760e6), dev("BB:00:00:00:00:02", "2026-11-25T05:30:00Z", 2.3e9)] }),
    v("vn", "ngum", { accessType: "home_wisp_unlimited", accessMode: "home", homeStatus: "connected", homeGeneration: 1, homeOnlineSince: "2026-11-23T17:02:00Z",
      usedBytes: 50e9, homeDay: { date: "2026-11-25", bytes: 40.6e9 }, lastUsageSyncAt: new Date(+now - 5000).toISOString(), wifiDevicesAt: undefined }),
    v("vg", "grace", { accessType: "personal_unlimited", deviceSlots: 1, deviceLimit: 1, validityHours: 24, wifiDevices: [dev("CC:00:00:00:00:01", "2026-11-25T12:05:00Z", 310e6)] }),
    v("vv", null, { code: "K7PM-42XQ", accessType: "personal_unlimited", deviceSlots: 1, deviceLimit: 1, validityHours: 5, wifiDevices: [dev("DD:00:00:00:00:01", "2026-11-25T15:48:00Z", 95e6)] }),
  );
  ensureHome(s).homeConnections.push({ id: "h1", customerId: "ngum", status: "linked", mac: "D4:6E:0E:9C:31:E4", generation: 1, routerRevision: "" });
  s.wifiDeviceGrants = ["01", "02", "03", "04"].map((n, i) => ({ id: "g" + n, customerId: "amina", voucherId: "va", mac: "AA:00:00:00:00:" + n, status: "approved", routerRevision: "", createdAt: `2026-11-25T0${i}:00:00Z` }));
  return s;
}

test("one row per customer: slots, an older plan's devices, a Home WISP router, a code without an account", () => {
  const s = liveState(), plans = { vf: { name: "Gig Standard" } };
  const rows = adminWifiCustomers(s, now, { planOf: (v) => plans[v.id] || null });
  assert.deepEqual(rows.map((r) => [r.name || r.code, r.devices.length, r.slots, r.router]), [
    ["Amina N.", 4, 4, false], ["J. Fon", 2, null, false], ["Ngum family", 1, null, true], ["Grace T.", 1, 1, false], ["K7PM-42XQ", 1, 1, false]]);
  const [amina, fon, ngum, , code] = rows;
  assert.deepEqual(amina.devices.map((d) => d.slot), [1, 2, 3, 4]);
  assert.equal(amina.todayBytes, 4.97e9);
  assert.equal(amina.since, "2026-11-25T07:12:00Z", "the earliest");
  assert.equal(amina.phone, "670001245", "for search by number");
  assert.equal(fon.planName, "Gig Standard");
  assert.equal(fon.accessType, null);
  assert.deepEqual([ngum.devices[0].mac, ngum.devices[0].startedAt, Math.round(ngum.todayBytes / 1e8)], ["D4:6E:0E:9C:31:E4", "2026-11-23T17:02:00Z", 94]);
  assert.deepEqual([code.customerId, code.name, code.code], [null, null, "K7PM-42XQ"]);
  // Without contact access, no names or numbers; without code access, no code.
  const restricted = adminWifiCustomers(s, now, { names: false, codes: false });
  assert.ok(restricted.every((r) => r.name === null && r.phone === null && r.code === null));
  // A Home WISP router only while the Home reading says it is connected.
  s.vouchers.find((v) => v.id === "vn").homeStatus = "pending";
  assert.equal(adminWifiCustomers(s, now).some((r) => r.router), false);
});

test("a Home WISP bundle never makes the reading look stale", () => {
  const s = liveState();
  assert.equal(adminWifiSummary(s, now).state, "ready");
  s.vouchers = s.vouchers.filter((v) => v.id === "vn");
  assert.equal(adminWifiSummary(s, now).state, "idle");
});

test("the Home reading records today's data and when the router connected", () => {
  const s = blank(), v = { id: "v1", customerId: "c1", status: "active", quotaBytes: null, usedBytes: 1000, homeGeneration: 1, homeAccounting: { base: 1000, raw: 0, epoch: "e1" } };
  applyHomeUsage(s, v, { bytes: 500, epoch: "e1", generation: 1, connected: true, startedAt: "2026-11-25T15:00:00.000Z" }, now);
  assert.deepEqual(v.homeDay, { date: "2026-11-25", bytes: 1000 });
  assert.equal(v.homeOnlineSince, "2026-11-25T15:00:00.000Z");
  applyHomeUsage(s, v, { bytes: 800, epoch: "e1", generation: 1, connected: true }, new Date(+now + 15000));
  assert.deepEqual([v.usedBytes, v.homeDay.bytes, v.homeOnlineSince], [1800, 1000, "2026-11-25T15:00:00.000Z"], "today is 800 bytes");
  applyHomeUsage(s, v, { bytes: 800, epoch: "e1", generation: 1, connected: false }, new Date(+now + 30000));
  assert.equal(v.homeOnlineSince, undefined);
  applyHomeUsage(s, v, { bytes: 900, epoch: "e1", generation: 1, connected: true }, new Date("2026-11-25T23:30:00Z"));
  assert.deepEqual(v.homeDay, { date: "2026-11-26", bytes: 1800 }, "a new day in Douala starts from the last count");
  assert.equal(v.homeOnlineSince, "2026-11-25T23:30:00.000Z", "first seen connected, when the reading has no start");
});

test("Disconnect on a Home WISP router ends only its session; a failure retries and never revokes", async () => {
  const at = new Date("2030-01-01T12:00:00Z"), store = createStore({ persistent: false }), calls = [], meter = { bytes: 0, epoch: null, connected: false };
  let failEnd = true, clock = at;
  await store.transaction((s) => {
    s.customers.push({ id: "c1", phone: "670050001" });
    s.networkSetup = { connections: { router: { mode: "live", revision: "r1" } }, runtimeRouterEnabled: true };
    s.vouchers.push({ id: "v1", customerId: "c1", planId: "daily", code: "NC-AAAA-1111", status: "active", quotaBytes: null, usedBytes: 20, deviceLimit: 3, activatedAt: at.toISOString(), expiresAt: new Date(+at + 864e5).toISOString() });
    ensureHome(s).homeChallenges.push({ id: "ch1", customerId: "c1", sessionId: "s1", status: "ready", expiresAt: new Date(+at + 120000).toISOString(), routerRevision: "r1" });
    reserveHomeLink(s, "c1", { challengeId: "ch1", mac: "AA:BB:CC:DD:EE:99", address: "10.20.0.9", hostId: "*h1", sessionId: "*s1" }, "ch1", "Home", at);
    requestHomeMode(s, "c1", "v1", "home", at);
  });
  const router = {
    async disconnectVoucher() { return { disconnected: true }; },
    async readUsage() { return [{ voucherId: "v1", usedBytes: 20 }]; },
    async authorizeHome({ voucher: v }) { meter.epoch = v.homeMeterId || v.homeGeneration; meter.connected = true; return { ...meter, generation: v.homeGeneration, base: v.usedBytes, confirmed: true }; },
    async readHome(v) { return { ...meter, generation: v.homeGeneration }; },
    async revokeHome(v) { calls.push(["revoke", v.homeGeneration]); meter.connected = false; return { confirmed: true, reading: { ...meter, generation: v.homeGeneration } }; },
    async endHomeSession(v) { calls.push(["end", v.id]); if (failEnd) throw Error("router unreachable"); return { ended: 1 }; },
  };
  const service = createHomeService({ store, router, env: { NDAHI_HOME_ENABLED: "true" }, now: () => clock });
  await service.run();
  assert.equal((await store.snapshot()).vouchers[0].homeStatus, "connected");
  await store.transaction((s) => queueHome(s, "end_session", "c1", clock, { voucherId: "v1", mode: "home" }));
  await service.run();
  let s = await store.snapshot(), op = s.homeOperations.find((o) => o.kind === "end_session");
  assert.equal(op.status, "retry");
  assert.deepEqual(calls.filter(([kind]) => kind === "revoke"), [], "a failed end never revokes the router");
  assert.equal(s.vouchers[0].homeStatus, "connected", "and leaves the bundle as it was");
  failEnd = false;
  clock = new Date(+clock + 60001);
  await service.run();
  s = await store.snapshot(); op = s.homeOperations.find((o) => o.kind === "end_session");
  assert.deepEqual([op.status, op.result], ["processed", "ended"]);
  assert.ok(s.homeUsageObservations.some((o) => o.type === "router.session_end_confirmed" && o.voucherId === "v1" && o.ended === 1));
  assert.deepEqual(calls.filter(([kind]) => kind === "revoke"), []);
});

test("the endpoints: rows on request, Disconnect keeps the slot, Disconnect all, and a Home router", async (t) => {
  const store = createStore({ persistent: false }), secret = "live-devices-secret";
  await store.transaction((s) => {
    Object.assign(s, liveState());
    s.networkSetup = { runtimeRouterEnabled: true };
    for (const role of ["owner", "auditor"]) s.adminSessions.push({ tokenHash: hashSecret(role, secret), role, csrfToken: "csrf", expiresAt: "2030-01-01T00:00:00Z" });
  });
  const server = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "production", BOOTSTRAP_MODE: "false", PAYMENT_MODE: "mock", MIKROTIK_MODE: "live",
    ADMIN_SESSION_SECRET: secret, ADMIN_APP_URL: "https://admin.test", ALLOWED_ADMIN_ORIGINS: "https://admin.test", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, role = "owner") => {
    const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { cookie: `admin_session=${role}`, origin: "https://admin.test", "x-csrf-token": "csrf", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  assert.equal("customers" in (await call("/api/admin/wifi-devices")).body, false, "Home asks only for the counts");
  const rows = (await call("/api/admin/wifi-devices?customers=1")).body.customers;
  assert.deepEqual(rows.map((r) => r.name || r.code), ["Amina N.", "J. Fon", "Ngum family", "Grace T.", "K7PM-42XQ"]);
  const audited = (await call("/api/admin/wifi-devices?customers=1", undefined, "auditor")).body.customers;
  assert.ok(audited.every((r) => r.phone === null), "an auditor sees no numbers");

  // Disconnect: the session only. Amina's device keeps its approval, so its slot.
  const [first] = rows[0].devices;
  const kick = await call("/api/admin/wifi-devices/disconnect", { voucherId: "va", mac: first.mac, sessionId: first.sessionId, startedAt: first.startedAt, retainApproval: true });
  assert.equal(kick.status, 202);
  let s = await store.snapshot();
  assert.equal(s.wifiDeviceGrants.find((g) => g.mac === first.mac).status, "approved");
  assert.equal(s.routerCommands.find((c) => c.action === "disconnect_wifi_device").kind, "wifi_session_disconnect");
  // Disconnect all of J. Fon's sessions, audited once.
  const all = await call("/api/admin/wifi-devices/disconnect-all", { customerId: "fon" });
  assert.deepEqual([all.status, all.body.requested], [202, 2]);
  s = await store.snapshot();
  assert.ok(s.auditLogs.some((a) => a.action === "wifi_device.disconnect_all_requested" && a.meta.requested === 2));
  // A Home WISP router: the Home worker ends its session.
  const home = await call("/api/admin/wifi-devices/disconnect", { voucherId: "vn" });
  assert.equal(home.status, 202);
  s = await store.snapshot();
  // Queued for the Home worker, which the request wakes (here, with no router, it then retries).
  assert.ok(s.homeOperations.some((o) => o.kind === "end_session" && o.voucherId === "vn"));
  assert.ok(s.auditLogs.some((a) => a.action === "wifi_device.disconnect_requested" && a.meta.router === true));
  // An auditor reads but never disconnects.
  assert.equal((await call("/api/admin/wifi-devices/disconnect-all", { customerId: "grace" }, "auditor")).status, 403);
});
