import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createStore } from "../server.mjs";
import { deliverActivityPush, notificationItems } from "../lib/notifications.mjs";
import { createUsageAlertSender } from "../lib/usage-alerts.mjs";
import { deliverNotification, deliveryId } from "../lib/notification-delivery.mjs";

const config = { enabled: true, subject: "mailto:synthetic@example.test", publicKey: "fixture", privateKey: "fixture" };
const sub = (n = 1) => ({ endpoint: "https://fcm.googleapis.com/send/" + n, keys: { auth: "a".repeat(22), p256dh: "B".repeat(87) } });
async function fixture() {
  const store = createStore({ persistent: false }); let time = new Date("2030-01-01T00:00:00Z");
  await store.transaction((s) => {
    s.customers.push({ id: "c", activeVoucherId: "v", pushSubscriptions: [sub(1), sub(2)] });
    s.vouchers.push({ id: "v", customerId: "c", status: "active", quotaBytes: 1000000, usedBytes: 760000, expiresAt: "2030-02-01T00:00:00Z", usageAlerts: { 75: { status: "pending", at: time.toISOString() } } });
    s.notificationStates.push({ id: "preferences:customer:c", actor: "customer:c", pushEnabled: true, pushSince: new Date(+time - 1000).toISOString() });
    s.securityAlerts.push({ id: "sec", customerId: "c", subject: "Private account change", lines: ["Never send this detail"], at: time.toISOString() });
  });
  return { store, now: () => time, advance(ms) { time = new Date(+time + ms); } };
}

test("usage retries only the failed subscription, including after a worker restart", async () => {
  const f = await fixture(), calls = [];
  const send = async (s) => { calls.push(s.endpoint); if (s.endpoint.endsWith("/2") && calls.length === 2) throw Error("synthetic timeout"); };
  await createUsageAlertSender({ ...f, config, send })();
  assert.equal((await f.store.snapshot()).vouchers[0].usageAlerts[75].status, "pending");
  f.advance(60000);
  await createUsageAlertSender({ ...f, config, send })();
  assert.deepEqual(calls.map((n) => n.slice(-1)), ["1", "2", "2"]);
  assert.equal((await f.store.snapshot()).vouchers[0].usageAlerts[75].status, "sent");
});

test("independent workers share a usage delivery lease rather than sending duplicates", async () => {
  const f = await fixture(), calls = [];
  const send = async (s) => { calls.push(s.endpoint); await new Promise((r) => setTimeout(r, 15)); };
  await Promise.all([createUsageAlertSender({ ...f, config, send })(), createUsageAlertSender({ ...f, config, send })()]);
  assert.equal(calls.length, 2); assert.equal(new Set(calls).size, 2);
});

for (const [label, revoke] of [
  ["account suspension", (s) => { s.customers[0].status = "suspended"; }],
  ["usage consent", (s) => { s.notificationStates[0].usagePush = false; }],
  ["subscription removal", (s) => { s.customers[0].pushSubscriptions = []; }],
  ["replaced bundle", (s) => { s.customers[0].activeVoucherId = "replacement"; }],
  ["expired bundle", (s) => { s.vouchers[0].expiresAt = "2029-12-31T23:59:59Z"; }],
]) test(`usage claim rechecks ${label} after its snapshot`, async () => {
  const f = await fixture(), calls = [];
  const wrapped = { snapshot: async () => { const copy = await f.store.snapshot(); await f.store.transaction(revoke); return copy; }, transaction: (...args) => f.store.transaction(...args) };
  await createUsageAlertSender({ store: wrapped, config, now: f.now, send: async (...args) => calls.push(args) })();
  assert.equal(calls.length, 0);
});

test("higher thresholds cancel delayed lower warnings and old usage events expire", async () => {
  for (const old of [false, true]) {
    const f = await fixture(), calls = [];
    if (old) f.advance(21600001);
    else await f.store.transaction((s) => { s.vouchers[0].usageAlerts[100] = { status: "sent", at: f.now().toISOString() }; });
    await createUsageAlertSender({ ...f, config, send: async (...args) => calls.push(args) })();
    assert.equal(calls.length, 0); assert.equal((await f.store.snapshot()).vouchers[0].usageAlerts[75].status, "cancelled");
  }
});

