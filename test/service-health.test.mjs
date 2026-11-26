// Connections' service checks (AdminConnections, #380; owner decisions 25 Nov):
// the router's ping and uplink traffic (no speed test), hotspot sessions,
// Mobile Money confirmation times per network, email delivery, standalone
// access points, and "Test connection". RouterOS replies are canned JSON for a
// read-only check; nothing here sends a command that changes the router.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { seal } from "../lib/network-secrets.mjs";
import { createServiceHealth, emailResult, paymentResult, routerDuration, uplinkResult, SERVICES } from "../lib/service-health.mjs";
import { recordUplinkHour, uplinkRowId } from "../lib/insights-recording.mjs";

const KEY = "b".repeat(64), ROUTER = "https://router.example.test", now = new Date("2026-11-25T18:00:00Z");
const ago = (minutes) => new Date(+now - minutes * 60000).toISOString();
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function routerFetch({ down = false, loss = "0", avg = "24ms", hotspot = true } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = String(url).replace(ROUTER + "/rest/", "");
    calls.push([init.method, path, init.body ? JSON.parse(init.body) : undefined]);
    if (down) throw new TypeError("fetch failed");
    if (path === "system/resource") return reply({ version: "7.24.5 (stable)" });
    if (path === "ip/hotspot/active") return hotspot ? reply([{ ".id": "*1" }, { ".id": "*2" }]) : reply({ error: 400, message: "no such command" }, 400);
    if (path === "ping") return reply([{ seq: "0" }, { seq: "2", sent: "3", received: loss === "100" ? "0" : "3", "packet-loss": loss, ...(loss === "100" ? {} : { "avg-rtt": avg }) }]);
    if (path.startsWith("ip/route")) return reply([{ "immediate-gw": "192.168.1.1%ether1" }]);
    if (path === "interface/monitor-traffic") return reply([{ "rx-bits-per-second": "18200000" }]);
    return reply({}, 404);
  };
  return { fetcher, calls };
}
const savedRouter = (s) => {
  s.networkSetup = { connections: { router: { kind: "router", mode: "live", secret: seal({ url: ROUTER, username: "ndahi", password: "x" }, { NETWORK_CONFIG_KEY: KEY }) } } };
};
const env = { NETWORK_CONFIG_KEY: KEY, NETWORK_ALLOWED_ORIGINS: ROUTER, MIKROTIK_MODE: "live", PAYMENT_MODE: "mesomb", EMAIL_MODE: "resend", OMADA_MODE: "standalone" };

test("RouterOS durations and the uplink's state", () => {
  assert.equal(routerDuration("23ms456us"), 23.456);
  assert.equal(routerDuration("1s200ms"), 1200);
  assert.equal(routerDuration(""), null);
  assert.deepEqual(uplinkResult({ pingMs: 24, lossPercent: 0, mbps: 18.2 }), { state: "ok", detail: { key: "adminHealthUplink", values: { ms: 24, mbps: 18.2 } } });
  assert.equal(uplinkResult({ pingMs: 180, lossPercent: 0, mbps: 3 }).state, "slow");
  assert.equal(uplinkResult({ pingMs: 30, lossPercent: 33, mbps: 3 }).state, "slow");
  assert.equal(uplinkResult({ pingMs: null, lossPercent: 100, mbps: null }).state, "down");
});

test("Mobile Money per network: confirmation time, failures in a row, or no data", () => {
  const pay = (network, created, seconds, extra = {}) => ({ id: `${network}${created}`, network, createdAt: ago(created), ...(seconds === null ? { status: "failed", updatedAt: ago(created - 1) } : { status: "paid", confirmedAt: new Date(Date.parse(ago(created)) + seconds * 1000).toISOString() }), ...extra });
  const s = { payments: [pay("mtn", 10, 90), pay("mtn", 20, 95), pay("mtn", 30, 30), pay("orange", 15, 20), pay("orange", 25, 25)] };
  assert.deepEqual(paymentResult(s, "mtn", now), { state: "slow", detail: { key: "adminHealthPaymentsSlow", values: { seconds: 90 } } });
  assert.deepEqual(paymentResult(s, "orange", now), { state: "ok", detail: { key: "adminHealthPaymentsOk" } });
  s.payments.push(pay("orange", 1, null), pay("orange", 2, null), pay("orange", 3, null));
  assert.equal(paymentResult(s, "orange", now).state, "down", "three failures in a row");
  s.payments.push(pay("mtn", 1, null, { failureReason: "insufficient_balance" }), pay("mtn", 2, null), pay("mtn", 3, null));
  assert.notEqual(paymentResult(s, "mtn", now).state, "down", "a low balance is the provider working");
  assert.equal(paymentResult({ payments: [pay("mtn", 60 * 30, 20)] }, "mtn", now).state, "nodata", "older than a day");
});

test("email from receipt emails and every send since start", () => {
  const sent = (minutes) => ({ receiptEmail: { status: "sent", sentAt: ago(minutes) } });
  assert.equal(emailResult({ payments: [sent(5), sent(10)] }, [], now).state, "ok");
  assert.equal(emailResult({ payments: [] }, [], now).state, "nodata");
  assert.equal(emailResult({ payments: [sent(5)] }, [{ ok: false, at: +now - 60000 }], now).state, "slow");
  const failing = [1, 2, 3].map((m) => ({ ok: false, at: +now - m * 1000 }));
  assert.equal(emailResult({ payments: [sent(5)] }, failing, now).state, "down");
});

