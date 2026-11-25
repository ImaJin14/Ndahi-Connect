// The 15-second notification worker must stay cheap as the network grows (#464).
// It built every account's notifications by searching whole collections, once per
// customer and again per item, so a run cost customers × records and blocked the
// API long enough for portal sign-in to time out.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createHandler, plans } from "../server.mjs";
import { customerNotificationViews, notificationItems, deliverActivityPush } from "../lib/notifications.mjs";
import { createNotificationEmailSender } from "../lib/notification-email.mjs";
import { loginMethods } from "../lib/sign-in-history.mjs";

const NOW = new Date("2030-01-01T12:00:00Z"), now = () => NOW;
const at = (minutes) => new Date(+NOW + minutes * 60000).toISOString();
const config = { enabled: true, publicKey: "fixture", privateKey: "fixture", subject: "mailto:fixture@example.test" };
const subscription = (n) => ({ endpoint: "https://fcm.googleapis.com/send/" + n, keys: { auth: "a".repeat(22), p256dh: "B".repeat(87) } });

// Deterministic pseudo-random numbers, so a failure can be replayed from its seed.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A small network whose records point across customers: a gift paid by its giver,
// alerts about another customer's sign-in, router commands found through a
// voucher, approval expiries found through a command, and preferences rows
// with and without an actor.
function network(seed, size = 14) {
  const r = random(seed), pick = (list) => list[Math.floor(r() * list.length)], chance = (p) => r() < p;
  const when = () => Math.round((r() - 0.6) * 4 * 1440), planIds = plans.map((p) => p.id);
  const s = { customers: [], vouchers: [], payments: [], securityEvents: [], securityAlerts: [], wifiPairingRequests: [], wifiDeviceGrants: [],
    customerMessages: [], routerCommands: [], notificationStates: [], outages: [], operationalIncidents: [], adminUsers: [], auditLogs: [], bundles: [],
    zone: chance(0.5) ? { id: "zone", status: "degraded", notes: "Maintenance", updatedAt: at(-30) } : { id: "zone", status: "online" } };
  const ids = Array.from({ length: size }, (_, i) => "c" + i);
  for (const id of ids) s.customers.push({ id, name: "Customer " + id, status: chance(0.08) ? "suspended" : "active", wifiFirstConnectedAt: at(-600),
    ...(chance(0.5) ? { wifiMainDevice: { controllerHash: "hash" } } : {}) });
  for (const id of ids) for (let i = 0, n = Math.floor(r() * 4); i < n; i++) {
    const p = { id: `p-${id}-${i}`, customerId: id, planId: pick(planIds), status: pick(["paid", "paid", "failed", "pending", "refund-pending"]),
      createdAt: at(when()), updatedAt: at(when()), fulfillmentStatus: chance(0.2) ? "needs_review" : "fulfilled" };
    if (chance(0.7)) p.confirmedAt = at(when());
    if (chance(0.2)) p.refund = { status: pick(["requested", "pending", "failed", "completed"]), updatedAt: at(when()) };
    if (chance(0.3)) p.planSnapshot = { name: "Recorded " + p.planId };
    s.payments.push(p);
  }
  for (const id of ids) for (let i = 0, n = Math.floor(r() * 5); i < n; i++) {
    const payment = chance(0.7) ? pick(s.payments) : undefined, ends = pick([-600, -30, 30, 300, 2000]), lasts = pick([60, 1440, 10080]);
    const v = { id: `v-${id}-${i}`, customerId: id, code: `NC-${id}-${i}`, planId: payment?.planId || pick(planIds), paymentId: payment?.id, quotaBytes: null,
      status: pick(["available", "active", "active", "expired", "exhausted", "refunded"]), activatedAt: at(ends - lasts), expiresAt: at(ends), createdAt: at(ends - lasts - 10) };
    if (v.status === "available" && chance(0.6)) Object.assign(v, chance(0.5) ? { saleType: "gift" } : { giftedBy: pick(ids), giftedAt: at(when()), ...(chance(0.5) ? { giftNote: "Enjoy" } : {}) });
    if (chance(0.15)) v.customTerms = { id: v.planId, name: "Custom", priceXaf: 1000 };
    if (chance(0.4)) Object.assign(v, { quotaBytes: 1e9, usedBytes: 9.5e8, usageAlertCycle: "k1",
      usageAlerts: { [pick(["90", "low", "100"])]: { at: at(when()), status: pick(["pending", "sent", "skipped"]), remainingBytes: 5e7 } } });
    if (chance(0.3)) v.usageAlertHistory = [{ level: pick(["90", "low", "100"]), at: at(when()), status: pick(["sent", "skipped"]), cycle: "k0", remainingBytes: 1e6 }];
    if (chance(0.2)) v.exhaustedAt = at(when());
    if (chance(0.3)) v.outageCredits = [{ outageId: "o2", hours: pick([1, 2]) }];
    s.vouchers.push(v);
  }
  s.outages.push({ id: "o1", notify: true, showToCustomers: true, status: "live", area: "Bonamoussadi", message: { en: "Fibre cut." },
    updates: [{ text: "Crew on site", at: at(-20) }], startedAt: at(-120), createdAt: at(-120) },
  { id: "o2", notify: true, showToCustomers: true, status: "fixed", area: "Akwa", message: { en: "Power cut." }, updates: [],
    startedAt: at(-3000), fixedAt: at(-1000), createdAt: at(-3000) });
  s.operationalIncidents.push({ id: "i1", status: "open", action: "sync_voucher", customerIds: ids.filter(() => chance(0.3)), firstAt: at(-60), lastAt: at(-30), updatedAt: at(-30) },
    { id: "i2", status: "resolved", resolution: "obsolete", action: "sync_usage", customerIds: [], global: true, firstAt: at(-100), lastAt: at(-10) });
  for (const id of ids) for (let i = 0, n = Math.floor(r() * 3); i < n; i++) s.wifiPairingRequests.push({ id: `wr-${id}-${i}`, customerId: id,
    mac: "AA:BB:CC:DD:EE:" + (10 + i), status: pick(["pending", "awaiting_code", "awaiting_confirmation", "approved", "denied"]),
    expiresAt: at(chance(0.5) ? 10 : -10), at: at(when()), kind: pick(["bootstrap", "reconnect", "secondary"]), protocol: pick([2, 3]),
    ...(chance(0.5) ? { name: "Phone" } : {}), ...(chance(0.5) ? { updatedAt: at(when()) } : {}) });
  for (let i = 0; i < size * 3; i++) {
    const v = pick(s.vouchers), own = s.wifiPairingRequests.filter((p) => p.customerId === v?.customerId);
    s.routerCommands.push({ id: "rc" + i, action: pick(["disconnect_wifi_device", "connect_wifi_device", "sync_voucher"]),
      status: pick(["queued", "processing", "retry", "processed", "processed", "dead_letter"]), result: pick(["connected", "disconnected", "absent", "superseded"]),
      device: { voucherId: v?.id, mac: "AA:BB:CC:DD:EE:" + (10 + (i % 80)) }, targetId: (chance(0.7) && own.length ? pick(own) : pick(s.wifiPairingRequests))?.id,
      at: at(when()), deadLetteredAt: at(when()), ...(chance(0.5) ? { processedAt: at(when()) } : {}), ...(chance(0.2) ? { customerId: pick(ids) } : {}) });
  }
  for (const id of ids) if (chance(0.5)) s.wifiDeviceGrants.push({ id: "g-" + id, customerId: id, mac: "AA:BB:CC:00:00:01", expiries: [
    { generation: 1, commandId: pick(s.routerCommands).id, mac: "AA:BB:CC:00:00:01", at: at(-50), ...(chance(0.4) ? { routerConfirmedAt: at(-40) } : {}) },
    { generation: 2, commandId: "missing-" + id, name: "Tablet", at: at(-20) }] });
  const types = [...Object.values(loginMethods), "customer.pin_login.failed", "rate_limit.hit"];
  for (const id of ids) for (let i = 0, n = Math.floor(r() * 4); i < n; i++) s.securityEvents.push({ id: `se-${id}-${i}`, type: pick(types), at: at(when()),
    meta: { customerId: chance(0.9) ? id : undefined, recognized: !chance(0.3), ...(chance(0.5) ? { userAgent: "Safari" } : {}) }, ...(chance(0.6) ? { ip: "10.0.0." + i } : {}) });
  s.securityEvents.push({ id: "se-anonymous", type: "rate_limit.hit", at: at(-5) });
  for (const id of ids) for (let i = 0, n = Math.floor(r() * 3); i < n; i++) {
    const source = chance(0.7) ? pick(s.securityEvents) : { id: `gone-${id}-${i}`, type: loginMethods.pin, at: at(-5), meta: { customerId: id } };
    s.securityAlerts.push({ id: `sa-${id}-${i}`, customerId: id, subject: "New sign-in", lines: ["A sign-in was recorded."], at: at(when()),
      ...(chance(0.8) ? { sourceSignInId: source.id } : {}), ...(chance(0.5) ? { signIn: { ...source, meta: { ...source.meta, customerId: id } } } : {}) });
  }
  for (const id of ids) if (chance(0.4)) s.customerMessages.push({ id: "m-" + id, customerId: id, body: "Hello from NDAHI", at: at(when()) });
  for (const id of ids) if (chance(0.6)) s.notificationStates.push({ id: "preferences:customer:" + id, ...(chance(0.8) ? { actor: "customer:" + id } : {}),
    categories: chance(0.3) ? { payments: false } : {}, expiryWarnings: chance(0.6), subscriptionUpdates: chance(0.8), ...(chance(0.3) ? { usageThresholds: ["100"] } : {}) });
  // Read and archived marks for some of each customer's current items, and rows for other recipients.
  for (const id of ids) for (const item of notificationItems(s, { type: "customer", id }, NOW)) if (chance(0.3)) s.notificationStates.push({
    id: `state-${id}-${item.id}`, actor: "customer:" + id, notificationId: item.id, readVersion: item.version, ...(chance(0.5) ? { archivedVersion: item.version } : {}) });
  s.notificationStates.push({ id: "preferences:admin:owner", actor: "admin:owner", pushEnabled: true }, { id: "state-admin", actor: "admin:owner", notificationId: "message:m-c1", readVersion: "x" });
  return s;
}

