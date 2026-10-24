import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { blank } from "../lib/api/state.mjs";
import { createHandler, createStore } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { MockPaymentAdapter } from "../lib/payments.mjs";
import { reservePurchase } from "../lib/domain/purchases.mjs";
import { activeSubscription, subscriptionPurchaseAccess } from "../lib/subscription-policy.mjs";

const initialTime = new Date("2030-01-01T12:00:00Z"), number = "670132001";
const voucher = (extra = {}) => ({ id: "existing", customerId: "owner", planId: "weekly", status: "active",
  expiresAt: new Date(+initialTime + 3600000).toISOString(), quotaBytes: 5e9, usedBytes: 1e9, ...extra });

test("active purchase policy uses server time/quota, preserves unlimited and fails closed on invalid active data", () => {
  for (const [extra, blocked] of [
    [{}, true], [{ quotaBytes: null }, true], [{ usedBytes: 5e9 - 1 }, true],
    [{ expiresAt: initialTime.toISOString() }, false], [{ usedBytes: 5e9 }, false],
    [{ status: "expired" }, false], [{ status: "exhausted" }, false], [{ status: "cancelled" }, false],
    [{ status: "pending" }, false], [{ expiresAt: "invalid" }, true], [{ quotaBytes: undefined }, true],
  ]) {
    const state = blank(); state.vouchers.push(voucher(extra));
    assert.equal(Boolean(activeSubscription(state, "owner", initialTime)), blocked, JSON.stringify(extra));
    assert.equal(subscriptionPurchaseAccess(state, { id: "owner" }, initialTime).allowed, !blocked);
    assert.equal(subscriptionPurchaseAccess(state, { id: "another" }, initialTime).allowed, true);
  }
});

for (const input of [
  { upgrade: true, planId: "monthly" }, { upgrade: "true", planId: "daily" },
  { action: "renew" }, { action: "switch", planId: "monthly", replaceVoucherId: "existing" },
]) test("active reservation rejects bypass parameters privately: " + JSON.stringify(input), () => {
  for (const account of [false, true]) {
    const state = blank(); state.customers.push({ id: "owner", phone: number }); state.vouchers.push(voucher());
    const outcome = reservePurchase(state, { phone: "+237 (670) 132-001", planId: "weekly", ...input }, {
      clock: () => initialTime, provider: "mock", requester: { ip: "127.0.0.1" }, ...(account ? { accountCustomerId: "owner" } : {}),
    });
    assert.equal(outcome.status, 409); assert.equal(outcome.body.code, "ACTIVE_BUNDLE_EXISTS");
    assert.deepEqual(Object.keys(outcome.body).sort(), ["code", "error"]);
    assert.equal(state.payments.length, 0); assert.equal(state.vouchers[0].status, "active");
  }
});

async function fixture(t, { store = createStore({ persistent: false }), seed = true } = {}) {
  let now = new Date(initialTime), charges = 0;
  const adapter = new MockPaymentAdapter(), create = adapter.createPayment.bind(adapter);
  adapter.createPayment = async (...args) => { charges++; return create(...args); };
  const handler = createHandler({ store, payments: { mock: adapter }, validateConfig: false, now: () => now, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: "http://customer.test", CUSTOMER_SESSION_SECRET: randomUUID(), SECRET_PEPPER: randomUUID(),
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent",
  } });
  const server = http.createServer(handler); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + server.address().port;
  let cookie = "";
  const call = async (path, input, owner = cookie) => {
    const response = await fetch(base + path, { method: input === undefined ? "GET" : "POST", headers: {
      origin: "http://customer.test", "content-type": "application/json", ...(owner ? { cookie: owner } : {}),
    }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const set = response.headers.get("set-cookie");
    if (set?.startsWith("customer_session=")) cookie = set.split(";")[0];
    return { status: response.status, body: await response.json() };
  };
  let original;
  if (seed) {
    const created = await call("/api/purchase", { phone: number, planId: "weekly", requestKey: randomUUID() });
    assert.equal(created.status, 201);
    const paid = await call(`/api/payments/${created.body.payment.id}/confirm`, {});
    assert.equal(paid.status, 200);
    const pin = String(randomInt(1000, 10000));
    assert.equal((await call("/api/account/setup/pin", { phone: number, code: paid.body.access.code, pin, confirmPin: pin })).status, 200);
    original = { payment: created.body.payment, voucher: paid.body.voucher, pin };
  }
  return { store, handler, call, original, cookie: () => cookie, charges: () => charges,
    advance: (seconds) => { now = new Date(+now + seconds * 1000); },
    exhaust: () => store.transaction((s) => { s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes; }) };
}

test("guest, upgrade and authenticated purchases cannot charge or disturb existing access, including a renewed login", async (t) => {
  const f = await fixture(t), before = await f.store.snapshot();
  for (const [path, input] of [
    ["/api/purchase", { phone: "+237 (670) 132-001", planId: "monthly" }],
    ["/api/purchase", { phone: number, planId: "monthly", upgrade: true }],
    ["/api/account/plan/purchase", { action: "renew", planId: "weekly" }],
    ["/api/account/plan/purchase", { action: "switch", planId: "monthly", replaceVoucherId: f.original.voucher.id }],
  ]) {
    const response = await f.call(path, { ...input, requestKey: randomUUID() });
    assert.equal(response.status, 409); assert.equal(response.body.code, "ACTIVE_BUNDLE_EXISTS");
    assert.deepEqual(Object.keys(response.body).sort(), ["code", "error"]);
  }
  assert.equal((await f.call("/api/account/login/pin", { phone: number, pin: f.original.pin })).status, 200);
  assert.equal((await f.call("/api/account/plan/purchase", { action: "renew", planId: "weekly" })).status, 409);
  const state = await f.store.snapshot();
  assert.equal(f.charges(), 1); assert.deepEqual(state.vouchers, before.vouchers);
  assert.deepEqual(state.routerCommands, before.routerCommands); assert.equal(state.payments.length, 1);
  const dashboard = await f.call("/api/account/dashboard");
  assert.equal(dashboard.body.activeBundle.id, f.original.voucher.id);
  assert.equal(dashboard.body.subscriptionPurchaseAccess.code, "ACTIVE_BUNDLE_EXISTS");
});

for (const state of ["expired", "exhausted", "cancelled"]) test(state + " allowance permits a new purchase without a prior dashboard read", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    if (state === "expired") s.vouchers[0].expiresAt = initialTime.toISOString();
    else if (state === "exhausted") s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes;
    else s.vouchers[0].status = "cancelled";
  });
  const created = await f.call("/api/account/plan/purchase", { action: "switch", planId: "monthly", requestKey: randomUUID() });
  assert.equal(created.status, 201); assert.equal(created.body.payment.replaceVoucherId, undefined);
  const confirmations = await Promise.all([0, 1].map(() => f.call(`/api/payments/${created.body.payment.id}/confirm`, {})));
  assert.deepEqual(confirmations.map((r) => r.status), [200, 200]);
  const stored = await f.store.snapshot();
  assert.equal(stored.vouchers.length, 2); assert.equal(stored.vouchers.filter((v) => v.status === "active").length, 1);
  assert.equal(stored.vouchers.find((v) => v.id === f.original.voucher.id).status, state);
  assert.equal(stored.vouchers.find((v) => v.id === f.original.voucher.id).replacedByPaymentId, undefined);
});

