// Home WISP router page (#351, canvas PhoneHomeRouter; owner 27 Nov: extend the
// Home API). State and API rules only: the router's own answers are proved
// on-site (docs/operations/home-wisp-test-plan.md), so the Home service is a
// stand-in here and no router is simulated.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { blank } from "../lib/api/state.mjs";
import { ensureHome, reserveHomeLink, homeView } from "../lib/home.mjs";
import { createHomeRoutes } from "../lib/api/home.mjs";

const at = new Date("2026-11-25T10:00:00Z"), MAC = "AA:BB:CC:9C:31:E4";
function state() {
  const s = blank();
  s.customers.push({ id: "c1", phone: "670050001", name: "Amina" });
  s.networkSetup = { connections: { router: { mode: "live", revision: "r1" } }, runtimeRouterEnabled: true };
  ensureHome(s);
  return s;
}
const wisp = (s, extra = {}) => {
  const v = { id: randomUUID(), customerId: "c1", planId: "home-wisp-30d", code: "NC-HOME-0001", status: "available", quotaBytes: null, usedBytes: 0, deviceLimit: 1,
    accessType: "home_wisp_unlimited", deviceSlots: 1, startsOnFirstConnection: true, validityHours: 720, createdAt: at.toISOString(), ...extra };
  s.vouchers.unshift(v);
  return v;
};
function register(s) {
  const id = randomUUID();
  s.homeChallenges.push({ id, customerId: "c1", sessionId: "sess", status: "ready", expiresAt: new Date(+at + 120000).toISOString(), routerRevision: "r1" });
  return reserveHomeLink(s, "c1", { challengeId: id, mac: MAC, address: "10.20.0.9", hostId: "*h", sessionId: "*s" }, id, "Home router", at);
}

test("the Home view tells the page the Home WISP bundle's state: waiting, sharing or paused, with the last try", () => {
  const s = state();
  assert.equal(homeView(s, "c1", at, true).homeWisp, null, "no Home WISP bundle, no Home WISP state");
  const v = wisp(s);
  assert.deepEqual(homeView(s, "c1", at, true).homeWisp, { id: v.id, waiting: true, expiresAt: null, sharing: null, lastTryAt: null });
  const link = register(s);
  Object.assign(v, { status: "active", activatedAt: at.toISOString(), expiresAt: "2026-12-22T17:03:00.000Z", homeStatus: "connected" });
  let view = homeView(s, "c1", at, true);
  assert.equal(view.link.identifierTail, "9C:31:E4");
  assert.deepEqual([view.homeWisp.waiting, view.homeWisp.expiresAt, view.homeWisp.sharing], [false, "2026-12-22T17:03:00.000Z", "online"]);
  // The entitlement can't be confirmed: paused, with the last automatic try.
  v.homeStatus = "activation_pending";
  s.homeOperations.push({ id: "op1", customerId: "c1", kind: "refresh", status: "retry", attempts: 2, lastAttemptAt: "2026-11-25T09:58:00.000Z", nextAttemptAt: "2026-11-25T10:00:08.000Z" });
  view = homeView(s, "c1", at, true);
  assert.deepEqual([view.homeWisp.sharing, view.homeWisp.lastTryAt], ["paused", "2026-11-25T09:58:00.000Z"]);
  assert.equal(link.status, "linked");
});

test("an earlier NDAHI Home bundle gets no Home WISP state", () => {
  const s = state();
  s.vouchers.push({ id: "old", customerId: "c1", status: "active", accessMode: "home", quotaBytes: 5e10, usedBytes: 0, activatedAt: at.toISOString(), expiresAt: "2026-12-01T00:00:00Z" });
  register(s);
  assert.equal(homeView(s, "c1", at, true).homeWisp, null);
});

// "I've done this — find my router": the router this local sign-in came through,
// masked, before the PIN registers it; nothing is linked.
async function detect({ input = {}, onWifi = true, enabled = true, places = false, challenge = "ready" } = {}) {
  const s = state(), id = randomUUID(), calls = [];
  s.dashboardSessions.push({ id: "sess", customerId: "c1" });
  s.homeChallenges.push({ id, customerId: "c1", sessionId: "sess", status: challenge, expiresAt: new Date(+at + 120000).toISOString(), routerRevision: "r1" });
  const routes = createHomeRoutes({
    mutate: async (fn) => fn(s), auth: () => s.dashboardSessions[0], clock: () => at,
    env: { NDAHI_HOME_ENABLED: enabled ? "true" : "false", ...(places ? { DEVICE_PLACES_ENABLED: "true" } : {}) },
    coverage: { enabled: true, access: () => ({ allowed: onWifi }) },
    homeService: { proof: async (...args) => { calls.push(args); return { challengeId: id, mac: MAC, address: "10.20.0.9" }; } },
    networkSetup: { omadaClients: async () => [{ mac: MAC, ap: "AP-Market", active: true }] },
  });
  let status, body;
  const res = { setHeader() {}, writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
  const req = { method: "POST", headers: {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ enrollmentId: id, ...input })); } };
  await routes(req, res, new URL("http://api.test/api/account/home/detect"));
  return { status, body, calls, s };
}

test("find my router answers with the masked upstream address, when it was seen and, with device places on, the access point", async () => {
  let r = await detect();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { router: { identifierTail: "9C:31:E4", seenAt: at.toISOString(), place: null } });
  assert.equal(r.calls.length, 1);
  assert.equal(r.s.homeConnections.length, 0, "nothing is linked before the PIN");
  r = await detect({ places: true });
  assert.equal(r.body.router.place, "AP-Market");
  assert.doesNotMatch(JSON.stringify(r.body), /AA:BB:CC/);
});

test("find my router needs NDAHI Home on, NDAHI Wi-Fi, a ready local sign-in, and never takes a router identifier", async () => {
  assert.equal((await detect({ enabled: false })).body.code, "HOME_DISABLED");
  assert.equal((await detect({ onWifi: false })).body.code, "WIFI_REQUIRED");
  assert.equal((await detect({ challenge: "pending" })).body.code, "HOME_PROOF_REQUIRED");
  const spoof = await detect({ input: { mac: MAC } });
  assert.equal(spoof.body.code, "HOME_UNTRUSTED_IDENTIFIER");
  assert.equal(spoof.calls.length, 0);
});
