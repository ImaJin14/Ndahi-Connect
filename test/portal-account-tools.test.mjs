import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import argon2 from "argon2";
import { createHandler, createStore } from "../server.mjs";
import { hashSecret, totpSecret, totpCode } from "../lib/security.mjs";
import { ensureReceipt } from "../lib/billing.mjs";
import { receiptView } from "../lib/receipt.mjs";
import { createStaticServer } from "../static-server.mjs";
import { reservePurchase } from "../lib/domain/purchases.mjs";

const secret = "portal-test-secret", origin = "http://customer.test";
const pinHash = await argon2.hash("2468");
async function fixture(t, { mfa = false } = {}) {
  let clock = new Date("2030-01-01T12:00:00Z");
  const store = createStore({ persistent: false }), key = totpSecret(), deliveries = [];
  await store.transaction((s) => {
    s.customers.push({ id: "c1", phone: "670050001", name: "Portal Customer", email: "owner@example.test", pinHash, ...(mfa ? { totpSecret: key } : {}) },
      { id: "c2", phone: "670050002", name: "Other Customer", pinHash });
    for (const [id, customerId] of [["current", "c1"], ["other-session", "c1"], ["outsider", "c2"]]) {
      s.dashboardSessions.push({ id, customerId, tokenHash: hashSecret(id, secret), csrfToken: "csrf", expiresAt: "2030-01-01T14:00:00Z" });
    }
    s.vouchers.push({ id: "active", customerId: "c1", code: "NC-AAAA-1111", status: "active", planId: "weekly", deviceLimit: 1,
      activatedAt: "2030-01-01T11:00:00Z", expiresAt: "2030-01-08T11:00:00Z", quotaBytes: 5e9, usedBytes: 100 },
    { id: "past", customerId: "c1", code: "NC-BBBB-2222", status: "expired", planId: "weekly", activatedAt: "2029-01-01T00:00:00Z", expiresAt: "2029-01-08T00:00:00Z", quotaBytes: 5e9, usedBytes: 5e9 },
    { id: "private", customerId: "c2", code: "NC-CCCC-3333", status: "expired", planId: "weekly", expiresAt: "2029-01-08T00:00:00Z", usedBytes: 0, quotaBytes: 5e9 });
    s.payments.push({ id: "original", customerId: "c1", planId: "weekly", payerPhone: "670050001", amount: 500, currency: "XAF", provider: "mock",
      status: "paid", confirmedAt: "2029-12-31T11:00:00Z", createdAt: "2029-12-31T10:59:00Z" });
    ensureReceipt(s.payments[0], s.bundles.find((p) => p.id === "weekly"));
  });
  const handler = createHandler({ store, now: () => clock, validateConfig: false,
    email: { configured: () => true, sendVerification: async (job) => { deliveries.push({ kind: "verification", ...job }); return { messageId: "test" }; },
      sendReceipt: async (job) => { deliveries.push({ kind: "receipt", ...job }); return { messageId: "receipt-test" }; },
      sendVoucher: async (job) => { deliveries.push({ kind: "voucher", ...job }); return { messageId: "voucher-test" }; },
      sendPinReset: async () => { deliveries.push({ kind: "reset" }); return { messageId: "reset-test" }; } }, payments: { mesomb: {
    createPayment: async (p) => ({ providerReference: `fixture-${p.id}`, authorizationMode: "mobile_money_prompt" }),
    verifyPayment: async (p) => ({ status: "paid", providerReference: `fixture-${p.id}`, transactionReference: p.id, amount: p.amount, currency: p.currency }),
  } }, env: {
    NODE_ENV: "production", PAYMENT_MODE: "mesomb", EMAIL_MODE: "mock", SESSION_COOKIE_SECURE: "false", CUSTOMER_SESSION_SECRET: secret, LOG_LEVEL: "warn",
    CUSTOMER_APP_URL: origin, SECRET_PEPPER: "pepper", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
    TRUST_PROXY: "render", COVERAGE_ACCESS_ENABLED: "true", COVERAGE_ALLOWED_IPS: "203.0.113.10",
  } });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  let cookie = "customer_session=current";
  const raw = async (path, { input, session, csrf = "csrf", address = "203.0.113.10" } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + path, { method: input === undefined ? "GET" : "POST",
      headers: { cookie: session === undefined ? cookie : session ? `customer_session=${session}` : "", origin, "x-csrf-token": csrf,
        "cf-connecting-ip": address, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (session === undefined && response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    return response;
  };
  const call = async (path, options) => { const response = await raw(path, options); return { status: response.status, body: await response.json() }; };
  return { store, call, raw, key, deliveries, advance: (seconds) => { clock = new Date(+clock + seconds * 1000); }, otp: () => totpCode(key, +clock) };
}

test("MeSomb signup and fulfillment work without email; unconfirmed addresses cannot receive account mail", async (t) => {
  const f = await fixture(t);
  for (const [phone, email] of [["670050010", ""], ["670050011", "new@example.test"]]) {
    const purchase = await f.call("/api/purchase", { session: "", input: { phone, email, network: "mtn", name: "New Customer", planId: "weekly", requestKey: phone } });
    assert.equal(purchase.status, 201);
    const paid = await f.raw(`/api/payments/${purchase.body.payment.id}/status`, { session: "" });
    assert.equal(paid.status, 404, "a private checkout key is still required");
    // The authenticated owner can check a live provider result after PIN setup.
    const c = (await f.store.snapshot()).customers.find((c) => c.phone === phone);
    await f.store.transaction((s) => {
      const customer = s.customers.find((x) => x.id === c.id); customer.pinHash = pinHash;
      s.dashboardSessions.push({ id: phone, customerId: c.id, tokenHash: hashSecret(phone, secret), csrfToken: "csrf", expiresAt: "2030-01-01T14:00:00Z" });
    });
    const status = await f.call(`/api/account/payments/${purchase.body.payment.id}/status`, { session: phone });
    assert.equal(status.status, 200); assert.equal(status.body.payment.status, "paid");
    assert.equal(status.body.payment.receiptEmail.status, "needs_email");
    const dashboard = await f.call("/api/account/dashboard", { session: phone, address: "198.51.100.9" });
    assert.equal(dashboard.body.customer.emailLinked, false);
    assert.ok(dashboard.body.vouchers[0].code);
    assert.equal((await f.call("/api/account/pin-reset/request", { session: "", input: { phone } })).status, 202);
  }
  assert.equal(f.deliveries.length, 0);
  assert.equal((await f.call("/api/purchase", { input: { phone: "670050012", email: "invalid", planId: "weekly" } })).status, 400);
});

test("Flutterwave requires a transaction contact email without linking it to an existing account", async (t) => {
  const f = await fixture(t), s = await f.store.snapshot();
  s.customers[0].email = "";
  const options = { clock: () => new Date("2030-01-01T12:00:00Z"), provider: "flutterwave", accountCustomerId: "c1", requester: {} };
  const input = { action: "renew", planId: "weekly", network: "mtn", requestKey: "flutterwave-email" };
  assert.equal(reservePurchase(s, input, options).body.code, "PAYMENT_EMAIL_REQUIRED");
  const outcome = reservePurchase(s, { ...input, email: "contact@example.test" }, options);
  assert.equal(outcome.status, 201);
  assert.equal(outcome.payment.email, "contact@example.test");
  assert.equal(s.customers[0].email, "");
});

test("email linking verifies fresh credentials and mailbox, keeps secrets private and rotates sessions", async (t) => {
  const f = await fixture(t, { mfa: true });
  const input = { email: " NEW@example.test ", pin: "2468" };
  assert.equal((await f.call("/api/account/profile/email", { csrf: "wrong", input })).status, 403);
  assert.equal((await f.call("/api/account/profile/email", { input })).status, 401);
  f.advance(2);
  const requested = await f.call("/api/account/profile/email", { input: { ...input, otp: f.otp() } });
  assert.equal(requested.status, 202); assert.equal(requested.body.email, "new@example.test");
  const delivered = f.deliveries.find((d) => d.kind === "verification");
  assert.match(delivered.code, /^\d{6}$/);
  assert.ok(!JSON.stringify(requested.body).includes(delivered.code));
  const dashboard = await f.call("/api/account/dashboard");
  assert.equal(dashboard.body.customer.email, "owner@example.test", "keep the old address until confirmation");
  assert.deepEqual(Object.keys(dashboard.body.customer.pendingEmail).sort(), ["email", "expiresAt", "status"]);
  const pending = (await f.store.snapshot()).customers[0].pendingEmail;
  assert.notEqual(pending.codeHash, delivered.code);
  assert.equal((await f.call("/api/account/profile/email/confirm", { session: "other-session", input: { code: delivered.code } })).status, 400);
  assert.equal((await f.call("/api/account/profile/email/confirm", { input: { code: "invalid" } })).status, 400);
  await f.store.transaction((s) => { s.pinResetChallenges.push({ customerId: "c1" }); s.customerAccessChallenges.push({ phone: "670050001" }); });
  assert.equal((await f.call("/api/account/profile/email/confirm", { input: { code: delivered.code } })).status, 200);
  const after = (await f.call("/api/account/dashboard")).body;
  assert.equal(after.customer.email, "new@example.test"); assert.equal(after.customer.emailLinked, true);
  assert.equal(after.customer.pendingEmail, null);
  assert.equal((await f.call("/api/account/dashboard", { session: "other-session" })).status, 401);
  assert.equal((await f.store.snapshot()).pinResetChallenges.length, 0);
  assert.equal((await f.store.snapshot()).customerAccessChallenges.length, 0);
  assert.equal((await f.call("/api/account/profile/email/confirm", { csrf: after.csrfToken, input: { code: delivered.code } })).status, 400);
  const receipt = await f.call("/api/account/payments/receipt-email", { csrf: after.csrfToken, input: { paymentId: "original" } });
  assert.equal(receipt.body.payment.receiptEmail.status, "sent");
  assert.equal(f.deliveries.find((d) => d.kind === "receipt").to, "new@example.test");
  assert.equal((await f.store.snapshot()).payments[0].payerPhone, "670050001");
});

test("email codes expire, are session-bound, rate-limited and stop after five incorrect guesses", async (t) => {
  const f = await fixture(t);
  const request = () => f.call("/api/account/profile/email", { input: { email: "new@example.test", pin: "2468" } });
  assert.equal((await request()).status, 202);
  assert.equal((await request()).status, 429);
  const first = f.deliveries[0].code;
  f.advance(601);
  assert.equal((await f.call("/api/account/profile/email/confirm", { input: { code: first } })).status, 400);
  assert.equal((await request()).status, 202);
  const next = f.deliveries.at(-1).code;
  for (let i = 0; i < 5; i++) assert.equal((await f.call("/api/account/profile/email/confirm", { input: { code: "invalid" } })).status, 400);
  assert.equal((await f.call("/api/account/profile/email/confirm", { input: { code: next } })).status, 400);
  assert.equal((await f.store.snapshot()).customers[0].email, "owner@example.test");
});

test("email passkey challenges cannot authorize a different email, session, or phone change", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.customers[0].passkeys = [{ id: "ZmFrZS1rZXk", publicKey: "unused", counter: 0 }]; });
  const options = await f.call("/api/account/profile/email/options", { input: { email: "new@example.test" } });
  assert.equal(options.status, 200);
  const ch = (await f.store.snapshot()).customerPasskeyChallenges.find((ch) => ch.id === options.body.challengeId);
  assert.equal(ch.type, "email_link"); assert.equal(ch.target, "new@example.test");
  assert.equal(ch.originalEmail, "owner@example.test"); assert.equal(ch.sessionId, "current");
  assert.equal((await f.call("/api/account/profile/email", { input: { email: "other@example.test", challengeId: ch.id, response: { id: "ZmFrZS1rZXk" } } })).status, 401);
  assert.equal(f.deliveries.length, 0);
});

