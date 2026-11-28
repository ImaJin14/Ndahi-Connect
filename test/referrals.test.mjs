import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";
import { hashSecret } from "../lib/security.mjs";
import { balanceOf } from "../lib/rewards.mjs";
import { attributeReferral, referralOnPayment, referralCode, shortName, BURST_PER_DAY } from "../lib/referrals.mjs";

// Referrals (#527), paid in points (#526).
const start = new Date("2026-12-01T09:00:00Z"), secret = "referral-tests";

async function server(t) {
  const store = createStore({ persistent: false });
  let now = start;
  await store.transaction((s) => {
    seedCatalogue(s, now); s.catalogue.mode = "unlimited";
    s.adminUsers.push({ id: "owner", role: "owner", username: "owner", active: true }, { id: "operator", role: "operator", username: "operator", active: true });
    for (const id of ["owner", "operator"]) s.adminSessions.push({ id, userId: id, role: id, tokenHash: hashSecret(id, secret), csrfToken: "csrf-" + id, expiresAt: "2031-01-01T00:00:00Z" });
    s.customers.push({ id: "amina", name: "Amina Ndi", phone: "670700001", createdAt: start.toISOString() });
    s.dashboardSessions.push({ id: "amina", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf-amina", expiresAt: "2031-01-01T00:00:00Z" });
  });
  const app = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret,
    SECRET_PEPPER: secret, NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent", CUSTOMER_APP_URL: "https://portal.ndahiconnect.net" } });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { app.closeAllConnections(); app.close(r); }));
  const base = "http://127.0.0.1:" + app.address().port;
  const call = async (path, input, { role, customer, headers = {} } = {}) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { ...headers, ...(input ? { "content-type": "application/json" } : {}),
      ...(role ? { cookie: "admin_session=" + role, "x-csrf-token": "csrf-" + role } : customer ? { cookie: "customer_session=" + customer, "x-csrf-token": "csrf-" + customer } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  // A new number checks out with the code and pays.
  const friend = async (phone, planId = "unlimited-24h-1", code) => {
    const placed = await call("/api/purchase", { phone, planId, network: "mtn", requestKey: randomUUID(), ...(code ? { referralCode: code } : {}) });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal((await call(`/api/payments/${placed.body.payment.id}/confirm`, {})).status, 200);
    return placed.body.payment.id;
  };
  const snapshot = () => store.snapshot();
  const byPhone = async (phone) => (await snapshot()).customers.find((c) => c.phone.endsWith(phone.slice(-9)));
  return { store, call, friend, snapshot, byPhone, at: (iso) => (now = new Date(iso)), now: () => now };
}
const switchOn = (f, referrals = {}) => f.call("/api/admin/rewards/settings", { points: { enabled: true }, referrals: { enabled: true, ...referrals } }, { role: "owner" });

test("the referrer gets 200 and the friend 100 once, after the friend's first confirmed payment of at least 500 XAF; the code and friends show in Rewards", async (t) => {
  const f = await server(t);
  assert.equal((await switchOn(f)).status, 200);
  const mine = (await f.call("/api/account/rewards", undefined, { customer: "amina" })).body.referral;
  assert.match(mine.code, /^AMINA-[A-HJ-KM-NP-Z2-9]{3}$/);
  assert.equal(mine.link, `https://portal.ndahiconnect.net/r/${mine.code}`);
  assert.deepEqual(mine.friends, []);

  const landing = await f.call(`/api/referrals/${mine.code.toLowerCase()}`);
  assert.equal(landing.status, 200);
  assert.deepEqual(landing.body, { valid: true, code: mine.code, firstName: "Amina", welcomePoints: 100,
    freeBundle: { id: "unlimited-24h-1", name: "Personal Unlimited", validityHours: 24, deviceSlots: 1, accessType: "personal_unlimited" } });
  assert.equal(JSON.stringify(landing.body).includes("670700001"), false, "never the referrer's number");
  assert.deepEqual((await f.call("/api/referrals/NOBODY-2X9")).body, { valid: false });

  const paymentId = await f.friend("690880021", "unlimited-7d-1", mine.code); // 2,500 XAF
  let s = await f.snapshot();
  const friend = await f.byPhone("690880021");
  assert.equal(balanceOf(s, "amina"), 200);
  assert.equal(balanceOf(s, friend.id), 100 + 25, "the welcome bonus and the points on the bundle");
  const rows = s.pointsLedger.filter((r) => r.referralId);
  assert.deepEqual(rows.map((r) => [r.kind, r.points]), [["referral", 200], ["welcome", 100]]);
  assert.equal(rows[0].friend, "6•• •• 00 21");
  assert.deepEqual(rows[1].invitedBy, { name: "A. Ndi", code: mine.code });
  assert.equal((await f.call(`/api/payments/${paymentId}/confirm`, {})).status, 200, "confirmed again");
  assert.equal(balanceOf(await f.snapshot(), "amina"), 200, "once");

  // A pending friend: checked out with the code, not paid yet.
  await f.call("/api/purchase", { phone: "690887731", planId: "unlimited-24h-1", network: "mtn", requestKey: randomUUID(), referralCode: mine.code });
  const friends = (await f.call("/api/account/rewards", undefined, { customer: "amina" })).body.referral.friends;
  assert.deepEqual(friends.map((x) => [x.phone, x.status, x.points]), [["6•• •• 00 21", "joined", 200], ["6•• •• 77 31", "pending", undefined]], "joined first, as drawn");
  const history = (await f.call("/api/account/rewards", undefined, { customer: "amina" })).body.history;
  assert.deepEqual([history[0].kind, history[0].friend], ["referral", "6•• •• 00 21"]);
});

test("an existing number, the referrer's own number, a first bundle under 500 XAF and the referrer's Mobile Money number earn nothing", async (t) => {
  const f = await server(t);
  await switchOn(f);
  const code = (await f.call("/api/account/rewards", undefined, { customer: "amina" })).body.referral.code;
  // An existing number: bought before, then comes back with a code.
  await f.at("2026-12-01T10:00:00Z");
  await f.friend("690110001");
  const existing = await f.byPhone("690110001");
  await f.store.transaction((s) => { assert.equal(attributeReferral(s, s.customers.find((c) => c.id === existing.id), code, f.now()).status, "not_new"); });
  // The referrer's own number.
  await f.store.transaction((s) => { assert.equal(attributeReferral(s, s.customers.find((c) => c.id === "amina"), code, f.now()).status, "own"); });
  // A first bundle under the smallest that counts.
  await f.friend("690110002", "unlimited-5h-1", code); // 250 XAF
  let s = await f.snapshot();
  const small = s.referrals.find((r) => r.friendId === (s.customers.find((c) => c.phone.endsWith("690110002")).id));
  assert.deepEqual([small.status, small.reason], ["ineligible", "below_minimum"]);
  // Paid from the referrer's Mobile Money number.
  await f.store.transaction((st) => {
    const c = { id: "kofi", name: "Kofi", phone: "690110003", createdAt: f.now().toISOString() };
    st.customers.push(c);
    attributeReferral(st, c, code, f.now());
    const p = { id: "p-kofi", customerId: "kofi", status: "paid", amount: 2500, payerPhone: "670700001", createdAt: f.now().toISOString() };
    st.payments.push(p);
    const r = referralOnPayment(st, p, f.now());
    assert.deepEqual([r.status, r.reason], ["rejected", "referrer_number"]);
  });
  s = await f.snapshot();
  assert.equal(balanceOf(s, "amina"), 0);
  assert.equal(s.pointsLedger.filter((r) => r.referralId).length, 0);
});

test("a friend on the referrer's Wi-Fi device is held: approval pays, rejection pays nothing, both audited; the 11th friend in a month is recorded but not paid", async (t) => {
  const f = await server(t);
  await switchOn(f, { monthlyCap: 2 });
  const code = (await f.call("/api/account/rewards", undefined, { customer: "amina" })).body.referral.code;
  // Two friends on Amina's own device: held for review.
  for (const [phone, mac] of [["690220001", "AA:BB:CC:00:00:01"], ["690220002", "AA:BB:CC:00:00:01"]]) {
    await f.call("/api/purchase", { phone, planId: "unlimited-24h-1", network: "mtn", requestKey: randomUUID(), referralCode: code });
    await f.store.transaction((s) => {
      const c = s.customers.find((x) => x.phone.endsWith(phone));
      s.wifiDeviceGrants.push({ id: randomUUID(), customerId: "amina", mac, status: "approved" }, { id: randomUUID(), customerId: c.id, mac, status: "approved" });
      const p = s.payments.find((x) => x.customerId === c.id);
      f.paymentFor ??= {}; f.paymentFor[phone] = p.id;
    });
    await f.call(`/api/payments/${f.paymentFor[phone]}/confirm`, {});
  }
  let admin = (await f.call("/api/admin/rewards", undefined, { role: "owner" })).body;
  assert.equal(admin.metrics.flagged, 2);
  assert.deepEqual(admin.review.map((r) => [r.code, r.friend.phone, r.reasons]), [[code, "6•• •• 00 02", ["same_device"]], [code, "6•• •• 00 01", ["same_device"]]]);
  assert.equal(balanceOf(await f.snapshot(), "amina"), 0, "no points until approved");
  assert.equal((await f.call(`/api/admin/rewards/referrals/${admin.review[0].id}/approve`, {}, { role: "operator" })).status, 403);
  const approved = await f.call(`/api/admin/rewards/referrals/${admin.review[1].id}/approve`, {}, { role: "owner" });
  assert.equal(approved.status, 200);
  const rejected = await f.call(`/api/admin/rewards/referrals/${admin.review[0].id}/reject`, {}, { role: "owner" });
  assert.equal(rejected.body.referral.status, "rejected");
  assert.equal((await f.call(`/api/admin/rewards/referrals/${admin.review[0].id}/approve`, {}, { role: "owner" })).status, 409, "decided once");
  let s = await f.snapshot();
  assert.equal(balanceOf(s, "amina"), 200);
  assert.deepEqual(s.auditLogs.filter((x) => x.action.startsWith("rewards.referral_")).map((x) => x.action).sort(), ["rewards.referral_approved", "rewards.referral_rejected"]);
  // The cap (2 here): one paid this month, so the next is paid and the one after is recorded only.
  await f.friend("690220003", "unlimited-24h-1", code);
  await f.friend("690220004", "unlimited-24h-1", code);
  s = await f.snapshot();
  const capped = s.referrals.find((r) => r.friendId === s.customers.find((c) => c.phone.endsWith("690220004")).id);
  assert.deepEqual([capped.status, capped.reason], ["capped", "monthly_cap"]);
  assert.equal(balanceOf(s, "amina"), 400);
  admin = (await f.call("/api/admin/rewards", undefined, { role: "owner" })).body;
  assert.deepEqual([admin.metrics.friendsThisMonth, admin.metrics.flagged], [{ count: 2, points: 400 }, 0]);
});

test("several friends paid from one Mobile Money number, or a burst in one day, are held", () => {
  const s = { customers: [{ id: "r", name: "Grace Tabe", phone: "670000001" }], payments: [], vouchers: [], referrals: [], pointsLedger: [], wifiDeviceGrants: [],
    rewardsSettings: { points: { enabled: true, enabledAt: "2026-12-01T00:00:00Z" }, referrals: { enabled: true, enabledAt: "2026-12-01T00:00:00Z", monthlyCap: 50 } } };
  const now = new Date("2026-12-02T10:00:00Z");
  referralCode(s, s.customers[0]);
  const join = (i, payer) => {
    const c = { id: "f" + i, name: "Friend", phone: `69000${String(i).padStart(4, "0")}` };
    s.customers.push(c);
    attributeReferral(s, c, s.customers[0].referralCode, now);
    const p = { id: "p" + i, customerId: c.id, status: "paid", amount: 500, payerPhone: payer || c.phone, createdAt: now.toISOString() };
    s.payments.push(p);
    return referralOnPayment(s, p, now);
  };
  assert.equal(join(1).status, "paid");
  assert.equal(join(2, "699999999").status, "paid");
  assert.deepEqual([join(3, "699999999").status, s.referrals.at(-1).reasons], ["held", ["same_payer"]]);
  for (let i = 4; i <= BURST_PER_DAY; i++) assert.equal(join(i).status, "paid");
  assert.deepEqual([join(BURST_PER_DAY + 1).status, s.referrals.at(-1).reasons], ["held", ["burst"]]);
  assert.equal(shortName("Jean-Paul Fon"), "J. Fon");
});

test("a refund of the friend's first payment takes both payouts back", async (t) => {
  const f = await server(t);
  await switchOn(f);
  const code = (await f.call("/api/account/rewards", undefined, { customer: "amina" })).body.referral.code;
  const paymentId = await f.friend("690330001", "unlimited-7d-1", code);
  const friend = await f.byPhone("690330001");
  await f.store.transaction((s) => { s.dashboardSessions.push({ id: "friend", customerId: friend.id, tokenHash: hashSecret("friend", secret), csrfToken: "csrf-friend", expiresAt: "2031-01-01T00:00:00Z" }); });
  assert.equal((await f.call("/api/account/payments/refund", { paymentId, reason: "Wrong bundle" }, { customer: "friend" })).status, 200);
  await f.call("/api/admin/payments/refund", { paymentId }, { role: "owner" });
  const s = await f.snapshot();
  assert.equal(s.payments.find((p) => p.id === paymentId).status, "refunded");
  assert.deepEqual([balanceOf(s, "amina"), balanceOf(s, friend.id)], [0, 0]);
  assert.equal(s.referrals[0].status, "reversed");
});

test("the code lookup is rate-limited and answers nothing while referrals are off", async (t) => {
  const f = await server(t);
  await f.store.transaction((s) => { s.customers[0].referralCode = "AMINA-7K2"; });
  assert.deepEqual((await f.call("/api/referrals/AMINA-7K2")).body, { valid: false }, "off");
  await switchOn(f);
  assert.equal((await f.call("/api/referrals/AMINA-7K2")).status, 200);
  let last;
  for (let i = 0; i < 30; i++) last = await f.call("/api/referrals/AMINA-7K2");
  assert.equal(last.status, 429);
});