for (const extra of [{ status: "suspended" }, { suspended: true }]) test("suspension prevents checkout and settlement: " + JSON.stringify(extra), async (t) => {
  const f = await fixture(t); await f.exhaust();
  const reserved = await f.call("/api/account/plan/purchase", { action: "renew", planId: "weekly", requestKey: randomUUID() });
  await f.store.transaction((s) => { Object.assign(s.customers[0], extra); });
  assert.equal((await f.call("/api/purchase", { phone: number, planId: "monthly" })).status, 403);
  assert.equal((await f.call("/api/account/plan/purchase", { action: "switch", planId: "monthly" })).status, 403);
  assert.equal((await f.call(`/api/payments/${reserved.body.payment.id}/confirm`, {})).body.code, "ACCOUNT_SUSPENDED");
  const stored = await f.store.snapshot(), paid = stored.payments.find((p) => p.id === reserved.body.payment.id);
  assert.equal(paid.status, "paid"); assert.equal(paid.fulfillmentStatus, "needs_review");
  assert.equal(stored.vouchers.length, 1); assert.equal(f.charges(), 2);
});

test("live pending checkouts block competitors but same-key recovery and exact expiry remain available", async (t) => {
  const f = await fixture(t); await f.exhaust();
  const input = { action: "renew", planId: "weekly", requestKey: randomUUID() };
  const first = await f.call("/api/account/plan/purchase", input);
  const blocked = await f.call("/api/account/plan/purchase", { ...input, requestKey: randomUUID() });
  assert.equal(blocked.body.code, "PAYMENT_IN_PROGRESS"); assert.equal(blocked.body.payment.id, first.body.payment.id);
  assert.equal((await f.call("/api/account/plan/purchase", input)).body.payment.id, first.body.payment.id);
  f.advance(300);
  const fresh = await f.call("/api/account/plan/purchase", { ...input, requestKey: randomUUID() });
  assert.equal(fresh.status, 201); assert.equal(f.charges(), 3);
  assert.equal((await f.store.snapshot()).payments.find((p) => p.id === first.body.payment.id).status, "expired");
});

test("even a matching legacy replacement ID cannot replace an active bundle, sessions or router access", async (t) => {
  const f = await fixture(t), before = await f.store.snapshot(), legacyId = randomUUID();
  await f.store.transaction((s) => {
    s.payments.unshift({ id: legacyId, customerId: s.customers[0].id, provider: "mock", planId: "monthly", amount: 2000,
      currency: "XAF", status: "pending", action: "switch", replaceVoucherId: f.original.voucher.id,
      createdAt: initialTime.toISOString(), requestKey: randomUUID() });
  });
  for (let i = 0; i < 2; i++) {
    const result = await f.call(`/api/payments/${legacyId}/confirm`, {});
    assert.equal(result.status, 409); assert.equal(result.body.code, "ACTIVE_BUNDLE_EXISTS");
  }
  const stored = await f.store.snapshot(), paid = stored.payments.find((p) => p.id === legacyId);
  assert.equal(paid.status, "paid"); assert.equal(paid.fulfillmentStatus, "needs_review");
  assert.ok(paid.receipt); assert.match(paid.failureReason, /existing bundle remains active/);
  assert.deepEqual(stored.vouchers, before.vouchers); assert.deepEqual(stored.sessions, before.sessions);
  assert.deepEqual(stored.routerCommands, before.routerCommands); assert.equal(f.charges(), 1);
});

