import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { beginCheckoutSetup, checkoutSetupFromCookie } from "../lib/checkout-setup.mjs";
import { guestCheckoutDeadline } from "../lib/billing.mjs";

async function fixture(t) {
  let time = new Date("2030-01-01T08:00:00Z");
  const store = createStore({ persistent: false });
  const server = createServer({ store, now: () => time, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock",
    OMADA_MODE: "not-configured", BILLING_WORKER_ENABLED: "false", SESSION_COOKIE_SECURE: "false",
    CUSTOMER_SESSION_SECRET: "checkout-test-secret", ADMIN_PIN: "9999",
  } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const call = async (path, data, cookie = "") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: data === undefined ? "GET" : "POST", headers: { "content-type": "application/json", cookie },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { response, json: await response.json() };
  };
  const input = { phone: "670080001", planId: "weekly", requestKey: randomUUID().replaceAll("-", "") };
  const created = await call("/api/purchase", input), id = created.json.payment.id;
  const proof = { paymentId: id, requestKey: input.requestKey };
  return { store, call, input, id, proof, created,
    now: () => time, advance: (ms) => { time = new Date(+time + ms); },
    paid: () => call(`/api/payments/${id}/confirm`, {}),
    exchange: (data = proof) => call("/api/account/setup/checkout", data),
  };
}
const setupCookie = (result) => result.response.headers.getSetCookie().find((s) => s.startsWith("checkout_setup="))?.split(";")[0];
const pin = { checkoutSetup: true, pin: "2468", confirmPin: "2468" };

test("paid guest gets a separate ten-minute PIN grant without extending the request key", async (t) => {
  const f = await fixture(t);
  assert.equal(Date.parse(f.created.json.payment.guestAccessExpiresAt) - +f.now(), 300000);
  f.advance(299000); await f.paid();
  const exchange = await f.exchange(), cookie = setupCookie(exchange);
  assert.equal(exchange.response.status, 200);
  assert.equal(Date.parse(exchange.json.expiresAt) - +f.now(), 600000);
  assert.equal(exchange.json.phone, f.input.phone);
  assert.match(exchange.response.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  assert.match(exchange.response.headers.get("set-cookie"), /Path=\/api\/account\/setup/);
  assert.equal((await f.call("/api/purchase/recover", { requestKey: f.input.requestKey })).response.status, 404);
  f.advance(2000);
  assert.equal((await f.exchange()).response.status, 404, "expired purchase key cannot mint another grant");
  assert.equal((await f.call("/api/account/setup/checkout", undefined, cookie)).response.status, 200);
  assert.equal((await f.call("/api/account/dashboard", undefined, cookie)).response.status, 401, "setup proof is not an account session");
  const result = await f.call("/api/account/setup/pin", pin, cookie);
  assert.equal(result.response.status, 200);
  assert.ok(result.response.headers.getSetCookie().some((s) => s.startsWith("customer_session=")));
  assert.match(result.response.headers.getSetCookie().find((s) => s.startsWith("checkout_setup=")), /Max-Age=0/);
  assert.equal((await f.call("/api/account/setup/pin", pin, cookie)).response.status, 401);
  const state = await f.store.snapshot();
  assert.equal(state.vouchers.length, 1); assert.equal(state.payments[0].status, "paid");
  assert.ok(state.payments[0].guestSetup.usedAt);
});

test("exchange retries reproduce one cookie and deadline without persisting the token", async (t) => {
  const f = await fixture(t); await f.paid();
  const first = await f.exchange(); f.advance(10000);
  const retry = await f.exchange();
  assert.equal(setupCookie(first), setupCookie(retry));
  assert.equal(first.json.expiresAt, retry.json.expiresAt);
  assert.match(retry.response.headers.get("set-cookie"), /Max-Age=590/);
  const state = await f.store.snapshot();
  assert.ok(!JSON.stringify(state).includes(setupCookie(first).split(".")[1]));
  f.advance(590000);
  const expired = await f.call("/api/account/setup/checkout", undefined, setupCookie(first));
  assert.equal(expired.response.status, 401); assert.match(expired.json.error, /Do not pay again/);
  assert.equal((await f.call("/api/account/setup/pin", pin, setupCookie(first))).response.status, 401);
  assert.equal(state.payments[0].guestSetup.usedAt, undefined);
});

test("unpaid, missing, wrong-key, foreign and mismatching-account proofs cannot set a PIN", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.exchange()).response.status, 404);
  assert.equal((await f.store.snapshot()).payments[0].guestSetup, undefined);
  await f.paid();
  for (const data of [{}, { ...f.proof, paymentId: randomUUID() }, { ...f.proof, requestKey: "x".repeat(32) }])
    assert.equal((await f.exchange(data)).response.status, 404);
  const exchanged = await f.exchange(), cookie = setupCookie(exchanged);
  assert.equal((await f.call("/api/account/setup/pin", { ...pin, phone: "670080009" }, cookie)).response.status, 401);
  assert.equal((await f.call("/api/account/setup/pin", pin, cookie + "forged")).response.status, 401);
  assert.equal((await f.call("/api/account/setup/pin", pin)).response.status, 401);
  assert.equal((await f.store.snapshot()).customers[0].pinHash, undefined);
});

