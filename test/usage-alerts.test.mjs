import test from "node:test";
import assert from "node:assert/strict";
import { createStore, blank } from "../server.mjs";
import { createAccountRoutes } from "../lib/api/account.mjs";
import { recordSources } from "../lib/admin-records.mjs";
import { createRouterCommandProcessor, enqueueRouterCommand } from "../lib/router-queue.mjs";
import { createUsageAlertSender, pushSubscription, recordUsageAlerts, usageAlertConfig } from "../lib/usage-alerts.mjs";

const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
const config = { enabled: true, publicKey: "public-key", privateKey: "private-key", subject: "mailto:ops@example.test" };
const env = { WEB_PUSH_PUBLIC_KEY: "public-key", WEB_PUSH_PRIVATE_KEY: "private-key", WEB_PUSH_SUBJECT: "mailto:ops@example.test" };
const voucher = (overrides = {}) => ({ id: "v1", customerId: "c1", status: "active", quotaBytes: 1000, usedBytes: 0, ...overrides });

test("only browser push services are accepted as alert destinations", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/token", "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://web.push.apple.com/token", "https://wns2-par02p.notify.windows.com/w/?token=x",
  ]) assert.equal(pushSubscription({ endpoint, keys })?.endpoint, endpoint);
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/token", "https://fcm.googleapis.com:8443/x", "https://user:pass@fcm.googleapis.com/x",
    "https://fcm.googleapis.com.evil.test/x", "https://169.254.169.254/latest", "https://api.ndahi.test/push", "not a url",
  ]) assert.equal(pushSubscription({ endpoint, keys }), null, endpoint);
  const endpoint = "https://fcm.googleapis.com/fcm/send/token";
  assert.equal(pushSubscription({ endpoint, keys: { ...keys, p256dh: "short" } }), null);
  assert.equal(pushSubscription({ endpoint, keys: { ...keys, auth: "<script>alert(1)</script>" } }), null);
  assert.equal(usageAlertConfig({}).enabled, false);
  assert.equal(usageAlertConfig({ ...env, WEB_PUSH_SUBJECT: "ops@example.test" }).enabled, false);
  assert.equal(usageAlertConfig(env).enabled, true);
});

test("each threshold is alerted once and a jump sends only the highest", () => {
  const now = () => new Date("2030-01-01T00:00:00Z"), status = (v) => Object.fromEntries(Object.entries(v.usageAlerts || {}).map(([t, a]) => [t, a.status]));
  const v = voucher({ quotaBytes: 1e9, usedBytes: 899e6 });
  assert.equal(recordUsageAlerts(v, now), false);
  v.usedBytes = 900e6;
  assert.equal(recordUsageAlerts(v, now), true);
  assert.deepEqual(status(v), { 90: "pending" });
  assert.equal(recordUsageAlerts(v, now), false);
  v.usedBytes = 1.2e9;
  recordUsageAlerts(v, now);
  assert.deepEqual(status(v), { 90: "superseded", 100: "pending" });
  const unlimited = voucher({ quotaBytes: null, usedBytes: 5e9 }), unclaimed = voucher({ customerId: null, usedBytes: 900 });
  assert.equal(recordUsageAlerts(unlimited, now) || recordUsageAlerts(unclaimed, now), false);
});

test("usage sync records an alert when a bundle crosses a threshold", async () => {
  const store = createStore({ persistent: false }), now = () => new Date("2030-01-01T00:00:00Z");
  await store.transaction((s) => { s.vouchers.push(voucher({ id: "v1", code: "NC-ABCD-2345", quotaBytes: 1e9, deviceLimit: 1, expiresAt: "2030-02-01T00:00:00Z" })); });
  await store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, now));
  await createRouterCommandProcessor({ store, now, router: { readUsage: async () => [{ voucherId: "v1", usedBytes: 910e6, devices: [] }] } }).process();
  const { usageAlerts } = (await store.snapshot()).vouchers[0];
  assert.deepEqual(Object.fromEntries(Object.entries(usageAlerts).map(([t, a]) => [t, a.status])), { 90: "pending" });
});

async function senderFixture({ subscriptions = 2, send } = {}) {
  let time = new Date("2030-01-01T00:00:00Z");
  const store = createStore({ persistent: false }), calls = [];
  await store.transaction((s) => {
    s.customers.push({ id: "c1", pushSubscriptions: Array.from({ length: subscriptions }, (_, i) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys })) });
    s.vouchers.push(voucher({ quotaBytes: 1e9, usedBytes: 900e6, usageAlerts: { 90: { status: "pending", attempts: 0 } } }));
  });
  const run = createUsageAlertSender({ store, config, now: () => time, send: async (subscription, payload, options) => {
    calls.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
    return send?.(subscription, calls.length);
  } });
  return { store, calls, run, advance(ms) { time = new Date(+time + ms); }, alert: async () => (await store.snapshot()).vouchers[0].usageAlerts[90] };
}