test("the router check reads the saved live router: sessions, ping and uplink traffic", async () => {
  const store = createStore({ persistent: false });
  await store.transaction(savedRouter);
  const { fetcher, calls } = routerFetch(), rows = [];
  const health = createServiceHealth({ store, env, now: () => now, fetcher, recordUplink: async (row) => rows.push(row) });
  await health.run();
  const cards = Object.fromEntries(health.view({ payments: [] }).map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(cards), SERVICES);
  assert.deepEqual([cards.router.state, cards.router.detail], ["ok", { key: "adminHealthRouter", values: { count: 2 } }]);
  assert.deepEqual([cards.uplink.state, cards.uplink.detail.values], ["ok", { ms: 24, mbps: 18.2 }]);
  assert.deepEqual([cards.omada.state, cards.omada.testable], ["standalone", false]);
  assert.equal(cards.uplink.checkedAt, now.toISOString());
  // Read-only: GETs, plus RouterOS's own ping and monitor-traffic.
  assert.deepEqual(calls.filter(([method]) => method !== "GET").map(([, path]) => path), ["ping", "interface/monitor-traffic"]);
  assert.deepEqual(calls.find(([, path]) => path === "interface/monitor-traffic")[2], { interface: "ether1", once: "" });
  assert.equal(rows.length, 0, "the hour's peak is written when the hour ends");
});

test("a router that doesn't answer is Down, and its uplink is not guessed", async () => {
  const store = createStore({ persistent: false });
  await store.transaction(savedRouter);
  const health = createServiceHealth({ store, env, now: () => now, fetcher: routerFetch({ down: true }).fetcher });
  const router = await health.test("router");
  assert.deepEqual([router.state, router.detail.key, router.tested], ["down", "adminHealthRouterDown", true]);
  assert.equal(health.view({ payments: [] }).find((c) => c.id === "uplink").state, "unknown");
  // A router without the hotspot still answers.
  const quiet = createServiceHealth({ store, env, now: () => now, fetcher: routerFetch({ hotspot: false }).fetcher });
  assert.deepEqual((await quiet.test("router")).detail, { key: "adminHealthRouterNoHotspot", values: { version: "7.24.5" } });
  // No saved live router: test mode, or not set up.
  const bare = createStore({ persistent: false });
  assert.equal((await createServiceHealth({ store: bare, env: { MIKROTIK_MODE: "mock" }, now: () => now }).test("router")).state, "test");
  assert.equal((await createServiceHealth({ store: bare, env: { MIKROTIK_MODE: "live" }, now: () => now }).test("uplink")).state, "off");
});

test("the busiest uplink reading of each hour is kept for Insights", async () => {
  const store = createStore({ persistent: false });
  await store.transaction(savedRouter);
  let at = new Date("2026-11-25T18:10:00Z");
  const rows = [], health = createServiceHealth({ store, env, now: () => at, fetcher: routerFetch().fetcher, recordUplink: async (row) => rows.push(row) });
  await health.run();
  at = new Date("2026-11-25T19:05:00Z");
  await health.run();
  assert.deepEqual(rows, [{ hour: "2026-11-25T18:00:00.000Z", peakMbps: 18.2, pingMs: 24 }]);
  const s = { insightCounters: [] };
  recordUplinkHour(s, { peakMbps: 18.2, pingMs: 24 }, new Date(rows[0].hour));
  recordUplinkHour(s, { peakMbps: 9, pingMs: 30 }, new Date(rows[0].hour));
  assert.deepEqual(s.insightCounters, [{ id: uplinkRowId(rows[0].hour), type: "uplink_hourly", at: rows[0].hour, hour: 19, peakMbps: 18.2, pingMs: 24, updatedAt: rows[0].hour }]);
});

test("the dashboard carries the cards, and Test connection is for owners and operators", async (t) => {
  const store = createStore({ persistent: false }), secret = "health-secret";
  await store.transaction((s) => {
    savedRouter(s);
    for (const role of ["owner", "operator", "auditor"]) {
      s.adminUsers.push({ id: role, username: role, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: role, role, tokenHash: hashSecret(`t-${role}`, secret), csrfToken: `c-${role}`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    s.payments.push({ id: "p1", network: "orange", status: "paid", createdAt: ago(30), confirmedAt: ago(29.5) });
  });
  // The server reads the same fixed clock as the seeded payments, so the test does not expire a day later.
  const server = createServer({ store, now: () => now, validateConfig: false, routerFetch: routerFetch().fetcher, env: { ...env, NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, role, data) => {
    const r = await fetch(base + path, { method: data ? "POST" : "GET", headers: { "content-type": "application/json", cookie: `admin_session=t-${role}`, origin: "http://admin.test", "x-csrf-token": `c-${role}` }, body: data ? JSON.stringify(data) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const dash = (await call("/api/admin/dashboard", "owner")).body;
  assert.deepEqual(dash.serviceHealth.map((c) => [c.id, c.state]), [["uplink", "pending"], ["router", "pending"], ["omada", "pending"], ["mtn", "nodata"], ["orange", "ok"], ["email", "nodata"]]);
  assert.equal(dash.staffSignIn, "pin");
  assert.equal(JSON.stringify(dash.serviceHealth).includes("router.example.test"), false, "no address or secret");
  const tested = await call("/api/admin/service-health/test", "operator", { service: "uplink" });
  assert.deepEqual([tested.status, tested.body.check.state, tested.body.check.tested], [200, "ok", true]);
  assert.equal((await call("/api/admin/service-health/test", "auditor", { service: "uplink" })).status, 403);
  assert.equal((await call("/api/admin/service-health/test", "owner", { service: "starlink" })).status, 400);
  assert.equal((await call("/api/admin/dashboard", "owner")).body.serviceHealth.find((c) => c.id === "router").state, "ok", "the router was read with the uplink");
  const auditor = (await call("/api/admin/dashboard", "auditor")).body.serviceHealth;
  assert.deepEqual(auditor.map((c) => c.id), ["uplink", "router", "omada"], "no payment cards without payment access");
});
