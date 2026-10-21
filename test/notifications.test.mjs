import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";
import { notificationInbox, deliverActivityPush } from "../lib/notifications.mjs";

async function fixture(t) {
  const f = await pairingFixture({ env: { ADMIN_APP_URL: "http://customer.test" } }); t.after(f.close);
  return f;
}
const endpoint = "/api/account/notifications";
test("notification reads and preferences are customer-scoped and persist across browser sessions", async (t) => {
  const f = await fixture(t), request = await f.request();
  const inbox = await f.call(endpoint);
  assert.equal(inbox.status, 200); assert.equal(inbox.body.actionCount, 1);
  const item = inbox.body.items.find((n) => n.requestId === request.body.request.id);
  assert.ok(item); assert.equal(item.read, false);
  assert.equal((await f.call(endpoint, { action: "read", id: item.id }, { csrf: "bad" })).status, 403);
  assert.equal((await f.call(endpoint, { action: "read", id: item.id }, { session: "other" })).status, 404);
  assert.equal((await f.call(endpoint, { action: "read", id: item.id })).status, 200);
  const another = await f.call(endpoint, undefined, { session: "secondary", controller: "" });
  assert.equal(another.body.items.find((n) => n.id === item.id).read, true);
  assert.equal(another.body.actionCount, 1);
  assert.equal((await f.call(endpoint, { action: "archive", id: item.id })).status, 409);
  assert.equal((await f.store.snapshot()).wifiPairingRequests[0].status, "pending");
  await f.call(endpoint, { action: "preferences", categories: { devices: false }, emailSecurity: false });
  const preferences = (await f.call(endpoint, undefined, { session: "secondary" })).body.preferences;
  assert.equal(preferences.emailSecurity, false); assert.equal(preferences.categories.devices, false);
  assert.equal((await f.call(endpoint)).body.actionCount, 1, "action items remain visible when a category is muted");
  assert.equal((await f.call(endpoint, { action: "preferences", pushEnabled: "yes" })).status, 400);
  assert.equal((await f.call(endpoint, { action: "preferences", categories: { unknown: true } })).status, 400);
});

test("code issuance and expiry update the same notification without disclosing codes or treating read as resolved", async (t) => {
  const f = await fixture(t), request = await f.request(), id = "device:" + request.body.request.id;
  await f.call(endpoint, { action: "read", id });
  const approved = await f.call("/api/account/device-management/pairing/approve", { id: request.body.request.id });
  const inbox = (await f.call(endpoint)).body;
  assert.equal(inbox.items.filter((n) => n.id === id).length, 1);
  assert.equal(inbox.items.find((n) => n.id === id).read, false);
  assert.equal(inbox.items.find((n) => n.id === id).actionRequired, true);
  assert.equal(JSON.stringify(inbox).includes(approved.body.approvalCode), false);
  f.advance(301);
  const expired = (await f.call(endpoint)).body.items.find((n) => n.id === id);
  assert.match(expired.title, /expired/);
  assert.equal((await f.call(endpoint, { action: "archive", id })).status, 200);
  assert.equal((await f.call(endpoint)).body.items.find((n) => n.id === id).archived, true);
  await f.call(endpoint, { action: "restore", id });
  assert.equal((await f.call(endpoint)).body.items.find((n) => n.id === id).archived, false);
});

test("administrators get role-filtered grouped alerts and their own read state", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    for (const [id, role] of [["owner1", "owner"], ["owner2", "owner"], ["viewer", "viewer"], ["reseller", "reseller"]]) {
      s.adminUsers.push({ id, username: id, role, active: true });
      s.adminSessions.push({ id, userId: id, role, tokenHash: hashSecret(id, "pairing-tests"), csrfToken: "csrf", expiresAt: "2030-01-02T00:00:00Z" });
    }
    s.routerCommands.push(...[1, 2].map((n) => ({ id: "failed" + n, action: "sync_usage", status: "dead_letter", at: f.now().toISOString(), lastError: "A private implementation detail" })));
  });
  async function call(user, input, csrf = "csrf") {
    const r = await fetch(f.api + "/api/admin/notifications", { method: input ? "POST" : "GET", headers: { origin: "http://customer.test", cookie: "admin_session=" + user, "x-csrf-token": csrf, "content-type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  }
  const owner = await call("owner1");
  assert.equal(owner.status, 200); assert.equal(owner.body.items.length, 1); assert.match(owner.body.items[0].body, /2 failed/);
  assert.equal(JSON.stringify(owner.body).includes("private implementation"), false);
  assert.equal((await call("viewer")).body.items.length, 0);
  assert.equal((await call("reseller", { action: "read", id: owner.body.items[0].id })).status, 404);
  assert.equal((await call("owner1", { action: "read-all" }, "bad")).status, 403);
  await call("owner1", { action: "read-all" });
  assert.equal((await call("owner1")).body.unreadCount, 0);
  assert.equal((await call("owner2")).body.unreadCount, 1);
  assert.equal((await call("viewer", { action: "preferences", categories: { network: false } })).status, 200);
});

test("activity push uses consent, generic content, delivery leases and deduplication", async (t) => {
  const f = await fixture(t);
  const subscription = { endpoint: "https://fcm.googleapis.com/fake-subscription", keys: { p256dh: "fixture", auth: "fixture" } };
  await f.store.transaction((s) => {
    s.notificationStates.push({ id: "preferences:customer:c1", actor: "customer:c1", pushEnabled: true, pushSince: new Date(+f.now() - 1000).toISOString() });
    s.customers[0].pushSubscriptions = [subscription];
  });
  await f.request();
  const sent = [], config = { enabled: true, subject: "mailto:test@example.test", publicKey: "fixture", privateKey: "fixture" };
  const send = async (sub, text) => { sent.push({ sub, text }); await new Promise((r) => setTimeout(r, 15)); };
  await Promise.all([deliverActivityPush({ store: f.store, config, now: f.now, send }), deliverActivityPush({ store: f.store, config, now: f.now, send })]);
  assert.equal(sent.length, 1); assert.match(sent[0].text, /New account activity/);
  assert.doesNotMatch(sent[0].text, /Galaxy|670050001|NC-AAAA|codeHash/);
  await deliverActivityPush({ store: f.store, config, now: f.now, send }); assert.equal(sent.length, 1);
  await f.call(endpoint, { action: "preferences", pushEnabled: false });
  await f.store.transaction((s) => { s.securityAlerts.push({ id: "security-new", customerId: "c1", subject: "Authenticator changed", lines: ["Check account"], at: f.now().toISOString() }); });
  await deliverActivityPush({ store: f.store, config, now: f.now, send }); assert.equal(sent.length, 1);
});

test("service notification versions remain stable while polling legacy records", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.zone = { id: "zone", status: "maintenance", notes: "Network maintenance" }; });
  const first = notificationInbox(await f.store.snapshot(), { type: "customer", id: "c1" }, f.now()).items[0];
  f.advance(60);
  const second = notificationInbox(await f.store.snapshot(), { type: "customer", id: "c1" }, f.now()).items[0];
  assert.equal(first.version, second.version);
});
