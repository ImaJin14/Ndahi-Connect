import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";
import { hashSecret } from "../lib/security.mjs";
import { appendRow, balanceOf, expirePoints, nextExpiry, pointLots, takeBackForPayment, earnForPayment, rewardSettings } from "../lib/rewards.mjs";

// Rewards points (#526): earned on bundle payments, redeemed for bundles.
const start = new Date("2026-12-01T09:00:00Z"), secret = "rewards-tests", HOUR = 36e5, DAY = 864e5;

async function server(t, { unlimited = true } = {}) {
  const store = createStore({ persistent: false });
  let now = start;
  await store.transaction((s) => {
    seedCatalogue(s, now); if (unlimited) s.catalogue.mode = "unlimited";
    for (const role of ["owner", "operator"]) {
      s.adminUsers.push({ id: role, role, username: role, active: true });
      s.adminSessions.push({ id: role, userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: "csrf-" + role, expiresAt: "2031-01-01T00:00:00Z" });
    }
  });
  const app = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret,
    SECRET_PEPPER: secret, NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { app.closeAllConnections(); app.close(r); }));
  const base = "http://127.0.0.1:" + app.address().port;
  const call = async (path, input, { role, customer } = {}) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { ...(input ? { "content-type": "application/json" } : {}),
      ...(role ? { cookie: "admin_session=" + role, "x-csrf-token": "csrf-" + role } : customer ? { cookie: "customer_session=" + customer, "x-csrf-token": "csrf-" + customer } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  // A bundle bought and paid through checkout; the buyer gets a session.
  const buy = async (phone, planId) => {
    // A returning customer buys signed in, as the portal does.
    const returning = (await store.snapshot()).dashboardSessions.some((x) => x.id === phone);
    const placed = await call(returning ? "/api/account/plan/purchase" : "/api/purchase", { phone, planId, network: "mtn", requestKey: randomUUID(), ...(returning ? { action: "switch" } : {}) }, returning ? { customer: phone } : {});
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const paid = await call(`/api/payments/${placed.body.payment.id}/confirm`, {});
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    await store.transaction((s) => {
      const c = s.customers.find((x) => x.phone.endsWith(phone.slice(-9)));
      if (!s.dashboardSessions.some((x) => x.id === phone)) s.dashboardSessions.push({ id: phone, customerId: c.id, tokenHash: hashSecret(phone, secret), csrfToken: "csrf-" + phone, expiresAt: "2031-01-01T00:00:00Z" });
    });
    return placed.body.payment.id;
  };
  const snapshot = () => store.snapshot();
  const customerOf = async (phone) => (await snapshot()).customers.find((x) => x.phone.endsWith(phone.slice(-9)));
  return { store, call, buy, snapshot, customerOf, at: (iso) => (now = new Date(iso)), now: () => now };
}
const on = (f, points = {}) => f.call("/api/admin/rewards/settings", { points: { enabled: true, ...points } }, { role: "owner" });
const endBundle = (f, customerId) => f.store.transaction((s) => {
  for (const v of s.vouchers.filter((x) => x.customerId === customerId && !x.reward)) { v.status = "expired"; v.expiresAt = new Date(+f.now() - 1000).toISOString(); }
});

test("a 4,000 XAF bundle earns 40 points once, on the bundle price; nothing while the programme is off or for payments made before it was on", async (t) => {
  const f = await server(t);
  const before = (await f.call("/api/purchase", { phone: "670100001", planId: "unlimited-7d-2", network: "mtn", requestKey: randomUUID() })).body.payment.id;
  f.at("2026-12-01T09:30:00Z");
  assert.equal((await on(f)).status, 200);
  await f.call(`/api/payments/${before}/confirm`, {});
  let s = await f.snapshot();
  assert.equal(s.payments.find((p) => p.id === before).status, "paid");
  assert.equal(s.pointsLedger.length, 0, "made before the switch-on: no points");

  f.at("2026-12-01T10:00:00Z");
  const id = await f.buy("670100002", "unlimited-7d-2");
  assert.equal((await f.call(`/api/payments/${id}/confirm`, {})).status, 200, "confirmed again");
  s = await f.snapshot();
  const c = await f.customerOf("670100002"), rows = s.pointsLedger.filter((r) => r.customerId === c.id);
  assert.deepEqual(rows.map((r) => [r.kind, r.points, r.paymentId, r.bundle.id]), [["earned", 40, id, "unlimited-7d-2"]]);
  assert.equal(rows[0].expiresAt, "2027-12-01T10:00:00.000Z", "points last 12 months");
  const p = s.payments.find((x) => x.id === id);
  assert.equal(p.amount, 4000, "the bundle price; the Mobile Money fee is never on it");

  // 1 point per XAF: still the bundle price only.
  await on(f, { xafPerPoint: 1 });
  await f.buy("670100003", "unlimited-24h-1");
  assert.equal(balanceOf(await f.snapshot(), (await f.customerOf("670100003")).id), 500);

  // Off: no new points; switched on again, only payments made after.
  await f.call("/api/admin/rewards/settings", { points: { enabled: false } }, { role: "owner" });
  await f.buy("670100004", "unlimited-24h-1");
  assert.equal(balanceOf(await f.snapshot(), (await f.customerOf("670100004")).id), 0);
});

test("the Rewards screen's figures come from the server; redeeming saves a bundle with its terms, and a double tap spends once", async (t) => {
  const f = await server(t);
  await on(f);
  await f.buy("670200001", "unlimited-30d-2"); // 10,000 XAF: 100 points
  const c = await f.customerOf("670200001");
  await f.store.transaction((s) => { appendRow(s, { customerId: c.id, kind: "adjusted", points: 1140, reason: "test", actor: "owner" }, f.now()); });
  let view = (await f.call("/api/account/rewards", undefined, { customer: "670200001" })).body;
  assert.deepEqual([view.balance, view.valueXaf, view.programme], [1240, 6200, { points: true, referrals: false }]);
  assert.deepEqual(view.nextExpiry, { at: "2027-12-01T09:00:00.000Z", points: 1240 });
  const weekly = view.offers.find((o) => o.id === "unlimited-7d-1");
  assert.deepEqual([weekly.points, weekly.affordable, weekly.validityHours, weekly.deviceSlots], [500, true, 168, 1]);
  assert.equal(view.offers.some((o) => o.accessType === "home_wisp_unlimited"), false, "Home WISP is off until the owner turns it on");
  assert.deepEqual(view.offers.find((o) => o.id === "unlimited-30d-6").need, 6000 - 1240, "the points still needed");
  assert.equal(view.history[0].kind, "adjusted");

  // A double tap: the same key spends once.
  const key = randomUUID();
  const [one, two] = await Promise.all([1, 2].map(() => f.call("/api/account/rewards/redeem", { offerId: "unlimited-7d-1", idempotencyKey: key }, { customer: "670200001" })));
  assert.deepEqual([one.status, two.status], [200, 200]);
  assert.equal(one.body.saved.voucherId, two.body.saved.voucherId);
  assert.equal([one.body.replayed, two.body.replayed].filter(Boolean).length, 1);
  let s = await f.snapshot();
  const saved = s.vouchers.filter((v) => v.reward && v.customerId === c.id);
  assert.equal(saved.length, 1);
  assert.equal(balanceOf(s, c.id), 740);
  const v = saved[0];
  assert.deepEqual([v.status, v.saleType, v.paymentId, v.faceValue, v.deviceSlots, v.validityHours, v.customTerms.price, v.startBy],
    ["available", "reward", undefined, null, 1, 168, 2500, new Date(+f.now() + 60 * DAY).toISOString()], "saved, with its terms, never revenue");

  // Two different requests with points for only one.
  const [a, b] = await Promise.all([1, 2].map(() => f.call("/api/account/rewards/redeem", { offerId: "unlimited-7d-1", idempotencyKey: randomUUID() }, { customer: "670200001" })));
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal([a, b].find((x) => x.status === 409).body.code, "NOT_ENOUGH_POINTS");
  s = await f.snapshot();
  assert.equal(balanceOf(s, c.id), 240);
  assert.equal(s.vouchers.filter((x) => x.reward && x.customerId === c.id).length, 2);

  // No key, an unknown offer, or not enough points.
  assert.equal((await f.call("/api/account/rewards/redeem", { offerId: "unlimited-7d-1" }, { customer: "670200001" })).body.code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal((await f.call("/api/account/rewards/redeem", { offerId: "home-wisp-30d", idempotencyKey: randomUUID() }, { customer: "670200001" })).body.code, "OFFER_UNAVAILABLE");
  assert.equal((await f.call("/api/account/rewards/redeem", { offerId: "unlimited-30d-1", idempotencyKey: randomUUID() }, { customer: "670200001" })).status, 409);
  assert.equal((await f.call("/api/account/rewards", undefined, {})).status, 401);
});

test("Start now waits for the current bundle to end; unstarted after the window, it expires and the points stay spent", async (t) => {
  const f = await server(t);
  await on(f);
  await f.buy("670300001", "unlimited-30d-6"); // 30,000 XAF: 300 points
  const c = await f.customerOf("670300001");
  const redeemed = (await f.call("/api/account/rewards/redeem", { offerId: "unlimited-24h-1", idempotencyKey: randomUUID() }, { customer: "670300001" })).body;
  assert.equal(redeemed.rewards.activeBundle !== null, true, "the bought bundle waits for its first connection: it counts as the current one");
  const refused = await f.call("/api/account/rewards/start", { voucherId: redeemed.saved.voucherId }, { customer: "670300001" });
  assert.deepEqual([refused.status, refused.body.code], [409, "ACTIVE_BUNDLE_EXISTS"]);
  await endBundle(f, c.id);
  const started = await f.call("/api/account/rewards/start", { voucherId: redeemed.saved.voucherId }, { customer: "670300001" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual([started.body.voucher.status, started.body.voucher.expiresAt], ["active", new Date(+f.now() + 24 * HOUR).toISOString()]);
  let s = await f.snapshot();
  assert.ok(s.routerCommands.some((x) => x.action === "sync_voucher" && x.targetId === redeemed.saved.voucherId));
  assert.equal((await f.call("/api/account/rewards/start", { voucherId: redeemed.saved.voucherId }, { customer: "670300001" })).body.replayed, true);

  // A second one, never started.
  const late = (await f.call("/api/account/rewards/redeem", { offerId: "unlimited-24h-1", idempotencyKey: randomUUID() }, { customer: "670300001" })).body;
  f.at(new Date(+f.now() + 61 * DAY).toISOString());
  const view = (await f.call("/api/account/rewards", undefined, { customer: "670300001" })).body;
  assert.equal(view.saved.length, 0);
  s = await f.snapshot();
  assert.equal(s.vouchers.find((v) => v.id === late.saved.voucherId).status, "expired");
  assert.equal(balanceOf(s, c.id), 100, "300 earned, 200 spent");
  assert.equal((await f.call("/api/account/rewards/start", { voucherId: late.saved.voucherId }, { customer: "670300001" })).body.code, "START_WINDOW_ENDED");
});

test("a refund takes back the points; a balance that would go negative stays at zero and the shortfall comes out of the next points", async (t) => {
  const f = await server(t);
  await on(f);
  const id = await f.buy("670400001", "unlimited-30d-6");
  const c = await f.customerOf("670400001");
  for (const _ of [1, 2, 3]) assert.equal((await f.call("/api/account/rewards/redeem", { offerId: "unlimited-24h-1", idempotencyKey: randomUUID() }, { customer: "670400001" })).status, 200); // 300 → 0
  assert.equal((await f.call("/api/account/payments/refund", { paymentId: id, reason: "Not working" }, { customer: "670400001" })).status, 200);
  await f.call("/api/admin/payments/refund", { paymentId: id }, { role: "owner" });
  let s = await f.snapshot();
  assert.equal(s.payments.find((p) => p.id === id).status, "refunded");
  const refund = s.pointsLedger.find((r) => r.kind === "refunded");
  assert.deepEqual([refund.points, refund.shortfall, balanceOf(s, c.id)], [0, 300, 0], "held at zero, the shortfall recorded");
  await endBundle(f, c.id);
  await f.store.transaction((st) => { for (const v of st.vouchers.filter((x) => x.customerId === c.id)) v.status = "expired"; });
  await f.buy("670400001", "unlimited-30d-2"); // 100 points, all owed
  s = await f.snapshot();
  assert.equal(balanceOf(s, c.id), 0);
  await f.store.transaction((st) => { for (const v of st.vouchers.filter((x) => x.customerId === c.id)) v.status = "expired"; });
  await f.buy("670400001", "unlimited-30d-6"); // 300 points: 200 still owed, 100 left
  s = await f.snapshot();
  assert.equal(balanceOf(s, c.id), 100);
  assert.equal(s.pointsLedger.filter((r) => r.customerId === c.id && r.offset).reduce((n, r) => n - r.points, 0), 300, "the whole shortfall offset");
});

test("expiry takes the oldest points first and the next expiry shows the right date and amount", () => {
  const s = { pointsLedger: [], vouchers: [] }, c = "c1", at = (d) => new Date(d);
  appendRow(s, { customerId: c, kind: "earned", points: 180, paymentId: "p1", key: "earn:p1" }, at("2026-02-12T08:00:00Z"));
  appendRow(s, { customerId: c, kind: "earned", points: 300, paymentId: "p2", key: "earn:p2" }, at("2026-05-01T08:00:00Z"));
  appendRow(s, { customerId: c, kind: "redeemed", points: -100 }, at("2026-06-01T08:00:00Z"));
  assert.deepEqual(pointLots(s, c).map((l) => l.remaining), [80, 300], "spent from the oldest");
  assert.deepEqual(nextExpiry(s, c, at("2026-12-01T00:00:00Z")), { at: "2027-02-12T08:00:00.000Z", points: 80 });
  assert.equal(expirePoints(s, at("2027-02-12T07:59:59Z")).length, 0);
  const [row] = expirePoints(s, at("2027-02-13T00:00:00Z"));
  assert.deepEqual([row.kind, row.points, row.earnedFrom], ["expired", -80, "2026-02-12T08:00:00.000Z"]);
  assert.equal(expirePoints(s, at("2027-02-14T00:00:00Z")).length, 0, "written once");
  assert.deepEqual([balanceOf(s, c), nextExpiry(s, c, at("2027-02-14T00:00:00Z"))], [300, { at: "2027-05-01T08:00:00.000Z", points: 300 }]);
  // A refund takes its own payment's points first.
  takeBackForPayment(s, { id: "p2" }, at("2027-03-01T00:00:00Z"));
  assert.deepEqual([balanceOf(s, c), pointLots(s, c).length], [0, 0]);
  assert.equal(takeBackForPayment(s, { id: "p2" }, at("2027-03-02T00:00:00Z")), null, "once");
});

test("recent activity shows one expiry sweep as one System row with all its customers", async () => {
  const { adminRewardsView } = await import("../lib/api/admin-rewards.mjs");
  const s = { pointsLedger: [], vouchers: [], customers: [], bundles: [], catalogue: { mode: "unlimited" } };
  for (let i = 0; i < 5; i++) appendRow(s, { customerId: "c" + i, kind: "earned", points: 10 }, new Date("2025-01-01T00:00:00Z"));
  expirePoints(s, new Date("2026-02-01T00:00:00Z"));
  for (let i = 0; i < 5; i++) appendRow(s, { customerId: "x", kind: "earned", points: 1 }, new Date(`2026-03-0${i + 1}T00:00:00Z`));
  const activity = adminRewardsView(s, new Date("2026-03-10T00:00:00Z")).activity;
  assert.equal(activity.length, 6);
  assert.deepEqual([activity[5].system, activity[5].customers, activity[5].points], [true, 5, -50]);
});

test("earning rules: gifts, custom bundles and payments held for review earn nothing", () => {
  const s = { pointsLedger: [], vouchers: [], rewardsSettings: { points: { enabled: true, enabledAt: "2026-12-01T00:00:00Z" } } };
  const p = (extra) => ({ id: randomUUID(), customerId: "c1", status: "paid", amount: 2500, createdAt: "2026-12-02T00:00:00Z", ...extra });
  const now = new Date("2026-12-02T01:00:00Z"), plan = { id: "unlimited-7d-1", name: "Personal Unlimited", validityHours: 168, deviceSlots: 1 };
  assert.equal(earnForPayment(s, p({ gift: { recipient: "x" } }), plan, now), null);
  assert.equal(earnForPayment(s, p({}), { ...plan, custom: true, catalogue: "custom_gift" }, now), null);
  assert.equal(earnForPayment(s, p({ reconciliation: { status: "needs_review" } }), plan, now), null);
  assert.equal(earnForPayment(s, p({ status: "pending" }), plan, now), null);
  assert.equal(earnForPayment(s, p({ createdAt: "2026-11-30T23:59:59Z" }), plan, now), null);
  assert.equal(earnForPayment(s, p({}), plan, now).points, 25);
  assert.equal(rewardSettings(s).points.xafPerPoint, 100, "the defaults fill what isn't set");
});

test("Rewards admin: owners only; settings audited and validated; switching on needs the Unlimited catalogue; corrections need a reason", async (t) => {
  const legacy = await server(t, { unlimited: false });
  const refused = await on(legacy);
  assert.deepEqual([refused.status, refused.body.code], [409, "CATALOGUE_NOT_UNLIMITED"]);

  const f = await server(t);
  assert.equal((await f.call("/api/admin/rewards", undefined, { role: "operator" })).status, 403, "operators can't see it");
  assert.equal((await f.call("/api/admin/rewards/settings", { points: { enabled: true } }, { role: "operator" })).status, 403);
  let view = (await f.call("/api/admin/rewards", undefined, { role: "owner" })).body;
  assert.deepEqual(view.settings.points, { enabled: false, enabledAt: null, xafPerPoint: 100, pointValueXaf: 5, expiryMonths: 12, startWithinDays: 60 });
  assert.deepEqual(view.settings.referrals, { enabled: false, enabledAt: null, referrerPoints: 200, welcomePoints: 100, monthlyCap: 10, minFirstBundleXaf: 500 });
  const day = view.offers.find((o) => o.id === "unlimited-24h-1"), home = view.offers.find((o) => o.id === "home-wisp-30d");
  assert.deepEqual([day.price, day.points, day.suggested, day.redeemable, home.points, home.redeemable], [500, 100, 100, true, 10000, false]);

  const saved = await f.call("/api/admin/rewards/settings", { points: { enabled: true, expiryMonths: 24, startWithinDays: 90 },
    offers: [{ bundleId: "home-wisp-30d", points: 9000, redeemable: true }] }, { role: "owner" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.settings.points.enabled, saved.body.settings.points.enabledAt, saved.body.settings.points.expiryMonths], [true, start.toISOString(), 24]);
  assert.deepEqual(saved.body.offers.find((o) => o.id === "home-wisp-30d").points, 9000);
  for (const bad of [{ points: { xafPerPoint: 0 } }, { points: { expiryMonths: 7 } }, { referrals: { monthlyCap: 0 } }, { offers: [{ bundleId: "nope", points: 1 }] }])
    assert.equal((await f.call("/api/admin/rewards/settings", bad, { role: "owner" })).status, 400, JSON.stringify(bad));
  let s = await f.snapshot();
  const audited = s.auditLogs.filter((x) => x.action === "rewards.settings_updated");
  assert.equal(audited.length, 1);
  assert.equal(audited[0].actor, "owner");

  await f.buy("670500001", "unlimited-24h-1");
  const c = await f.customerOf("670500001");
  assert.equal((await f.call("/api/admin/rewards/adjust", { customerId: c.id, points: 50 }, { role: "owner" })).status, 400, "a reason is required");
  assert.equal((await f.call("/api/admin/rewards/adjust", { customerId: c.id, points: -100, reason: "Too many" }, { role: "owner" })).body.code, "BALANCE_TOO_LOW");
  const adjusted = await f.call("/api/admin/rewards/adjust", { customerId: c.id, points: 50, reason: "Network outage on 1 Dec" }, { role: "owner" });
  assert.equal(adjusted.status, 200);
  s = await f.snapshot();
  assert.equal(balanceOf(s, c.id), 55);
  assert.ok(s.auditLogs.some((x) => x.action === "rewards.points_adjusted" && x.meta.points === 50));
  const ledger = (await f.call(`/api/admin/rewards/ledger?customerId=${c.id}`, undefined, { role: "owner" })).body;
  assert.deepEqual(ledger.rows.map((r) => [r.kind, r.points]), [["adjusted", 50], ["earned", 5]]);
  assert.equal(ledger.rows[0].customer.phone, "6•• •• 00 01");

  // Turning points off stops earning; existing points stay redeemable.
  await f.call("/api/admin/rewards/settings", { points: { enabled: false } }, { role: "owner" });
  await f.store.transaction((st) => { for (const v of st.vouchers.filter((x) => x.customerId === c.id)) v.status = "expired"; });
  await f.buy("670500001", "unlimited-24h-2");
  assert.equal(balanceOf(await f.snapshot(), c.id), 55, "no new points while off");
  await f.call("/api/admin/rewards/settings", { offers: [{ bundleId: "unlimited-5h-1", points: 50, redeemable: true }] }, { role: "owner" });
  assert.equal((await f.call("/api/account/rewards/redeem", { offerId: "unlimited-5h-1", idempotencyKey: randomUUID() }, { customer: "670500001" })).status, 200);
  view = (await f.call("/api/admin/rewards", undefined, { role: "owner" })).body;
  assert.deepEqual([view.metrics.outstandingPoints, view.metrics.outstandingXaf, view.metrics.redeemedThisMonth], [5, 25, { points: 50, bundles: 1 }]);
  assert.equal(view.offers.find((o) => o.id === "unlimited-5h-1").redeemed30d, 1);
  assert.equal(view.activity[0].kind, "redeemed");
  const insights = (await f.call("/api/admin/insights?from=2026-11-01&to=2026-12-01", undefined, { role: "owner" })).body;
  assert.deepEqual([insights.rewards.outstandingPoints, insights.rewards.redemptionsByMonth[0]], [5, { month: "2026-12", points: 50, bundles: 1 }]);
});
