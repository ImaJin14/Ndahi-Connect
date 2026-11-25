// Home WISP Unlimited on the NDAHI Home router path (#336; spec §5). State and
// API rules only. The owner proves router behaviour on the test HotSpot with
// docs/operations/home-wisp-test-plan.md, so there is no simulated router here.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { blank } from "../lib/api/state.mjs";
import { ensureHome, reserveHomeLink, requestHomeMode } from "../lib/home.mjs";
import { startHomeWisp, waitingHomeWisp } from "../lib/home-wisp.mjs";
import { startWaitingBundle, waitingBundle } from "../lib/device-slots.mjs";
import { reservePurchase } from "../lib/domain/purchases.mjs";
import { redeemVoucher } from "../lib/domain/vouchers.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

const at = new Date("2026-11-25T10:00:00Z"), HOUR = 36e5, MAC = "AA:BB:CC:9C:31:E4";

// A router registered the way the customer's local sign-in through it does:
// a one-use challenge, and the MAC RouterOS reported for it.
function registerRouter(s, customerId, now = at, mac = MAC) {
  ensureHome(s);
  const id = randomUUID();
  s.homeChallenges.push({ id, customerId, sessionId: "sess", status: "ready", expiresAt: new Date(+now + 120000).toISOString(), routerRevision: "r1" });
  return reserveHomeLink(s, customerId, { challengeId: id, mac, address: "10.20.0.9", hostId: "*h", sessionId: "*s" }, id, "Home router", now);
}
const waiting = (s, customerId, extra = {}) => {
  const v = { id: randomUUID(), customerId, planId: "home-wisp-30d", code: "NC-HOME-0001", status: "available", activatedAt: null, expiresAt: null, quotaBytes: null, usedBytes: 0,
    deviceLimit: 1, accessType: "home_wisp_unlimited", deviceSlots: 1, sharing: true, startsOnFirstConnection: true, validityHours: 720, ...extra };
  s.vouchers.unshift(v);
  return v;
};
function state() {
  const s = blank();
  s.customers.push({ id: "c1", phone: "670050001", name: "Amina" }, { id: "c2", phone: "670050002", name: "Paul" });
  s.networkSetup = { connections: { router: { mode: "live", revision: "r1" } }, runtimeRouterEnabled: true };
  seedCatalogue(s, at);
  s.catalogue.mode = "unlimited";
  return s;
}

test("registering the router starts the waiting bundle, once, on that router, with the validity it was sold with", () => {
  const s = state(), v = waiting(s, "c1");
  assert.equal(startHomeWisp(s, "c1", at), null, "no router yet: it keeps waiting");
  assert.equal(v.status, "available");
  const later = new Date(+at + 3 * 864e5), link = registerRouter(s, "c1", later);
  assert.equal(startHomeWisp(s, "c1", later), v);
  assert.deepEqual([v.status, v.activatedAt, v.expiresAt, v.accessMode, v.homeConnectionId, v.homeGeneration, v.homeStatus],
    ["active", later.toISOString(), new Date(+later + 720 * HOUR).toISOString(), "home", link.id, link.generation, "activation_pending"]);
  assert.ok(s.homeOperations.some((o) => o.kind === "activate" && o.voucherId === v.id && o.connectionId === link.id), "handed to the Home worker");
  assert.equal(s.routerCommands.some((c) => c.targetId === v.id), false, "never on the direct HotSpot path");
  assert.ok(s.auditLogs.some((a) => a.action === "voucher.started_on_router_registration" && a.meta.voucherId === v.id && a.meta.macSuffix === "31:E4"));
  assert.equal(startHomeWisp(s, "c1", new Date(+later + HOUR)), null, "never restarted");
  assert.equal(v.activatedAt, later.toISOString());
});

test("another account can't register the same router, and a gift saved behind a running bundle waits", () => {
  const s = state();
  registerRouter(s, "c1");
  assert.throws(() => registerRouter(s, "c2"), { code: "HOME_ALREADY_LINKED" });
  const t = state(), gift = waiting(t, "c1");
  t.vouchers.push({ id: "running", customerId: "c1", planId: "unlimited-7d-1", status: "active", expiresAt: new Date(+at + 2 * 864e5).toISOString(), accessType: "personal_unlimited" });
  registerRouter(t, "c1");
  assert.equal(startHomeWisp(t, "c1", at), null);
  assert.equal(gift.status, "available");
});

