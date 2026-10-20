import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pairingFixture, publicRoot, ownerRoot, guestMac } from "./helpers/wifi-pairing-fixture.mjs";
import { createHandler } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { observedWifiDevices } from "../lib/wifi-devices.mjs";
import { deliverActivityPush } from "../lib/notifications.mjs";

const ownerConnect = "/api/account/device-management/connect", inbox = "/api/account/notifications";
const target = { key: "d".repeat(32), mac: guestMac, address: "10.20.0.30" };
const subscription = { endpoint: "https://fcm.googleapis.com/independent-fixture", keys: { p256dh: "fixture", auth: "fixture" } };
const config = { enabled: true, subject: "mailto:test@example.test", publicKey: "fixture", privateKey: "fixture" };
async function fixture(t, options) { const f = await pairingFixture(options); t.after(f.close); return f; }

for (const [label, change] of [
  ["all slots are occupied", (s) => { s.vouchers[0].deviceLimit = 2; }],
  ["the router reading is stale", (s, f) => { s.vouchers[0].wifiDevicesAt = new Date(+f.now() - 121000).toISOString(); }],
]) test(`failed owner recovery preserves the main controller when ${label}`, async (t) => {
  const f = await fixture(t), before = (await f.store.snapshot()).customers[0].wifiMainDevice.controllerHash;
  await f.store.transaction((s) => change(s, f));
  const result = await f.call(ownerConnect, { ...target, recover: true, pin: "2468" });
  assert.equal(result.status, 409);
  assert.equal((await f.store.snapshot()).customers[0].wifiMainDevice.controllerHash, before,
    "a failed connection attempt must not revoke the working main controller");
  assert.equal((await f.call(ownerRoot)).body.isMainController, true);
});

test("confirming one connection does not make stale observations of other devices fresh", async (t) => {
  const f = await fixture(t), request = await f.request();
  const issued = await f.call(ownerRoot + "/approve", { id: request.body.request.id });
  assert.equal((await f.call(publicRoot + "/redeem", { id: request.body.request.id, key: request.requestKey,
    approvalCode: issued.body.approvalCode }, { session: "", controller: "" })).status, 202);
  f.advance(130);
  await f.process();
  const state = await f.store.snapshot();
  assert.equal(state.wifiPairingRequests[0].status, "connected");
  assert.equal(observedWifiDevices(state, f.now()).find((d) => d.mac === "AA:BB:CC:DD:EE:01").fresh, false,
    "only a complete router reading can refresh the other sessions");
});

test("a current approval code remains usable while the previous server secret is accepted", async (t) => {
  const f = await fixture(t), request = await f.request();
  const issued = await f.call(ownerRoot + "/approve", { id: request.body.request.id });
  const handler = createHandler({ store: f.store, now: f.now, validateConfig: false, router: {}, env: {
    NODE_ENV: "production", CUSTOMER_SESSION_SECRET: "pairing-tests", SECRET_PEPPER: "rotated-pairing-fixture",
    SECRET_PEPPER_PREVIOUS: "pairing-tests", SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: "http://customer.test",
    NETWORK_QUEUE_ENABLED: "true", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "warn",
    TRUST_PROXY: "render", COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: "203.0.113.10",
  } });
  handler.routerProcessor.wake = () => {};
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const headers = { origin: "http://customer.test", cookie: "customer_session=main; ndahi_main_device=controller",
    "x-csrf-token": "csrf", "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" };
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(url + ownerRoot, { headers });
  assert.equal(response.status, 200);
  const shown = (await response.json()).requests.find((r) => r.id === request.body.request.id).approvalCode;
  assert.equal(shown, issued.body.approvalCode, "rotation must not silently display a replacement that the stored verifier rejects");
  const redeemed = await fetch(url + publicRoot + "/redeem", { method: "POST", headers, body: JSON.stringify({
    id: request.body.request.id, key: request.requestKey, approvalCode: shown,
  }) });
  assert.equal(redeemed.status, 202);
});

test("archiving an unread notification suppresses its pending activity push", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.notificationStates.push({ id: "preferences:customer:c1", actor: "customer:c1", pushEnabled: true,
      pushSince: new Date(+f.now() - 1000).toISOString() });
    s.customers[0].pushSubscriptions = [subscription];
    s.securityAlerts.push({ id: "review-alert", customerId: "c1", subject: "Account changed", lines: ["Review your account."], at: f.now().toISOString() });
  });
  assert.equal((await f.call(inbox, { action: "archive", id: "security:review-alert" })).status, 200);
  const sent = [];
  await deliverActivityPush({ store: f.store, config, now: f.now, send: async (...args) => { sent.push(args); } });
  assert.equal(sent.length, 0, "a dismissed inbox item should not trigger a new push");
});