test("owned current and expired voucher codes remain private and downloadable off-network", async (t) => {
  const f = await fixture(t), dashboard = await f.call("/api/account/dashboard", { address: "198.51.100.9" });
  assert.equal(dashboard.status, 200);
  assert.deepEqual(dashboard.body.vouchers.map((v) => v.code), ["NC-AAAA-1111", "NC-BBBB-2222"]);
  for (const id of ["active", "past"]) {
    const response = await f.raw(`/api/account/vouchers/${id}/download`, { address: "198.51.100.9" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-disposition"), /attachment; filename="ndahi-voucher-/);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  }
  assert.equal((await f.call("/api/account/vouchers/private/download")).status, 404);
  assert.equal((await f.call("/api/account/vouchers/active/download", { session: "outsider" })).status, 404);
  assert.equal((await f.call("/api/account/vouchers/active/download", { session: "" })).status, 401);
  assert.equal((await f.call("/api/account/plan/purchase", { address: "198.51.100.9", input: { action: "renew", planId: "weekly" } })).status, 403);
});

test("alternate payers belong to one transaction and never change subscription ownership or account defaults", async (t) => {
  const f = await fixture(t);
  const request = { action: "renew", planId: "weekly", payerPhone: "+237 670050002", network: "orange", requestKey: "alternate" };
  const created = await f.call("/api/account/plan/purchase", { input: request });
  assert.equal(created.status, 201);
  assert.equal(created.body.payment.payerPhone, "670050002");
  const replay = await f.call("/api/account/plan/purchase", { input: request });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.payment.id, created.body.payment.id);
  assert.equal((await f.call("/api/account/plan/purchase", { input: { ...request, payerPhone: "670050003" } })).status, 409);
  assert.equal((await f.call("/api/account/plan/purchase", { input: { ...request, network: "mtn" } })).status, 409);
  await f.call(`/api/account/payments/${created.body.payment.id}/status`);
  let s = await f.store.snapshot();
  const payment = s.payments.find((p) => p.id === created.body.payment.id), voucher = s.vouchers.find((v) => v.paymentId === payment.id);
  assert.equal(payment.customerId, "c1"); assert.equal(voucher.customerId, "c1");
  assert.equal(s.customers.find((c) => c.id === "c1").phone, "670050001");
  assert.equal(s.customers.length, 2);
  assert.equal(receiptView(payment.receipt).payerPhone, "670050002");
  const next = await f.call("/api/account/plan/purchase", { input: { action: "renew", planId: "weekly", network: "mtn", requestKey: "next" } });
  assert.equal(next.status, 201); assert.equal(next.body.payment.payerPhone, "670050001");
  s = await f.store.snapshot(); assert.equal(s.payments.length, 3);
});