test("never started or used on the direct path: a code, a device request or a mode switch", () => {
  const s = state(), v = waiting(s, "c1");
  assert.equal(startWaitingBundle(s, v, at, "code"), false);
  assert.equal(waitingBundle(s, "c1"), undefined, "a device's access request doesn't see it");
  assert.equal(waitingHomeWisp(s, "c1"), v);
  const before = JSON.stringify(s.vouchers);
  const redeemed = redeemVoucher(s, { phone: "670050001", code: v.code }, { clock: () => at, requester: { ip: "198.51.100.2" }, generic: "Check the code." });
  assert.deepEqual([redeemed.status, redeemed.body.code], [409, "HOME_WISP_ROUTER_REQUIRED"]);
  assert.equal(JSON.stringify(s.vouchers), before, "nothing changed");
  assert.equal(s.routerCommands.length, 0);
  // With the router registered, the code starts it there instead.
  registerRouter(s, "c1");
  const started = redeemVoucher(s, { phone: "670050001", code: v.code }, { clock: () => at, requester: { ip: "198.51.100.2" }, generic: "Check the code." });
  assert.deepEqual([started.status, started.body.code, v.accessMode, v.status], [202, "HOME_WISP_STARTED", "home", "active"]);
  // Each Unlimited bundle keeps its access type.
  s.vouchers.push({ id: "personal", customerId: "c1", planId: "unlimited-7d-1", status: "active", quotaBytes: null, expiresAt: new Date(+at + 864e5).toISOString(), accessType: "personal_unlimited" });
  assert.throws(() => requestHomeMode(s, "c1", "personal", "home", at), /registered devices, not through a router/);
  assert.throws(() => requestHomeMode(s, "c1", v.id, "direct", at), /only through your registered router/);
});

test("Personal Unlimited is never bought into Home router mode; Home WISP isn't sold while NDAHI Home is off", () => {
  const s = state();
  registerRouter(s, "c1");
  const options = { clock: () => at, provider: "mock", accountCustomerId: "c1", requester: { ip: "198.51.100.2" }, homeEnabled: true };
  const personal = reservePurchase(s, { planId: "unlimited-7d-1", action: "switch", accessMode: "home", requestKey: "p".repeat(32) }, options);
  assert.equal(personal.status, 201, JSON.stringify(personal.body));
  assert.equal(personal.payment.accessMode, undefined, "Personal Unlimited stays on its devices");
  const t = state();
  const off = reservePurchase(t, { planId: "home-wisp-30d", action: "switch", requestKey: "h".repeat(32) }, { ...options, homeEnabled: false });
  assert.deepEqual([off.status, off.body.code], [409, "HOME_WISP_UNAVAILABLE"]);
  assert.equal(t.payments.length, 0);
  const on = reservePurchase(t, { planId: "home-wisp-30d", action: "switch", requestKey: "i".repeat(32) }, options);
  assert.equal(on.status, 201, JSON.stringify(on.body));
});