test("each customer's indexed view gives exactly the notifications the whole snapshot gives", () => {
  const kinds = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const s = network(seed), view = customerNotificationViews(s);
    for (const c of s.customers) {
      const actor = { type: "customer", id: c.id }, whole = notificationItems(s, actor, NOW);
      assert.deepEqual(notificationItems(view(c.id), actor, NOW), whole, `seed ${seed}, customer ${c.id}`);
      for (const item of whole) kinds.add(item.id.split(":")[0]);
    }
    // An unknown customer gets an empty view, as from the whole snapshot.
    assert.deepEqual(notificationItems(view("nobody"), { type: "customer", id: "nobody" }, NOW), []);
  }
  // The fixture reaches every kind of customer notification, so the comparison covers each one.
  for (const kind of ["approval-expiry", "outage", "outage-fixed", "service-incident", "main-setup", "device", "wifi-disconnect", "security", "sign-in",
    "payment", "wifi-connected", "message", "gift", "voucher-ready", "gift-from", "usage", "bundle-expiring", "bundle-ending", "bundle", "service"]) {
    assert.ok(kinds.has(kind), `no ${kind} notification in the fixture`);
  }
});

test("a delivered notification costs no store transaction on later runs", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c", phone: "670000001", email: "c@example.test", emailVerifiedAt: at(-60), pushSubscriptions: [subscription("c")] },
      { id: "quiet", phone: "670000002" });
    s.notificationStates.push({ id: "preferences:customer:c", actor: "customer:c", pushEnabled: true, pushSince: at(-600) });
    s.customerMessages.push({ id: "m1", customerId: "c", body: "Maintenance tonight at 22:00.", at: at(-5) });
  });
  const pushed = [], emailed = [];
  const email = { configured: () => true, sendAccountMessage: async (message) => { emailed.push(message); return { messageId: "id-" + emailed.length }; } };
  const fallback = createNotificationEmailSender({ store, email, config, now });
  const run = () => Promise.all([deliverActivityPush({ store, config, now, send: async (...args) => { pushed.push(args); } }), fallback()]);
  await run();
  assert.equal(pushed.length, 1);
  assert.equal(emailed.length, 1);
  const transaction = store.transaction.bind(store);
  let opened = 0;
  store.transaction = (...args) => { opened++; return transaction(...args); };
  await run();
  await run();
  assert.equal(opened, 0, "already-sent push and email reopened a store transaction");
  assert.equal(pushed.length, 1);
  assert.equal(emailed.length, 1);
  // A new message is still delivered on the next run.
  await transaction((s) => { s.customerMessages.push({ id: "m2", customerId: "c", body: "Back online.", at: at(-1) }); });
  await run();
  assert.equal(pushed.length, 2);
  assert.equal(emailed.length, 2);
});

