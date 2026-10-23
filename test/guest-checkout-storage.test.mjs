import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";

// BILL-006: a guest's saved checkout key is the only thing left on the device, so it must
// recover a checkout on its own, return the contact details the portal no longer stores,
// and stop working once the guest can no longer need it.
async function fixture(t, { now, env = {} } = {}) {
  const store = createStore({ persistent: false });
  const server = createServer({ store, now, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock",
    OMADA_MODE: "not-configured", SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false", ADMIN_PIN: "9999", ...env,
  } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = "GET", data, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers },
      body: data ? JSON.stringify(data) : undefined });
    return { response, json: await response.json().catch(() => undefined) };
  };
  return { store, call };
}
const portalKey = () => randomUUID().replaceAll("-", "");
const guest = (extra = {}) => ({ phone: "670060001", name: "Saved Guest", email: "saved@example.test",
  planId: "weekly", network: "mtn", requestKey: portalKey(), ...extra });
const status = (f, id, key) => f.call(`/api/payments/${id}/status`, "GET", null, { "x-checkout-key": key });

test("BILL-006 the private key alone recovers a guest checkout and its contact details", async (t) => {
  const f = await fixture(t), input = guest();
  const created = await f.call("/api/purchase", "POST", input);
  assert.equal(created.response.status, 201);
  const recovered = await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey });
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.response.headers.get("cache-control"), "no-store");
  assert.equal(recovered.json.payment.id, created.json.payment.id);
  assert.deepEqual(recovered.json.details, { name: input.name, phone: input.phone, email: input.email, network: "mtn" });
  // Older portals still send the phone, which must match.
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey, phone: input.phone })).response.status, 200);
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey, phone: "670060009" })).response.status, 404);
  // Key-only lookups accept only full-strength portal keys.
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey: "short-guessable-key" })).response.status, 400);
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey: portalKey() })).response.status, 404);
  assert.equal((await f.store.snapshot()).payments.length, 1, "recovery never creates a payment");
});

test("BILL-006 a paid guest key stops disclosing the access code once this purchase's PIN is set", async (t) => {
  const f = await fixture(t), input = guest();
  const id = (await f.call("/api/purchase", "POST", input)).json.payment.id;
  const paid = await f.call(`/api/payments/${id}/confirm`, "POST");
  assert.equal(paid.response.status, 200);
  const before = await status(f, id, input.requestKey);
  assert.equal(before.response.status, 200);
  assert.match(before.json.access.code, /^NC-/);
  const setup = await f.call("/api/account/setup/pin", "POST", { phone: input.phone, code: before.json.access.code, pin: "2468", confirmPin: "2468" });
  assert.equal(setup.response.status, 200);
  const after = await status(f, id, input.requestKey);
  assert.equal(after.response.status, 404);
  assert.deepEqual(after.json, { error: "Payment not found." });
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey })).response.status, 404);
});

test("BILL-006 a paid guest key expires at the checkout deadline without PIN setup", async (t) => {
  let time = new Date("2026-10-19T08:00:00Z");
  const f = await fixture(t, { now: () => time }), input = guest();
  const id = (await f.call("/api/purchase", "POST", input)).json.payment.id;
  await f.call(`/api/payments/${id}/confirm`, "POST");
  time = new Date(+time + 299999);
  assert.equal((await status(f, id, input.requestKey)).response.status, 200);
  time = new Date(+time + 1);
  assert.equal((await status(f, id, input.requestKey)).response.status, 404);
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey })).response.status, 404);
});

test("BILL-006 an existing customer with a PIN still sees a guest purchase confirm", async (t) => {
  const f = await fixture(t), first = guest();
  const firstId = (await f.call("/api/purchase", "POST", first)).json.payment.id;
  const firstPaid = await f.call(`/api/payments/${firstId}/confirm`, "POST");
  await f.call("/api/account/setup/pin", "POST", { phone: first.phone, code: firstPaid.json.access.code, pin: "2468", confirmPin: "2468" });
  await f.store.transaction((s) => { s.vouchers.forEach((v) => { v.status = "expired"; }); });
  const again = guest({ phone: first.phone });
  const created = await f.call("/api/purchase", "POST", again);
  assert.equal(created.response.status, 201);
  await f.call(`/api/payments/${created.json.payment.id}/confirm`, "POST");
  const confirmed = await status(f, created.json.payment.id, again.requestKey);
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.json.payment.status, "paid");
});

test("BILL-006 an unpaid key expires with checkout rather than the financial polling window", async (t) => {
  let time = new Date("2026-10-19T08:00:00Z");
  const f = await fixture(t, { now: () => time }), input = guest();
  const id = (await f.call("/api/purchase", "POST", input)).json.payment.id;
  time = new Date(+time + 299999);
  assert.equal((await status(f, id, input.requestKey)).response.status, 200);
  time = new Date(+time + 1);
  assert.equal((await status(f, id, input.requestKey)).response.status, 404);
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey })).response.status, 404);
  assert.equal((await f.store.snapshot()).payments[0].status, "pending", "credential expiry does not invent a financial outcome");
});

// Privacy boundaries: a number and a guest checkout key do not prove ownership of
// the account already attached to that number.
test("guest recovery echoes only submitted details and never an existing account profile", async (t) => {
  const f = await fixture(t), input = guest({ name: "Checkout Supplied Name", email: "checkout-contact@example.test" });
  await f.store.transaction((s) => { s.customers.push({ id: "private-owner", phone: input.phone, name: "Private Profile Name", email: "private-profile@example.test", createdAt: "2026-01-01T00:00:00Z" }); });
  const created = await f.call("/api/purchase", "POST", input);
  assert.equal(created.response.status, 201);
  const recovered = await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey });
  assert.equal(recovered.response.status, 200);
  assert.deepEqual(recovered.json.details, { name: input.name, phone: input.phone, email: input.email, network: input.network });
  assert.ok(!JSON.stringify(recovered.json).includes("Private Profile Name"));
  assert.ok(!JSON.stringify(recovered.json).includes("private-profile@example.test"));
  const s = await f.store.snapshot(), customer = s.customers[0], payment = s.payments[0];
  assert.equal(customer.name, "Private Profile Name"); assert.equal(customer.email, "private-profile@example.test");
  assert.equal(payment.customerName, input.name); assert.equal(payment.email, input.email);
});