test("a reserved checkout cannot send a provider prompt after another bundle becomes active", async (t) => {
  const f = await fixture(t), id = randomUUID();
  await f.store.transaction((s) => {
    s.payments.unshift({ id, customerId: s.customers[0].id, provider: "mock", planId: "monthly", amount: 2000,
      status: "pending", creationState: "reserved", createdAt: initialTime.toISOString(),
      paymentExpiresAt: new Date(+initialTime + 300000).toISOString(), action: "switch" });
  });
  await f.handler.billing.startPayment(id);
  const state = await f.store.snapshot(), payment = state.payments.find((p) => p.id === id);
  assert.equal(f.charges(), 1, "only the original purchase contacted the adapter");
  assert.equal(payment.status, "failed"); assert.equal(payment.creationState, "rejected");
  assert.match(payment.failureReason, /not submitted/); assert.equal(state.vouchers.length, 1);
  assert.equal(payment.receipt, undefined, "unsubmitted checkout is not a received payment");
});

test("simultaneous old/new confirmations activate once and preserve the other payment for review", async (t) => {
  const f = await fixture(t); await f.exhaust();
  const purchase = () => f.call("/api/purchase", { phone: number, planId: "monthly", requestKey: randomUUID() });
  const older = await purchase(); f.advance(300); const newer = await purchase();
  const results = await Promise.all([older, newer].map((r) => f.call(`/api/payments/${r.body.payment.id}/confirm`, {})));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const stored = await f.store.snapshot();
  assert.equal(stored.vouchers.filter((v) => v.status === "active").length, 1);
  assert.equal(stored.payments.filter((p) => p.fulfillmentStatus === "needs_review").length, 1);
  assert.equal(stored.payments.filter((p) => p.status === "paid").length, 3);
  assert.ok(stored.payments.every((p) => p.receipt));
});

async function postgresFixture(t) {
  const schema = "ndahi_purchase_132_" + process.pid + "_" + randomInt(1e8), url = process.env.TEST_DATABASE_URL;
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    await pool.query(await readFile(new URL(file, directory), "utf8"));
  }
  return () => createPostgresStore({ pool, initialState: blank });
}
const postgres = { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not set" };
test("PostgreSQL serializes guest/account races across API instances and duplicate fulfillment", postgres, async (t) => {
  const makeStore = await postgresFixture(t), f = await fixture(t, { store: makeStore() }); await f.exhaust();
  const g = await fixture(t, { store: makeStore(), seed: false });
  const results = await Promise.all([
    f.call("/api/account/plan/purchase", { action: "renew", planId: "weekly", requestKey: randomUUID() }),
    g.call("/api/purchase", { phone: "+237 670132001", planId: "monthly", upgrade: true, requestKey: randomUUID() }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const created = results.find((r) => r.status === 201).body.payment;
  const confirmations = await Promise.all([f, g].map((api) => api.call(`/api/payments/${created.id}/confirm`, {})));
  assert.deepEqual(confirmations.map((r) => r.status), [200, 200]);
  const stored = await f.store.snapshot();
  assert.equal(stored.payments.length, 2); assert.equal(stored.vouchers.length, 2);
  assert.equal(stored.vouchers.filter((v) => v.status === "active").length, 1);
  assert.equal(f.charges() + g.charges(), 2);
});

test("PostgreSQL rollback cannot leave a reservation or release active protection", postgres, async (t) => {
  const makeStore = await postgresFixture(t), store = makeStore();
  await store.transaction((s) => { s.customers.push({ id: "owner", phone: number }); });
  await assert.rejects(store.transaction((s) => {
    assert.equal(reservePurchase(s, { phone: number, planId: "weekly" }, {
      clock: () => initialTime, provider: "mock", requester: { ip: "127.0.0.1" },
    }).status, 201);
    throw Error("synthetic rollback");
  }, { scope: ["customer:" + number] }), /synthetic rollback/);
  assert.equal((await store.snapshot()).payments.length, 0);
  await store.transaction((s) => { s.vouchers.push(voucher()); });
  const rejected = await store.transaction((s) => reservePurchase(s, { planId: "monthly", action: "switch" }, {
    clock: () => initialTime, provider: "mock", requester: { ip: "127.0.0.1" }, accountCustomerId: "owner",
  }), { scope: ["customer:" + number] });
  assert.equal(rejected.body.code, "ACTIVE_BUNDLE_EXISTS");
  assert.equal((await store.snapshot()).payments.length, 0);
});