test("invalid payer numbers are rejected before contacting a payment provider", async (t) => {
  const f = await fixture(t);
  for (const payerPhone of ["", "invalid", "1234"]) {
    assert.equal((await f.call("/api/account/plan/purchase", { input: { action: "renew", planId: "weekly", network: "mtn", payerPhone } })).status, 400);
  }
  assert.equal((await f.store.snapshot()).payments.length, 1);
});

test("phone changes require CSRF and fresh credentials, preserve history, and rotate portal sessions", async (t) => {
  const f = await fixture(t);
  const before = await f.store.snapshot();
  await f.store.transaction((s) => {
    for (const name of ["customerPasskeyChallenges", "customerMfaChallenges", "otpChallenges", "pinResetChallenges"]) s[name].push({ id: name, customerId: "c1", expiresAt: "2030-01-01T13:00:00Z" });
    s.customerAccessChallenges.push({ phone: "670050001", voucherId: "active", expiresAt: "2030-01-01T13:00:00Z" });
  });
  assert.equal((await f.call("/api/account/profile/phone", { csrf: "wrong", input: { phone: "670050003", pin: "2468" } })).status, 403);
  assert.equal((await f.call("/api/account/profile/phone", { session: "", input: { phone: "670050003", pin: "2468" } })).status, 401);
  assert.equal((await f.call("/api/account/profile/phone", { input: { phone: "invalid", pin: "2468" } })).status, 400);
  const failed = await f.call("/api/account/profile/phone", { input: { phone: "670050003", pin: "0000" } });
  assert.equal(failed.status, 401); assert.equal(failed.body.code, "VERIFICATION_FAILED");
  f.advance(2);
  assert.equal((await f.call("/api/account/profile/phone", { input: { phone: "670050003", pin: "2468" } })).status, 200);
  const after = await f.store.snapshot();
  assert.equal(after.customers.find((c) => c.id === "c1").phone, "670050003");
  assert.equal(after.customers.find((c) => c.id === "c1").phoneVerified, false);
  assert.deepEqual(after.vouchers, before.vouchers);
  assert.deepEqual(after.payments, before.payments);
  assert.equal(after.dashboardSessions.filter((s) => s.customerId === "c1").length, 1);
  assert.equal((await f.call("/api/account/dashboard", { session: "current" })).status, 401);
  assert.equal((await f.call("/api/account/dashboard", { session: "other-session" })).status, 401);
  assert.equal((await f.call("/api/account/dashboard")).body.customer.phone, "670050003");
  assert.ok(after.securityAlerts.some((a) => a.kind === "phone_changed" && a.customerId === "c1"));
  for (const name of ["customerPasskeyChallenges", "customerMfaChallenges", "otpChallenges", "pinResetChallenges", "customerAccessChallenges"]) assert.equal(after[name].length, 0);
  const csrf = (await f.call("/api/account/dashboard")).body.csrfToken;
  const next = await f.call("/api/account/plan/purchase", { csrf, input: { action: "renew", planId: "weekly", network: "mtn", requestKey: "after-change" } });
  assert.equal(next.status, 201);
  assert.equal(next.body.payment.payerPhone, "670050003");
  assert.equal((await f.store.snapshot()).payments.find((p) => p.id === "original").payerPhone, "670050001");
});