test("omitting guest contact fields does not fall back to an existing account's private name or email", async (t) => {
  const f = await fixture(t), input = guest({ name: "", email: "" });
  await f.store.transaction((s) => { s.customers.push({ id: "private-owner", phone: input.phone, name: "Private Profile Name", email: "private-profile@example.test" }); });
  assert.equal((await f.call("/api/purchase", "POST", input)).response.status, 201);
  const recovered = await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey });
  assert.deepEqual(recovered.json.details, { name: "", phone: input.phone, email: "", network: input.network });
  const payment = (await f.store.snapshot()).payments[0];
  assert.equal(payment.customerName, "Customer"); assert.equal(payment.email, "");
});

test("legacy recovery omits unproven contact details and does not disclose a later profile number", async (t) => {
  const f = await fixture(t), input = guest();
  const created = await f.call("/api/purchase", "POST", input);
  assert.equal(created.response.status, 201);
  await f.store.transaction((s) => {
    delete s.payments[0].guestCheckoutDetails; delete s.payments[0].checkoutAudience;
    s.payments[0].customerName = "Legacy Profile Name"; s.payments[0].email = "legacy-private@example.test";
    s.customers[0].phone = "670060009"; s.customers[0].email = "new-private@example.test";
  });
  const recovered = await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey, phone: input.phone });
  assert.equal(recovered.response.status, 200);
  assert.deepEqual(recovered.json.details, { name: "", phone: input.phone, email: "", network: input.network });
  for (const secret of ["Legacy Profile Name", "legacy-private@example.test", "new-private@example.test", "670060009"]) assert.ok(!JSON.stringify(recovered.json).includes(secret));
});

test("an authenticated checkout key cannot be used for anonymous recovery or status", async (t) => {
  const f = await fixture(t), input = guest();
  const first = (await f.call("/api/purchase", "POST", input)).json.payment.id;
  const paid = await f.call(`/api/payments/${first}/confirm`, "POST");
  const setup = await f.call("/api/account/setup/pin", "POST", { phone: input.phone, code: paid.json.access.code, pin: "2468", confirmPin: "2468" });
  const cookie = setup.response.headers.get("set-cookie").split(";")[0], requestKey = portalKey();
  const next = await f.call("/api/account/plan/purchase", "POST", { action: "renew", planId: "weekly", requestKey }, { cookie });
  assert.equal(next.response.status, 201);
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey })).response.status, 404);
  assert.equal((await status(f, next.json.payment.id, requestKey)).response.status, 404);
  assert.equal((await f.call(`/api/account/payments/${next.json.payment.id}/status`, "GET", null, { cookie })).response.status, 200);
});

test("paid guest key expires with its request regardless of the financial polling window", async (t) => {
  for (const hours of [1, 48]) {
    let time = new Date("2030-01-01T08:00:00Z");
    const f = await fixture(t, { now: () => time, env: { PAYMENT_LATE_CHECK_HOURS: String(hours) } }), input = guest();
    const id = (await f.call("/api/purchase", "POST", input)).json.payment.id;
    await f.call(`/api/payments/${id}/confirm`, "POST");
    time = new Date(+time + 299999);
    assert.equal((await status(f, id, input.requestKey)).response.status, 200);
    time = new Date(+time + 1);
    assert.equal((await status(f, id, input.requestKey)).response.status, 404);
    const unavailable = await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey });
    assert.equal(unavailable.response.status, 404);
    assert.match(unavailable.json.error, /unavailable or expired/);
    assert.ok(!/nothing was charged|no saved payment was submitted/i.test(unavailable.json.error));
    assert.equal((await f.store.snapshot()).payments[0].status, "paid");
  }
});

test("an unpaid guest key has a hard expiry even if no worker ever closes the checkout", async (t) => {
  let time = new Date("2030-01-01T08:00:00Z");
  const f = await fixture(t, { now: () => time, env: { PAYMENT_LATE_CHECK_HOURS: "48" } }), input = guest();
  const id = (await f.call("/api/purchase", "POST", input)).json.payment.id;
  time = new Date(+time + 300000);
  assert.equal((await status(f, id, input.requestKey)).response.status, 404);
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey })).response.status, 404);
  assert.equal((await f.store.snapshot()).payments[0].status, "pending", "access expiry alone does not invent a financial outcome");
});

test("a saved financial cutoff cannot be extended by a later polling configuration", async (t) => {
  let time = new Date("2030-01-01T08:00:00Z");
  const f = await fixture(t, { now: () => time, env: { PAYMENT_LATE_CHECK_HOURS: "48" } }), input = guest();
  const id = (await f.call("/api/purchase", "POST", input)).json.payment.id;
  await f.store.transaction((s) => {
    const p = s.payments.find((p) => p.id === id);
    p.status = "expired"; p.checkoutClosedAt = new Date(+time + 300000).toISOString();
    p.lateCheckUntil = new Date(+time + 12 * 3600000).toISOString();
  });
  time = new Date(+time + 13 * 3600000);
  assert.equal((await status(f, id, input.requestKey)).response.status, 404);
  assert.equal((await f.call("/api/purchase/recover", "POST", { requestKey: input.requestKey })).response.status, 404);
});