for (const [label, change] of [
  ["suspended account", (s) => { s.customers[0].status = "suspended"; }],
  ["review-held activation", (s) => { s.payments[0].fulfillmentStatus = "needs_review"; }],
  ["refunded payment", (s) => { s.payments[0].status = "refunded"; }],
  ["revoked voucher", (s) => { s.vouchers[0].status = "revoked"; }],
]) test(`PIN handoff refuses a ${label} before and after exchange`, async (t) => {
  const f = await fixture(t); await f.paid();
  const original = await f.store.snapshot();
  await f.store.transaction(change);
  assert.equal((await f.exchange()).response.status, 404);
  assert.equal((await f.store.snapshot()).payments[0].guestSetup, undefined);
  await f.store.transaction((s) => Object.assign(s, structuredClone(original)));
  const cookie = setupCookie(await f.exchange());
  await f.store.transaction(change);
  assert.equal((await f.call("/api/account/setup/pin", pin, cookie)).response.status, 401);
});

test("existing PIN accounts return to login and cannot be reset through a guest payment", async (t) => {
  const f = await fixture(t); const paid = await f.paid();
  const setup = await f.call("/api/account/setup/pin", { phone: f.input.phone, code: paid.json.access.code, pin: "2468", confirmPin: "2468" });
  assert.equal(setup.response.status, 200);
  const before = (await f.store.snapshot()).customers[0].pinHash;
  const exchanged = await f.exchange();
  assert.deepEqual(exchanged.json, { mode: "login" }); assert.equal(setupCookie(exchanged), undefined);
  assert.equal((await f.store.snapshot()).customers[0].pinHash, before);
});

test("a late confirmation retains payment and voucher history but cannot revive guest credentials", async (t) => {
  const f = await fixture(t); f.advance(300000); await f.paid();
  assert.equal((await f.exchange()).response.status, 404);
  assert.equal((await f.call("/api/purchase/recover", { requestKey: f.input.requestKey })).response.status, 404);
  const state = await f.store.snapshot();
  assert.equal(state.payments[0].status, "paid"); assert.equal(state.vouchers.length, 1);
});

test("an outstanding handoff survives customer secret rotation without sliding expiry", async (t) => {
  const f = await fixture(t); await f.paid();
  const state = await f.store.snapshot(), first = beginCheckoutSetup(state, f.proof, f.now(), "old-secret");
  f.advance(10000);
  const retry = beginCheckoutSetup(state, f.proof, f.now(), "new-secret", "old-secret");
  assert.equal(first.cookie, retry.cookie); assert.equal(first.body.expiresAt, retry.body.expiresAt);
  assert.ok(checkoutSetupFromCookie(state, first.cookie, f.now(), ["new-secret", "old-secret"]));
  assert.equal(checkoutSetupFromCookie(state, first.cookie, f.now(), ["new-secret"]), null);
});

test("reserved and legacy credential deadlines never inherit a longer financial polling window", () => {
  const p = { createdAt: "2030-01-01T08:00:00Z" }, at = Date.parse(p.createdAt);
  assert.equal(guestCheckoutDeadline(p), at + 300000);
  assert.equal(guestCheckoutDeadline({ ...p, creationState: "reserved" }), at + 300000);
  assert.equal(guestCheckoutDeadline({ ...p, paymentClosesAt: new Date(at + 90000).toISOString() }), at + 90000);
  assert.ok(Number.isNaN(guestCheckoutDeadline({})));
});