test("a phone number already attached to another customer cannot merge or transfer accounts", async (t) => {
  const f = await fixture(t);
  const before = await f.store.snapshot();
  assert.equal((await f.call("/api/account/profile/phone", { input: { phone: "670050002", pin: "2468" } })).status, 409);
  assert.deepEqual((await f.store.snapshot()).customers, before.customers);
  assert.equal((await f.store.snapshot()).dashboardSessions.length, 3);
});

test("phone changes enforce enrolled MFA in addition to a correct PIN", async (t) => {
  const f = await fixture(t, { mfa: true });
  assert.equal((await f.call("/api/account/profile/phone", { input: { phone: "670050003", pin: "2468" } })).status, 401);
  f.advance(2);
  assert.equal((await f.call("/api/account/profile/phone", { input: { phone: "670050003", pin: "2468", otp: f.otp() } })).status, 200);
});

test("failed phone-change verification is rate-limited without changing the account", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.call("/api/account/profile/phone", { input: { phone: "670050003", pin: "0000" } })).status, 401);
    f.advance(61);
  }
  assert.equal((await f.call("/api/account/profile/phone", { input: { phone: "670050003", pin: "2468" } })).status, 429);
  assert.equal((await f.store.snapshot()).customers[0].phone, "670050001");
});

test("phone-change passkey challenges are bound to the customer, session and proposed number", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { s.customers[0].passkeys = [{ id: "ZmFrZS1rZXk", publicKey: "unused", counter: 0, transports: ["internal"] }]; });
  const options = await f.call("/api/account/profile/phone/options", { input: { phone: "670050003" } });
  assert.equal(options.status, 200);
  const ch = (await f.store.snapshot()).customerPasskeyChallenges.find((ch) => ch.id === options.body.challengeId);
  assert.equal(ch.type, "phone_change"); assert.equal(ch.sessionId, "current"); assert.equal(ch.newPhone, "670050003");
  const input = { phone: "670050004", challengeId: ch.id, response: { id: "ZmFrZS1rZXk" } };
  assert.equal((await f.call("/api/account/profile/phone", { input })).status, 401);
  assert.equal((await f.store.snapshot()).customers[0].phone, "670050001");
});

