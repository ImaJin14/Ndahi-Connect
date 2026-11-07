import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { MockPaymentAdapter } from "../lib/payments.mjs";

const original = { phone: "670180001", name: "Imajin", email: "imajin@example.test", planId: "weekly", network: "mtn" };
async function fixture(t, { paid: shouldPay = true } = {}) {
  const store = createStore({ persistent: false }), adapter = new MockPaymentAdapter();
  let charges = 0;
  const create = adapter.createPayment.bind(adapter);
  adapter.createPayment = async (...args) => { charges++; return create(...args); };
  const server = createServer({ store, payments: { mock: adapter }, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock",
    OMADA_MODE: "not-configured", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
    SESSION_COOKIE_SECURE: "false", CUSTOMER_SESSION_SECRET: "account-identity-test", ADMIN_PIN: "9999",
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const call = async (path, input, cookie = "") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: input === undefined ? "GET" : "POST", headers: { "content-type": "application/json", cookie },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie().find((s) => s.startsWith("customer_session="))?.split(";")[0] };
  };
  const input = { ...original, requestKey: randomUUID().replaceAll("-", "") };
  const first = await call("/api/purchase", input);
  assert.equal(first.status, 201);
  const paid = shouldPay ? await call(`/api/payments/${first.body.payment.id}/confirm`, {}) : null;
  if (shouldPay) assert.equal(paid.status, 200);
  return { store, call, input, first, paid, charges: () => charges,
    setup: () => call("/api/account/setup/pin", { phone: original.phone, code: paid.body.access.code, pin: "2468", confirmPin: "2468" }),
    expire: () => store.transaction((s) => { s.vouchers.forEach((v) => { v.status = "expired"; }); }),
  };
}
const conflicting = (phone = original.phone) => ({ ...original, phone, name: "Different Name", email: "different@example.test", requestKey: randomUUID() });

test("active bundle lookup ignores conflicting name/email and normalizes phone before any second charge", async (t) => {
  const f = await fixture(t); await f.setup();
  const before = await f.store.snapshot();
  for (const phone of [original.phone, "+237 (670) 180-001", "237670180001"]) {
    const blocked = await f.call("/api/purchase", conflicting(phone));
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, "ACTIVE_BUNDLE_EXISTS");
    assert.deepEqual(Object.keys(blocked.body).sort(), ["code", "error"]);
    assert.ok(!JSON.stringify(blocked.body).includes(original.email));
  }
  const state = await f.store.snapshot();
  assert.equal(f.charges(), 1); assert.deepEqual(state.customers, before.customers);
  assert.deepEqual(state.vouchers, before.vouchers); assert.deepEqual(state.payments, before.payments);
});

test("repeat signup after expiry requires the original account and concurrent requests cannot create duplicates", async (t) => {
  const f = await fixture(t); await f.setup(); await f.expire();
  const before = await f.store.snapshot();
  const results = await Promise.all([original.phone, "+237670180001", "670 180 001"].map((phone) => f.call("/api/purchase", conflicting(phone))));
  for (const result of results) {
    assert.equal(result.status, 409); assert.equal(result.body.code, "ACCOUNT_SIGN_IN_REQUIRED");
    assert.deepEqual(Object.keys(result.body).sort(), ["code", "error"]);
    for (const secret of [original.name, original.email, before.customers[0].id]) assert.ok(!JSON.stringify(result.body).includes(secret));
  }
  const state = await f.store.snapshot();
  assert.equal(f.charges(), 1); assert.deepEqual(state.customers, before.customers);
  assert.deepEqual(state.payments, before.payments); assert.deepEqual(state.vouchers, before.vouchers);
  const login = await f.call("/api/account/login/pin", { phone: original.phone, pin: "2468" });
  assert.equal(login.status, 200);
  const dashboard = await f.call("/api/account/dashboard", undefined, login.cookie);
  assert.equal(dashboard.body.customer.name, original.name); assert.equal(dashboard.body.customer.email, original.email);
  assert.equal(dashboard.body.payments.length, 1);
});

test("paid signup without a PIN requires recovery while its original checkout remains recoverable", async (t) => {
  const f = await fixture(t); await f.expire();
  const rejected = await f.call("/api/purchase", conflicting());
  assert.equal(rejected.body.code, "ACCOUNT_SIGN_IN_REQUIRED");
  const retry = await f.call("/api/purchase", { ...conflicting(), requestKey: f.input.requestKey });
  assert.equal(retry.status, 200); assert.equal(retry.body.payment.id, f.first.body.payment.id);
  const recovered = await f.call("/api/purchase/recover", { requestKey: f.input.requestKey });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.details.name, original.name);
  assert.equal(recovered.body.details.email, original.email);
  assert.equal(f.charges(), 1); assert.equal((await f.store.snapshot()).customers.length, 1);
  assert.equal((await f.setup()).status, 200, "original voucher still permits PIN setup");
});

test("authenticated purchase keeps the original profile when using another account's payment number", async (t) => {
  const f = await fixture(t), owner = await f.setup(); await f.expire();
  const other = { id: "payer-only", phone: "670180002", name: "Other Owner", email: "payer@example.test", pinHash: "existing" };
  await f.store.transaction((s) => { s.customers.push(other); });
  const purchase = await f.call("/api/account/plan/purchase", {
    action: "renew", planId: "weekly", payerPhone: "+237670180002", name: "Different Name", email: "different@example.test", requestKey: randomUUID(),
  }, owner.cookie);
  assert.equal(purchase.status, 201);
  const state = await f.store.snapshot(), payment = state.payments[0], customer = state.customers.find((c) => c.phone === original.phone);
  assert.equal(state.customers.length, 2); assert.equal(payment.customerId, customer.id);
  assert.equal(payment.customerName, original.name); assert.equal(payment.email, original.email);
  assert.equal(payment.payerPhone, other.phone); assert.equal(customer.phone, original.phone);
  assert.equal(customer.name, original.name); assert.equal(customer.email, original.email);
  assert.deepEqual(state.customers.find((c) => c.id === other.id), other);
  assert.equal(payment.checkoutAudience, "account"); assert.equal(payment.guestCheckoutDetails, undefined);
  const paid = await f.call(`/api/payments/${payment.id}/confirm`, {});
  assert.equal(paid.status, 200);
  assert.equal((await f.call("/api/account/dashboard", undefined, owner.cookie)).body.activeBundle.id, paid.body.voucher.id);
  assert.equal((await f.store.snapshot()).vouchers[0].customerId, customer.id);
});

test("an abandoned unpaid attempt does not lock the number out of signup", async (t) => {
  const f = await fixture(t, { paid: false });
  await f.store.transaction((s) => { s.payments[0].status = "failed"; });
  const created = await f.call("/api/purchase", conflicting());
  assert.equal(created.status, 201);
  const state = await f.store.snapshot();
  assert.equal(state.customers.length, 1); assert.equal(state.customers[0].name, original.name);
  assert.equal(state.customers[0].email, original.email);
});
