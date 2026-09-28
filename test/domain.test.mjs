import test from "node:test";
import assert from "node:assert/strict";
import { blank } from "../lib/api/state.mjs";
import { redeemVoucher } from "../lib/domain/vouchers.mjs";
import { reservePurchase } from "../lib/domain/purchases.mjs";

// Core workflows exercised directly on state: no HTTP server, store or database.
// Security events are stamped with the wall clock, so the test clock follows it.
const now = new Date(),
  clock = () => new Date(now),
  requester = { ip: "10.0.0.8" },
  generic = "Invalid details.";

function stateWith({ voucher = {}, customer = true } = {}) {
  const s = blank();
  if (customer) s.customers.push({ id: "c1", phone: "670000001", name: "Ada", email: "ada@example.test" });
  s.vouchers.push({
    id: "v1", code: "NC-ABCD-2345", planId: "weekly", status: "active", customerId: "c1",
    deviceLimit: 1, quotaBytes: null, usedBytes: 0, ...voucher,
  });
  return s;
}
const redeem = (s, input) => redeemVoucher(s, { phone: "670000001", code: "ABCD-2345", ...input }, { clock, requester, generic });

test("redeeming an owned active voucher connects the device once", () => {
  const s = stateWith(), first = redeem(s, { deviceId: "phone" });
  assert.equal(first.status, 200);
  assert.equal(first.body.session.deviceId, "phone");
  assert.equal(first.routerCommandId, undefined);
  assert.equal(redeem(s, { deviceId: "phone" }).status, 200, "the same device reconnects");
  assert.equal(s.sessions.length, 1);
  const limited = redeem(s, { deviceId: "laptop" });
  assert.equal(limited.status, 409);
  assert.match(limited.body.error, /Device limit reached \(1\)/);
});

test("an available resale voucher is claimed, activated and queued for the router", () => {
  const s = stateWith({ voucher: { status: "available", customerId: undefined }, customer: false });
  const result = redeem(s, { phone: "+237 670 000 002", deviceId: "phone" });
  assert.equal(result.status, 200);
  const [customer] = s.customers;
  assert.equal(customer.phone, "670000002");
  assert.equal(s.vouchers[0].customerId, customer.id);
  assert.equal(s.vouchers[0].expiresAt, new Date(now.getTime() + 168 * 36e5).toISOString());
  assert.equal(s.routerCommands.find(({ id }) => id === result.routerCommandId).action, "sync_voucher");
});

test("wrong owners are rejected generically and repeated failures are throttled", () => {
  const s = stateWith();
  for (let i = 0; i < 20; i++) {
    const result = redeem(s, { phone: "670000009" });
    assert.deepEqual(result, { status: 401, body: { error: generic } });
  }
  assert.equal(s.securityEvents.filter(({ type, ip }) => type === "redeem.failed" && ip === "10.0.0.8").length, 20);
  assert.equal(redeem(s, {}).status, 429);
});

test("inactive vouchers are reported with their status", () => {
  assert.deepEqual(redeem(stateWith({ voucher: { status: "expired" } }), {}).body, { error: "This code is expired." });
});

const reserve = (s, input, options = {}) =>
  reservePurchase(s, { phone: "670000001", planId: "weekly", ...input }, { clock, provider: "mock", requester, ...options });

test("a new guest checkout creates the customer and reserves a pending payment", () => {
  const s = blank(), result = reserve(s, { name: "Grace", email: " Grace@Example.TEST ", requestKey: "k1" });
  assert.equal(result.status, 201);
  assert.equal(s.customers[0].email, "grace@example.test");
  assert.equal(s.payments[0], result.payment);
  assert.equal(result.payment.status, "pending");
  assert.equal(result.payment.creationState, "reserved");
  assert.equal(result.payment.action, "purchase");
  assert.equal(result.payment.clientIp, "10.0.0.8");
  assert.equal(s.events[0].type, "payment.reserved");
});

test("repeating a checkout request key is idempotent and cannot switch plans", () => {
  const s = blank(), first = reserve(s, { requestKey: "same" });
  const replay = reserve(s, { requestKey: "same" });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.payment.id, first.payment.id);
  assert.equal(reserve(s, { requestKey: "same", planId: "monthly" }).status, 409);
  assert.equal(s.payments.length, 1);
});

test("unresolved payments and active bundles block stacking", () => {
  const pending = blank();
  reserve(pending, {});
  assert.equal(reserve(pending, {}).body.code, "PAYMENT_IN_PROGRESS");
  const active = stateWith();
  assert.match(reserve(active, {}).body.error, /Bundles cannot be stacked/);
  assert.equal(reserve(active, { upgrade: true, planId: "daily" }).status, 400, "an upgrade must cost more");
});

test("account renewals and plan switches follow the latest voucher", () => {
  const s = stateWith({ voucher: { status: "expired" } }),
    account = (input) => reserve(s, input, { accountCustomerId: "c1" });
  assert.equal(account({ action: "upgrade" }).status, 400);
  assert.equal(account({ action: "renew", planId: "monthly" }).status, 409);
  assert.equal(account({ action: "switch", planId: "weekly" }).status, 409);
  const renewed = account({ action: "renew", planId: "weekly" });
  assert.equal(renewed.status, 201);
  assert.equal(renewed.payment.action, "renew");
  assert.equal(reserve(s, {}, { accountCustomerId: "missing" }).status, 401);
});

test("suspended customers and unavailable plans cannot check out", () => {
  const s = blank();
  s.customers.push({ id: "c1", phone: "670000001", suspended: true });
  assert.equal(reserve(s, {}).status, 403);
  assert.equal(reserve(blank(), { planId: "retired" }).status, 400);
});

test("MeSomb reservations expire after the configured window", () => {
  const result = reserve(blank(), { network: "mtn" }, { provider: "mesomb", pendingSeconds: 120 });
  assert.equal(result.payment.paymentExpiresAt, new Date(now.getTime() + 120_000).toISOString());
});
