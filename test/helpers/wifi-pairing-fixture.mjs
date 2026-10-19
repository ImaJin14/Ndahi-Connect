import http from "node:http";
import argon2 from "argon2";
import { createHandler, createStore } from "../../server.mjs";
import { hashSecret } from "../../lib/security.mjs";

const secret = "pairing-tests", pinHash = await argon2.hash("2468");
export const mainMac = "AA:BB:CC:DD:EE:01", guestMac = "AA:BB:CC:DD:EE:03";
export const publicRoot = "/api/wifi/pairing", ownerRoot = "/api/account/device-management/pairing";
// A real API, isolated memory state, and a synthetic router. No production access.
export async function pairingFixture({ origin = "http://customer.test", env = {}, router = {}, now = new Date("2030-01-01T12:00:00Z") } = {}) {
  let at = now;
  const store = createStore({ persistent: false }), calls = [];
  const fakeRouter = {
    async readGuestDevice({ mac, address }) { return { mac, address, loginAddress: address, hostId: "*guest-" + mac.slice(-2), server: "ndahi-hotspot", name: "Galaxy Note 8" }; },
    async connectWifiDevice(device) { calls.push(device); return { confirmed: true, device: { mac: device.mac, address: device.loginAddress, sessionId: "*new", startedAt: at.toISOString(), name: "Galaxy Note 8", usedBytes: 0 } }; },
    async readUsage() { return []; },
    ...router,
  };
  await store.transaction((s) => {
    s.networkSetup = { runtimeRouterEnabled: true, connections: { router: { mode: "live", revision: "router-1" } }, assistedConnections: { enabled: true, revision: "router-1" } };
    s.customers.push({ id: "c1", name: "Imajin", phone: "670050001", pinHash,
      wifiMainDevice: { mac: mainMac, name: "imajin", routerRevision: "router-1", controllerHash: hashSecret("controller", secret), pinVersion: hashSecret(pinHash, secret) } },
    { id: "c2", phone: "670050002", pinHash });
    for (const [id, customerId] of [["main", "c1"], ["secondary", "c1"], ["other", "c2"]]) s.dashboardSessions.push({ id, customerId,
      tokenHash: hashSecret(id, secret), csrfToken: "csrf", expiresAt: new Date(+at + 86400000).toISOString() });
    s.vouchers.push({ id: "v1", customerId: "c1", code: "NC-AAAA-1111", status: "active", planId: "family", deviceLimit: 3,
      expiresAt: new Date(+at + 86400000).toISOString(), activatedAt: at.toISOString(), quotaBytes: 1e9, usedBytes: 20,
      routerSyncStatus: "synchronized", wifiDevicesAt: at.toISOString(), wifiDevices: [1, 2].map((n) => ({
        mac: `AA:BB:CC:DD:EE:0${n}`, name: n === 1 ? "imajin" : "iPad", address: `10.20.0.${n}`, sessionId: `*${n}`,
        startedAt: new Date(+at - 60000).toISOString(), usedBytes: 5,
      })) });
  });
  const handler = createHandler({ store, router: fakeRouter, now: () => at, validateConfig: false, env: {
    NODE_ENV: "production", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: origin, LOG_LEVEL: "warn", NETWORK_QUEUE_ENABLED: "true", BILLING_WORKER_ENABLED: "false",
    SECURITY_ALERTS_ENABLED: "false", TRUST_PROXY: "render", COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: "203.0.113.10", ...env,
  } });
  // Explicit worker steps make Connecting and confirmation separately observable.
  handler.routerProcessor.wake = () => {};
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, input, { session = "main", controller = "controller", csrf = "csrf", address = "203.0.113.10" } = {}) => {
    const response = await fetch(api + path, { method: input === undefined ? "GET" : "POST", headers: {
      origin, "content-type": "application/json", "x-csrf-token": csrf, "cf-connecting-ip": address,
      cookie: `customer_session=${session}; ndahi_main_device=${controller}`,
    }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const request = (overrides = {}, options) => call(publicRoot + "/request", { phone: "670050001", code: "NC-AAAA-1111", key: "a".repeat(32), mac: guestMac, address: "10.20.0.30", ...overrides }, { session: "", controller: "", ...options });
  const close = () => new Promise((r) => { server.close(r); server.closeAllConnections(); });
  return { store, handler, api, call, request, calls, close, now: () => at, advance(seconds) { at = new Date(+at + seconds * 1000); },
    async process(id) { const s = await store.snapshot(); return handler.routerProcessor.process(id || s.wifiPairingRequests[0]?.commandId); } };
}