test("read or archived usage items suppress pending push without changing bundle data", async () => {
  for (const field of ["readVersion", "archivedVersion"]) {
    const f = await fixture(), calls = [];
    await f.store.transaction((s) => {
      const item = notificationItems(s, { type: "customer", id: "c" }, f.now()).find((n) => n.id === "usage:v:75");
      s.notificationStates.push({ id: "view-state", actor: "customer:c", notificationId: item.id, [field]: item.version });
    });
    await createUsageAlertSender({ ...f, config, send: async (...args) => calls.push(args) })();
    assert.equal(calls.length, 0); assert.equal((await f.store.snapshot()).vouchers[0].usedBytes, 760000);
  }
});

test("an abandoned lease recovers after expiry, while a live lease and commit rollback send nothing", async () => {
  const f = await fixture(), calls = [], target = sub(1), recipient = "customer:c", eventId = "synthetic", version = "v1";
  const args = { ...f, config, recipient, eventId, version, subscription: target, resolve: () => ({ version, payload: { title: "NDAHI", body: "Check portal", url: "/dashboard#home" } }), send: async (...a) => calls.push(a) };
  const transaction = f.store.transaction.bind(f.store);
  const rollback = { transaction: (fn) => transaction(async (s) => { await fn(s); throw Error("synthetic rollback"); }) };
  await assert.rejects(deliverNotification({ ...args, store: rollback }), /rollback/); assert.equal(calls.length, 0);
  await transaction((s) => s.notificationStates.push({ id: deliveryId(recipient, eventId, target), actor: recipient, version, token: "crashed-worker", status: "sending", attempts: 1, leaseUntil: new Date(+f.now() + 30000).toISOString() }));
  await deliverNotification(args); assert.equal(calls.length, 0);
  f.advance(30001); await deliverNotification(args); assert.equal(calls.length, 1);
});

test("consent revoked after claim is fenced immediately before provider I/O", async () => {
  const f = await fixture(), calls = []; let changed = false;
  const store = { snapshot: () => f.store.snapshot(), transaction: async (fn) => {
    const out = await f.store.transaction(fn);
    if (!changed && (await f.store.snapshot()).notificationStates.some((r) => r.status === "sending")) {
      changed = true; await f.store.transaction((s) => { s.notificationStates[0].pushEnabled = false; });
    }
    return out;
  } };
  await deliverActivityPush({ store, config, now: f.now, send: async (...args) => calls.push(args) });
  assert.equal(calls.length, 0);
});

test("a rolled-back business event never appears in the inbox or delivery queue", async () => {
  const f = await fixture(), calls = [];
  await f.store.transaction((s) => { s.securityAlerts = []; });
  await assert.rejects(f.store.transaction((s) => {
    s.securityAlerts.push({ id: "rollback", customerId: "c", subject: "Changed", at: f.now().toISOString() });
    throw Error("business rollback");
  }), /business rollback/);
  await deliverActivityPush({ ...f, config, send: async (...args) => calls.push(args) });
  assert.equal(calls.length, 0);
  assert.equal(notificationItems(await f.store.snapshot(), { type: "customer", id: "c" }, f.now()).some((n) => n.id === "security:rollback"), false);
});

test("an expired crashed lease at the attempt limit cannot exceed the delivery budget", async () => {
  const f = await fixture(), calls = [], target = sub(), recipient = "customer:c", eventId = "crash-limit", version = "v";
  await f.store.transaction((s) => s.notificationStates.push({ id: deliveryId(recipient, eventId, target), actor: recipient,
    version, attempts: 5, status: "sending", token: "dead-worker", leaseUntil: new Date(+f.now() - 1).toISOString() }));
  await deliverNotification({ ...f, config, recipient, eventId, version, subscription: target, resolve: () => ({ version }), send: async (...args) => calls.push(args) });
  assert.equal(calls.length, 0);
  assert.equal((await f.store.snapshot()).notificationStates.find((n) => n.notificationId !== "" && n.id === deliveryId(recipient, eventId, target)).status, "failed");
});