test("the notification worker runs once at a time", async () => {
  const handler = createHandler({ store: createStore({ persistent: false }), now, validateConfig: false, env: { NODE_ENV: "test" } });
  const first = handler.sendUsageAlerts(), joined = handler.sendUsageAlerts();
  assert.equal(joined, first);
  await first;
  const next = handler.sendUsageAlerts();
  assert.notEqual(next, first);
  await next;
});

test("a run stays fast on a large network", async () => {
  const store = createStore({ persistent: false }), customers = 1500;
  await store.transaction((s) => {
    for (let i = 0; i < customers; i++) {
      const id = "c" + i;
      s.customers.push({ id, phone: "67" + String(i).padStart(7, "0"), pushSubscriptions: i % 20 ? [] : [subscription(i)],
        ...(i % 5 ? {} : { email: `c${i}@example.test`, emailVerifiedAt: at(-1440) }) });
      if (i % 20 === 0) s.notificationStates.push({ id: "preferences:customer:" + id, actor: "customer:" + id, pushEnabled: true, pushSince: at(-43200) });
      for (let n = 0; n < 6; n++) {
        s.payments.push({ id: `p${i}-${n}`, customerId: id, status: "paid", planId: "weekly", confirmedAt: at(-10080 * (6 - n)), createdAt: at(-10080 * (6 - n)) });
        s.vouchers.push({ id: `v${i}-${n}`, customerId: id, code: `NC-${i}-${n}`, status: n === 5 ? "active" : "expired", planId: "weekly", quotaBytes: null,
          paymentId: `p${i}-${n}`, activatedAt: at(-10080 * (6 - n)), expiresAt: at(-10080 * (5 - n) - 1) });
      }
      for (let n = 0; n < 40; n++) s.securityEvents.push({ id: `se${i}-${n}`, type: n % 2 ? loginMethods.pin : "rate_limit.hit", at: at(-60 * n), meta: { customerId: id, recognized: true } });
    }
    for (let n = 0; n < customers * 2; n++) s.routerCommands.push({ id: "rc" + n, action: "sync_voucher", status: "processed", at: at(-n) });
  });
  const email = { configured: () => false };
  const started = performance.now();
  await deliverActivityPush({ store, config, now, send: async () => {} });
  await createNotificationEmailSender({ store, email, config, now })();
  const seconds = (performance.now() - started) / 1000;
  // Before #464 this took about 30 seconds on a developer PC; it now takes well under one.
  assert.ok(seconds < 5, `one run took ${seconds.toFixed(1)} s for ${customers} customers`);
});