test("a due alert is pushed to every opted-in device once", async () => {
  const f = await senderFixture();
  assert.deepEqual(await f.run(), { due: 1, sent: 1 });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].payload.title, "90% of your data used");
  assert.match(f.calls[0].payload.body, /MB left/);
  assert.equal(f.calls[0].payload.url, "/dashboard#bundles");
  assert.equal(f.calls[0].options.vapidDetails.subject, config.subject);
  assert.equal((await f.alert()).status, "sent");
  await f.run();
  assert.equal(f.calls.length, 2);
});

test("expired subscriptions are removed and failed pushes retry with backoff, then stop", async () => {
  const gone = await senderFixture({ send: (subscription) => { if (subscription.endpoint.endsWith("/0")) throw Object.assign(Error("gone"), { statusCode: 410 }); } });
  await gone.run();
  assert.equal((await gone.alert()).status, "sent");
  assert.deepEqual((await gone.store.snapshot()).customers[0].pushSubscriptions.map((x) => x.endpoint), ["https://fcm.googleapis.com/fcm/send/1"]);

  const failing = await senderFixture({ subscriptions: 1, send: () => { throw Object.assign(Error("unavailable"), { statusCode: 503 }); } });
  await failing.run();
  let alert = await failing.alert();
  assert.equal(alert.status, "pending");
  assert.equal(alert.attempts, 1);
  await failing.run();
  assert.equal(failing.calls.length, 1, "not retried before its backoff");
  failing.advance(60000); await failing.run();
  failing.advance(120000); await failing.run();
  alert = await failing.alert();
  assert.equal(alert.status, "failed");
  assert.equal(alert.nextAttemptAt, undefined);

  const none = await senderFixture({ subscriptions: 0 });
  await none.run();
  assert.equal((await none.alert()).status, "no_subscription");
});

function accountFixture(routeEnv = env) {
  const state = blank();
  state.customers.push({ id: "c1", phone: "670000001", pinHash: "secret" });
  const route = createAccountRoutes({ env: routeEnv, mutate: (fn) => fn(state), auth: () => ({ customerId: "c1" }), sessionScope: () => ({}), refreshCustomerSession: () => {}, clock: () => new Date("2030-01-01T00:00:00Z") });
  return {
    state,
    async call(path, input) {
      const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } },
        req = input === undefined ? { method: "GET" } : { method: "POST", async *[Symbol.asyncIterator]() { yield JSON.stringify(input); } };
      await route(req, res, new URL(`http://api.test${path}`));
      return res;
    },
  };
}

test("customers opt devices in and out without exposing stored subscriptions", async () => {
  const off = accountFixture({});
  assert.deepEqual((await off.call("/api/account/push")).body, { available: false, publicKey: null, subscriptions: 0 });
  assert.equal((await off.call("/api/account/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys })).status, 503);

  const f = accountFixture();
  assert.equal((await f.call("/api/account/push")).body.publicKey, "public-key");
  assert.equal((await f.call("/api/account/push/subscribe", { endpoint: "https://evil.test/x", keys })).status, 400);
  for (let i = 0; i < 7; i++) await f.call("/api/account/push/subscribe", { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys });
  await f.call("/api/account/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/6", keys });
  const stored = f.state.customers[0].pushSubscriptions.map((x) => x.endpoint.split("/").at(-1));
  assert.deepEqual(stored, ["6", "5", "4", "3", "2"]);
  assert.equal((await f.call("/api/account/push/unsubscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/5" })).body.subscriptions, 4);

  const dashboard = await f.call("/api/account/dashboard");
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.customer.pushSubscriptions, undefined);
  assert.equal(recordSources.customers.present(f.state.customers[0]).pushSubscriptions, undefined);
});

test("the sender's options produce a signed, encrypted Web Push request", async () => {
  const { default: webPush } = await import("web-push"), { createECDH, randomBytes } = await import("node:crypto");
  const vapid = webPush.generateVAPIDKeys(), browser = createECDH("prime256v1");
  browser.generateKeys();
  const subscription = pushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/device", keys: {
    p256dh: browser.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"),
  } });
  let request;
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c1", pushSubscriptions: [subscription] });
    s.vouchers.push(voucher({ usedBytes: 1000, usageAlerts: { 100: { status: "pending", attempts: 0 } } }));
  });
  await createUsageAlertSender({ store, config: usageAlertConfig({ WEB_PUSH_PUBLIC_KEY: vapid.publicKey, WEB_PUSH_PRIVATE_KEY: vapid.privateKey, WEB_PUSH_SUBJECT: "mailto:ops@example.test" }),
    send: async (target, payload, options) => { request = webPush.generateRequestDetails(target, payload, options); } })();
  assert.equal(request.endpoint, "https://fcm.googleapis.com/fcm/send/device");
  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.match(request.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.equal(request.headers.TTL, 86400);
  assert.ok(request.body.length > 100);
});