for (const [label, revoke] of [["disabled", (admin) => { admin.active = false; }], ["demoted", (admin) => { admin.role = "viewer"; }]])
  test(`activity delivery rechecks ${label} administrator authority after its initial snapshot`, async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.adminUsers.push({ id: "review-admin", username: "review-admin", role: "owner", active: true });
    s.notificationStates.push({ id: "preferences:admin:review-admin", actor: "admin:review-admin", pushEnabled: true,
      pushSince: new Date(+f.now() - 1000).toISOString(), subscriptions: [subscription] });
    s.routerCommands.push({ id: "review-failed", action: "sync_usage", status: "dead_letter", at: f.now().toISOString() });
  });
  const store = { snapshot: async () => {
    const result = await f.store.snapshot();
    await f.store.transaction((s) => { revoke(s.adminUsers[0]); });
    return result;
  }, transaction: (fn) => f.store.transaction(fn) };
  const sent = [];
  await deliverActivityPush({ store, config, now: f.now, send: async (...args) => { sent.push(args); } });
  assert.equal(sent.length, 0, "revoked staff authority must be checked before claiming delivery");
});

test("activity delivery rechecks that a subscription was not removed after its initial snapshot", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.notificationStates.push({ id: "preferences:customer:c1", actor: "customer:c1", pushEnabled: true,
      pushSince: new Date(+f.now() - 1000).toISOString() });
    s.customers[0].pushSubscriptions = [subscription];
    s.securityAlerts.push({ id: "unsubscribe-race", customerId: "c1", subject: "Account changed", lines: ["Review your account."], at: f.now().toISOString() });
  });
  const store = { snapshot: async () => {
    const result = await f.store.snapshot();
    await f.store.transaction((s) => { s.customers[0].pushSubscriptions = []; });
    return result;
  }, transaction: (fn) => f.store.transaction(fn) };
  const sent = [];
  await deliverActivityPush({ store, config, now: f.now, send: async (...args) => { sent.push(args); } });
  assert.equal(sent.length, 0, "an unsubscribed device must not receive a newly claimed activity delivery");
});

for (const admin of [false, true]) test(`${admin ? "admin" : "customer"} notification mutations wait for a successful store commit`, async (t) => {
  const f = await fixture(t);
  if (admin) await f.store.transaction((s) => {
    s.adminUsers.push({ id: "commit-admin", username: "commit-admin", role: "owner", active: true });
    s.adminSessions.push({ id: "commit-admin", userId: "commit-admin", role: "owner", tokenHash: hashSecret("commit-admin", "pairing-tests"),
      csrfToken: "csrf", expiresAt: new Date(+f.now() + 3600000).toISOString() });
  });
  const recipient = admin ? "admin:commit-admin" : "customer:c1";
  const store = { snapshot: () => f.store.snapshot(), transaction: (fn, options) => f.store.transaction(async (s) => {
    const result = await fn(s);
    if (s.notificationStates.some((row) => row.id === "preferences:" + recipient)) throw Error("Synthetic commit failure");
    return result;
  }, options) };
  const handler = createHandler({ store, now: f.now, validateConfig: false, router: {}, env: {
    NODE_ENV: "production", CUSTOMER_SESSION_SECRET: "pairing-tests", ADMIN_SESSION_SECRET: "pairing-tests", SECRET_PEPPER: "pairing-tests",
    CUSTOMER_APP_URL: "http://customer.test", ADMIN_APP_URL: "http://customer.test", LOG_LEVEL: "silent", SESSION_COOKIE_SECURE: "false",
    NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
  } });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${admin ? "admin" : "account"}/notifications`, {
    method: "POST", headers: { origin: "http://customer.test", "x-csrf-token": "csrf", "content-type": "application/json",
      cookie: admin ? "admin_session=commit-admin" : "customer_session=main" }, body: JSON.stringify({ action: "preferences", emailSecurity: false }),
  });
  await response.text();
  assert.ok(response.status >= 400, "a rolled-back notification preference change must not return success");
  assert.equal((await f.store.snapshot()).notificationStates.some((row) => row.id === "preferences:" + recipient), false);
});