// Paid through the API: waits without a router, starts on a registered one.
async function server(t, homeEnabled) {
  const store = createStore({ persistent: false }), secret = "home-wisp-tests";
  let now = at;
  await store.transaction((s) => {
    seedCatalogue(s, now); s.catalogue.mode = "unlimited";
    s.networkSetup = { connections: { router: { mode: "live", revision: "r1" } }, runtimeRouterEnabled: true };
    s.adminUsers.push({ id: "owner", role: "owner", username: "owner", active: true });
    s.adminSessions.push({ id: "owner", userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "csrf", expiresAt: "2031-01-01T00:00:00Z" });
  });
  const app = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret,
    SECRET_PEPPER: secret, NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent", ...(homeEnabled ? { NDAHI_HOME_ENABLED: "true" } : {}) } });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { app.closeAllConnections(); app.close(r); }));
  const base = "http://127.0.0.1:" + app.address().port;
  const call = async (path, input, admin) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { ...(input ? { "content-type": "application/json" } : {}), ...(admin ? { cookie: "admin_session=owner", "x-csrf-token": "csrf" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { store, call };
}
test("bought through checkout: refused while NDAHI Home is off; paid, it waits for the router, or starts on one already registered", async (t) => {
  const off = await server(t, false);
  const refused = await off.call("/api/purchase", { phone: "699112233", planId: "home-wisp-30d", network: "mtn", requestKey: randomUUID() });
  assert.deepEqual([refused.status, refused.body.code], [409, "HOME_WISP_UNAVAILABLE"]);
  const f = await server(t, true);
  const placed = await f.call("/api/purchase", { phone: "699112233", planId: "home-wisp-30d", network: "mtn", requestKey: randomUUID() });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.equal((await f.call(`/api/payments/${placed.body.payment.id}/confirm`, {})).status, 200);
  let s = await f.store.snapshot(), v = s.vouchers.find((x) => x.paymentId === placed.body.payment.id);
  assert.deepEqual([v.status, v.startsOnFirstConnection, v.validityHours, v.accessMode], ["available", true, 720, undefined], "waits for the router");
  assert.equal(s.routerCommands.some((c) => c.targetId === v.id), false);
  // A second customer with a router already registered: starts on it at payment.
  const second = await f.call("/api/purchase", { phone: "699445566", planId: "home-wisp-30d", network: "mtn", requestKey: randomUUID() });
  await f.store.transaction((st) => { registerRouter(st, st.payments.find((p) => p.id === second.body.payment.id).customerId, at, "AA:BB:CC:00:00:77"); });
  assert.equal((await f.call(`/api/payments/${second.body.payment.id}/confirm`, {})).status, 200);
  s = await f.store.snapshot(); v = s.vouchers.find((x) => x.paymentId === second.body.payment.id);
  assert.deepEqual([v.status, v.accessMode, v.expiresAt], ["active", "home", new Date(+at + 720 * HOUR).toISOString()]);
  assert.ok(s.homeOperations.some((o) => o.kind === "activate" && o.voucherId === v.id));
  assert.equal(s.routerCommands.some((c) => c.targetId === v.id), false);
  // Admins can't make Home WISP resale stock, which would start on the direct path.
  const resale = await f.call("/api/admin/vouchers/generate", { purpose: "resale", saleType: "sold", planId: "home-wisp-30d", quantity: 1 }, true);
  assert.deepEqual([resale.status, resale.body.code], [400, "HOME_WISP_NOT_RESALE"]);
});

test("a legacy bundle is unaffected: an earlier plan bought for a Home router, and an existing NDAHI Home bundle, are exactly as before", () => {
  const s = state();
  s.catalogue.mode = "legacy";
  const link = registerRouter(s, "c1");
  const options = { clock: () => at, provider: "mock", accountCustomerId: "c1", requester: { ip: "198.51.100.2" }, homeEnabled: true };
  const legacy = reservePurchase(s, { planId: "weekly", action: "switch", accessMode: "home", requestKey: "w".repeat(32) }, options);
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  assert.deepEqual([legacy.payment.accessMode, legacy.payment.homeConnectionId, legacy.payment.homeGeneration], ["home", link.id, link.generation], "Home mode as before");
  // An NDAHI Home bundle already running on the router: registering again and
  // the Home WISP start leave it byte for byte.
  s.vouchers.push({ id: "home-legacy", customerId: "c1", planId: "monthly", status: "active", quotaBytes: 15e9, usedBytes: 1e9, deviceLimit: 1, accessMode: "home",
    homeConnectionId: link.id, homeGeneration: link.generation, homeStatus: "connected", activatedAt: at.toISOString(), expiresAt: new Date(+at + 720 * HOUR).toISOString() });
  const before = JSON.stringify(s.vouchers);
  assert.equal(startHomeWisp(s, "c1", at), null);
  registerRouter(s, "c1");
  assert.equal(JSON.stringify(s.vouchers), before);
});