test("deleted administrator authority cannot survive a delivery snapshot", async () => {
  const f = await fixture(), calls = [];
  await f.store.transaction((s) => {
    s.adminUsers.push({ id: "owner", role: "owner", active: true });
    s.notificationStates.push({ id: "preferences:admin:owner", actor: "admin:owner", pushEnabled: true, pushSince: new Date(+f.now() - 1000).toISOString(), subscriptions: [sub()] });
    s.routerCommands.push({ id: "failed", action: "sync_usage", status: "dead_letter", at: f.now().toISOString() });
    s.customers[0].pushSubscriptions = [];
  });
  const store = { snapshot: async () => { const s = await f.store.snapshot(); await f.store.transaction((s) => { s.adminUsers = []; }); return s; }, transaction: (...a) => f.store.transaction(...a) };
  await deliverActivityPush({ store, config, now: f.now, send: async (...a) => calls.push(a) });
  assert.equal(calls.length, 0);
});

test("legacy sent delivery records prevent historical activity replay after upgrade", async () => {
  const f = await fixture(), calls = [];
  await f.store.transaction((s) => {
    const item = notificationItems(s, { type: "customer", id: "c" }, f.now()).find((n) => n.id === "security:sec");
    for (const subscription of s.customers[0].pushSubscriptions) s.notificationStates.push({
      id: "delivery:" + createHash("sha256").update(JSON.stringify(["customer:c", item.id, subscription.endpoint])).digest("hex"), actor: "customer:c", version: item.version, status: "sent", attempts: 1,
    });
  });
  await deliverActivityPush({ ...f, config, send: async (...a) => calls.push(a) });
  assert.equal(calls.length, 0);
});

test("an expired old subscription does not remove a replacement using new keys at the same endpoint", async () => {
  const f = await fixture();
  await f.store.transaction((s) => { s.customers[0].pushSubscriptions = [sub()]; });
  await deliverActivityPush({ ...f, config, send: async () => {
    await f.store.transaction((s) => { s.customers[0].pushSubscriptions[0].keys.auth = "replacement"; });
    throw Object.assign(Error("gone"), { statusCode: 410 });
  } });
  assert.equal((await f.store.snapshot()).customers[0].pushSubscriptions[0].keys.auth, "replacement");
});

test("an accepted push with a lost reply retries with the same topic and tag, and stops at its attempt limit", async () => {
  const f = await fixture(), calls = [];
  await f.store.transaction((s) => { s.customers[0].pushSubscriptions = [sub()]; });
  const run = () => deliverActivityPush({ ...f, config, send: async (_s, text, options) => { calls.push({ payload: JSON.parse(text), topic: options.topic }); throw Error("accepted but reply lost"); } });
  for (let n = 0; n < 7; n++) { await run(); f.advance(3600000); }
  assert.equal(calls.length, 5); assert.equal(new Set(calls.map((c) => c.topic)).size, 1);
  assert.equal(new Set(calls.map((c) => c.payload.tag)).size, 1);
  assert.doesNotMatch(JSON.stringify(calls), /Private account change|Never send this detail|code|pin|voucher/i);
});

test("both service workers display safe push summaries and only navigate within their own app origin", async () => {
  for (const app of ["customer", "admin"]) {
    const handlers = {}, displayed = [], opened = [], navigated = [], origin = "https://app.example.test";
    const client = { url: origin + "/dashboard#home", navigate: async (url) => { navigated.push(url); return client; }, focus: async () => client };
    const self = { location: { origin }, registration: { showNotification: async (...args) => displayed.push(args) },
      addEventListener: (name, fn) => { handlers[name] = fn; }, clients: { matchAll: async () => [client], openWindow: async (url) => opened.push(url) } };
    vm.runInNewContext(await readFile(new URL(`../${app}-app/sw.js`, import.meta.url), "utf8"), { self, URL, Promise });
    let pending;
    handlers.push({ data: { json: () => ({ title: "NDAHI Connect", body: "New activity", url: "/dashboard#payments", tag: "activity-safe" }) }, waitUntil: (p) => { pending = p; } });
    await pending; assert.equal(displayed[0][1].body, "New activity");
    handlers.notificationclick({ notification: { close() {}, data: { url: "/dashboard#payments" } }, waitUntil: (p) => { pending = p; } });
    await pending; assert.deepEqual(app === "customer" ? navigated : opened, [origin + "/dashboard#payments"]);
    handlers.notificationclick({ notification: { close() {}, data: { url: "https://external.example.test/" } }, waitUntil() { throw Error("external navigation allowed"); } });
  }
});