test("the installed portal publishes a fresh release marker matching its no-store version endpoint", async (t) => {
  const server = createStaticServer("customer");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const version = await fetch(base + "/version.json"), release = await version.json();
  assert.equal(version.headers.get("cache-control"), "no-store");
  const response = await fetch(base + "/dashboard"), html = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.ok(html.includes(`name="ndahi-release" content="${release.revision}"`));
});

test("display-name changes require owner session and CSRF and preserve historical receipt names", async (t) => {
  const f = await fixture(t), before = (await f.store.snapshot()).payments;
  assert.equal((await f.call("/api/account/profile/name", { csrf: "wrong", input: { name: "Marie" } })).status, 403);
  assert.equal((await f.call("/api/account/profile/name", { session: "", input: { name: "Marie" } })).status, 401);
  for (const name of ["", "x".repeat(101), "bad\u0000name"]) assert.equal((await f.call("/api/account/profile/name", { input: { name } })).status, 400);
  assert.equal((await f.call("/api/account/profile/name", { input: { name: "  Marie   Ndongo " } })).status, 200);
  assert.equal((await f.call("/api/account/dashboard")).body.customer.name, "Marie Ndongo");
  assert.deepEqual((await f.store.snapshot()).payments, before);
});

test("dashboard reads expire only the owner's overdue checkouts without any worker or provider request", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    for (const customerId of ["c1", "c2"]) s.payments.push({ id: `overdue-${customerId}`, customerId, planId: "weekly", status: "pending", provider: "mesomb",
      createdAt: "2030-01-01T11:00:00Z", paymentExpiresAt: "2030-01-01T11:05:00Z", amount: 500, currency: "XAF" });
  });
  const dashboard = await f.call("/api/account/dashboard");
  const payment = dashboard.body.payments.find((p) => p.id === "overdue-c1");
  assert.equal(payment.status, "expired"); assert.ok(payment.checkoutClosedAt);
  assert.equal(payment.serverTime, "2030-01-01T12:00:00.000Z");
  assert.equal(payment.paymentClosesAt, "2030-01-01T11:05:00.000Z");
  assert.equal((await f.store.snapshot()).payments.find((p) => p.id === "overdue-c2").status, "pending");
  assert.ok(!dashboard.body.payments.some((p) => p.id === "overdue-c2"));
});
