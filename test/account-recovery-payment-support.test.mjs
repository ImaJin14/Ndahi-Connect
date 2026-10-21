import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { createServer, createStore } from "../server.mjs";
import { hashSecret, totpSecret, totpCode } from "../lib/security.mjs";
import { createPaymentReconciler } from "../lib/payment-reconciliation.mjs";
import { createSecurityAlertService } from "../lib/security-alerts.mjs";

const secret = "customer-test-secret", adminSecret = "admin-test-secret", pepper = "test-pepper";

async function fixture(t, { payments, email, now = () => clock, store = createStore({ persistent: false }), env = {} } = {}) {
  let clock = new Date("2030-01-01T12:00:00Z");
  const server = createServer({
    store, email, payments, now: () => clock,
    env: {
      NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock",
      OMADA_MODE: "not-configured", SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false",
      ADMIN_PIN: "9999", SECRET_PEPPER: pepper, CUSTOMER_SESSION_SECRET: secret,
      ADMIN_SESSION_SECRET: adminSecret, CUSTOMER_APP_URL: "http://customer.test",
      ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test",
      ...env,
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, jar = {};
  const call = async (path, method = "GET", data, { cookie, headers = {} } = {}) => {
    const currentCookie = cookie !== undefined ? cookie : Object.values(jar).join("; ");
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        origin: path.startsWith("/api/admin") ? "http://admin.test" : "http://customer.test",
        ...(currentCookie ? { cookie: currentCookie } : {}),
        ...headers,
      },
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    const set = response.headers.get("set-cookie");
    if (set) {
      for (const item of set.split(/,(?=[a-zA-Z0-9_-]+=)/)) {
        const pair = item.trim().split(";")[0];
        jar[pair.split("=")[0]] = pair;
      }
    }
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { response, json, text };
  };
  return {
    store, call, jar, base,
    advance: (seconds) => { clock = new Date(+clock + seconds * 1000); },
    getClock: () => clock,
  };
}

async function createCustomerAccount(f, { phone = "670010001", pin = "2468", name = "Test User", email = "user@example.test" } = {}) {
  const purchase = await f.call("/api/purchase", "POST", { phone, name, email, planId: "weekly" });
  assert.equal(purchase.response.status, 201);
  const paid = await f.call(`/api/payments/${purchase.json.payment.id}/confirm`, "POST");
  assert.equal(paid.response.status, 200);
  const setup = await f.call("/api/account/setup/pin", "POST", { phone, code: paid.json.access.code, pin, confirmPin: pin });
  assert.equal(setup.response.status, 200);
  const state = await f.store.snapshot();
  const customer = state.customers.find((c) => c.phone === phone);
  return { phone, pin, customerId: customer.id, customer };
}

test("AUTH-RECOVERY: generating account backup codes returns 5 codes, stores hashes only, throttles cooldown, and notifies", async (t) => {
  const f = await fixture(t);
  const { customerId } = await createCustomerAccount(f);
  const dashboardBefore = await f.call("/api/account/dashboard");
  const csrf = dashboardBefore.json.csrfToken;

  const generated = await f.call("/api/account/security/account-backup/generate", "POST", { currentPin: "2468" }, { headers: { "x-csrf-token": csrf } });
  assert.equal(generated.response.status, 200);
  assert.equal(generated.response.headers.get("cache-control"), "no-store");
  assert.equal(generated.json.codes.length, 5);
  assert.ok(generated.json.codes.every((code) => /^NC-REC-[a-zA-Z0-9_-]+$/.test(code)));

  const state = await f.store.snapshot();
  const customer = state.customers.find((c) => c.id === customerId);
  assert.equal(customer.accountBackupCodes.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.ok(customer.accountBackupCodes[i].hash.startsWith("$argon2id$"));
    assert.notEqual(customer.accountBackupCodes[i].hash, generated.json.codes[i]);
    assert.equal(await argon2.verify(customer.accountBackupCodes[i].hash, generated.json.codes[i]), true);
  }

  // Dashboard masks the hashes and reports remaining count
  const dashboard = await f.call("/api/account/dashboard");
  assert.equal(dashboard.json.customer.accountBackupCodesRemaining, 5);
  assert.equal(dashboard.json.customer.accountBackupCodes, undefined);
  assert.ok(dashboard.json.securityNotices.some((n) => n.subject.includes("account backup codes changed")));

  // Cooldown limit (1 minute)
  const tooSoon = await f.call("/api/account/security/account-backup/generate", "POST", { currentPin: "2468" }, { headers: { "x-csrf-token": csrf } });
  assert.equal(tooSoon.response.status, 429);
  assert.match(tooSoon.json.error, /wait one minute/i);
});

test("AUTH-RECOVERY: changing PIN in-app verifies current PIN, revokes previous sessions and backup codes, and sets new session", async (t) => {
  const f = await fixture(t);
  const { phone } = await createCustomerAccount(f);
  const dashboardBefore = await f.call("/api/account/dashboard");
  const csrf = dashboardBefore.json.csrfToken;
  await f.call("/api/account/security/account-backup/generate", "POST", { currentPin: "2468" }, { headers: { "x-csrf-token": csrf } });

  // Mismatched confirm PIN
  const mismatch = await f.call("/api/account/security/pin", "POST", { currentPin: "2468", newPin: "9999", confirmPin: "8888" }, { headers: { "x-csrf-token": csrf } });
  assert.equal(mismatch.response.status, 400);

  // Wrong current PIN
  const wrongPin = await f.call("/api/account/security/pin", "POST", { currentPin: "0000", newPin: "9999", confirmPin: "9999" }, { headers: { "x-csrf-token": csrf } });
  assert.equal(wrongPin.response.status, 401);
  assert.equal(wrongPin.json.code, "VERIFICATION_FAILED");

  // Successful PIN change (advance past pin failure delay)
  f.advance(2);
  const success = await f.call("/api/account/security/pin", "POST", { currentPin: "2468", newPin: "9999", confirmPin: "9999" }, { headers: { "x-csrf-token": csrf } });
  assert.equal(success.response.status, 200);
  assert.equal(success.json.authenticated, true);

  // Old backup codes revoked
  const state = await f.store.snapshot();
  const customer = state.customers.find((c) => c.phone === phone);
  assert.equal(customer.accountBackupCodes, undefined);

  // Old PIN no longer works, new PIN works
  delete f.jar.customer_session;
  const oldLogin = await f.call("/api/account/login/pin", "POST", { phone, pin: "2468" });
  assert.equal(oldLogin.response.status, 401);

  f.advance(2);
  const newLogin = await f.call("/api/account/login/pin", "POST", { phone, pin: "9999" });
  assert.equal(newLogin.response.status, 200);
});

test("AUTH-RECOVERY: reset PIN with backup code resets PIN, invalidates previous codes and sessions, and enforces rate limits", async (t) => {
  const f = await fixture(t);
  const { phone, customerId } = await createCustomerAccount(f);
  const dashboard = await f.call("/api/account/dashboard");
  const generated = await f.call("/api/account/security/account-backup/generate", "POST", { currentPin: "2468" }, { headers: { "x-csrf-token": dashboard.json.csrfToken } });
  const backupCode = generated.json.codes[0];

  // Invalid backup code fails with 401
  const invalid = await f.call("/api/account/pin-reset/backup", "POST", { phone, backupCode: "NC-REC-invalidcode", newPin: "5555", confirmPin: "5555" });
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.json.code, "VERIFICATION_FAILED");

  // Successful backup code recovery
  const recovered = await f.call("/api/account/pin-reset/backup", "POST", { phone, backupCode, newPin: "5555", confirmPin: "5555" });
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.json.reset, true);

  // State checks: all backup codes revoked, previous sessions revoked
  const state = await f.store.snapshot();
  const customer = state.customers.find((c) => c.id === customerId);
  assert.equal(customer.accountBackupCodes, undefined);
  assert.equal(state.dashboardSessions.filter((s) => s.customerId === customerId).length, 0);

  // Can login with new PIN
  delete f.jar.customer_session;
  const login = await f.call("/api/account/login/pin", "POST", { phone, pin: "5555" });
  assert.equal(login.response.status, 200);

  // The used backup code (and any code from that set) cannot be used again
  const reuse = await f.call("/api/account/pin-reset/backup", "POST", { phone, backupCode, newPin: "1111", confirmPin: "1111" });
  assert.equal(reuse.response.status, 401);
});

test("AUTH-RECOVERY: owner customer support recovery approves time-limited token, revokes customer sessions, and enables PIN reset", async (t) => {
  const f = await fixture(t);
  const { phone, customerId } = await createCustomerAccount(f);

  // Non-owner gets 403
  await f.call("/api/admin/login", "POST", { pin: "9999" });
  const ownerSession = f.jar.admin_session;
  const operatorUser = await f.call("/api/admin/users", "POST", { username: "support-op", role: "operator", password: "operator-pass-123" });
  assert.equal(operatorUser.response.status, 201);
  const opLogin = await f.call("/api/admin/login", "POST", { username: "support-op", password: "operator-pass-123" });
  assert.equal(opLogin.response.status, 200);

  const opDenied = await f.call("/api/admin/customers/recovery", "POST", {
    customerId, caseReference: "CASE-1234", reason: "Verified customer in person at desk",
    verificationMethod: "in_person", confirmedIdentity: true, password: "operator-pass-123",
  });
  assert.equal(opDenied.response.status, 403);

  // Owner approval with validation
  const ownerApproved = await f.call("/api/admin/customers/recovery", "POST", {
    customerId, caseReference: "CASE-1234", reason: "Customer presented national ID card in person",
    verificationMethod: "in_person", confirmedIdentity: true, password: "9999",
  }, { cookie: ownerSession });
  assert.equal(ownerApproved.response.status, 200);
  assert.equal(ownerApproved.response.headers.get("cache-control"), "no-store");
  assert.ok(ownerApproved.json.recoveryCode);
  const recoveryCode = ownerApproved.json.recoveryCode;

  // Rate-limiting check (cooldown within 60s)
  const tooSoon = await f.call("/api/admin/customers/recovery", "POST", {
    customerId, caseReference: "CASE-1234", reason: "Customer presented national ID card in person",
    verificationMethod: "in_person", confirmedIdentity: true, password: "9999",
  }, { cookie: ownerSession });
  assert.equal(tooSoon.response.status, 429);

  // Customer credentials and sessions were revoked
  const state = await f.store.snapshot();
  assert.equal(state.dashboardSessions.filter((s) => s.customerId === customerId).length, 0);
  assert.ok(state.auditLogs.some((a) => a.action === "customer.support_recovery.approved" && a.meta.caseReference === "CASE-1234"));

  // Customer uses support recovery code on /forgot-pin
  const resetResponse = await f.call("/api/account/pin-reset/confirm", "POST", {
    token: recoveryCode, pin: "7777", confirmPin: "7777",
  });
  assert.equal(resetResponse.response.status, 200);
  assert.equal(resetResponse.json.reset, true);

  // Customer signs in with new PIN
  delete f.jar.customer_session;
  const login = await f.call("/api/account/login/pin", "POST", { phone, pin: "7777" });
  assert.equal(login.response.status, 200);
});

test("SECURITY-ALERT: replacing linked email sends alert to previousEmail", async (t) => {
  const deliveredAlerts = [];
  let verificationCode;
  const emailMock = {
    configured: () => true,
    async sendVerification({ code }) { verificationCode = code; return { messageId: "verify-1" }; },
    async sendSecurityAlert(msg) { deliveredAlerts.push(msg); return { messageId: "alert-1" }; },
  };
  const f = await fixture(t, { email: emailMock });
  const { customerId } = await createCustomerAccount(f, { email: "initial@example.test" });
  await f.store.transaction((s) => { s.customers.find((c) => c.id === customerId).emailVerifiedAt = "2030-01-01T12:00:00Z"; });
  const dashboard = await f.call("/api/account/dashboard");
  const csrf = dashboard.json.csrfToken;

  // Request new email link
  const reqEmail = await f.call("/api/account/profile/email", "POST", { email: "replaced@example.test", pin: "2468" }, { headers: { "x-csrf-token": csrf } });
  assert.equal(reqEmail.response.status, 202);

  const state1 = await f.store.snapshot();
  const pending = state1.customers.find((c) => c.id === customerId).pendingEmail;
  assert.ok(pending);

  // Use the code actually delivered, including codes with a leading zero.
  assert.match(verificationCode, /^\d{6}$/);
  assert.equal(hashSecret(verificationCode, pepper), pending.codeHash);

  const confirm = await f.call("/api/account/profile/email/confirm", "POST", { code: verificationCode }, { headers: { "x-csrf-token": csrf } });
  assert.equal(confirm.response.status, 200);

  // Security alert queued with recipient = initial@example.test
  const state2 = await f.store.snapshot();
  const alert = state2.securityAlerts.find((a) => a.kind === "email_replaced");
  assert.ok(alert);
  assert.equal(alert.recipient, "initial@example.test");

  // Alert worker delivers to that specific recipient
  const alertService = createSecurityAlertService({ store: f.store, email: emailMock, now: f.getClock });
  await alertService.run();
  assert.equal(deliveredAlerts.filter((a) => ["email_replaced", "email_linked"].includes(a.alert.kind)).length, 2);
  const replacedAlert = deliveredAlerts.find((a) => a.alert.kind === "email_replaced");
  assert.ok(replacedAlert);
  assert.equal(replacedAlert.to, "initial@example.test");
  assert.match(replacedAlert.alert.subject, /email changed/i);
  const linkedAlert = deliveredAlerts.find((a) => a.alert.kind === "email_linked");
  assert.ok(linkedAlert);
  assert.equal(linkedAlert.to, "replaced@example.test");
});

test("BILL-SUPPORT: admin can verify unconfirmed provider payments past late-check cutoff, rate-limited and audited", async (t) => {
  let verifyCalls = 0;
  const paymentsMock = {
    mesomb: {
      async verifyPayment(p) {
        verifyCalls++;
        return { status: "paid", providerReference: "prov-ref-123", transactionReference: p.id, amount: p.amount, currency: p.currency };
      },
    },
  };
  const f = await fixture(t, { payments: paymentsMock });
  await f.call("/api/admin/login", "POST", { pin: "9999" });

  const paymentId = "p-unconfirmed-1";
  const past = new Date(+f.getClock() - 3 * 86400 * 1000).toISOString();
  const pastCheckUntil = new Date(+f.getClock() - 2 * 86400 * 1000).toISOString();
  await f.store.transaction((s) => {
    s.customers.push({ id: "cust-1", phone: "670099001", name: "Late Customer" });
    s.payments.push({
      id: paymentId, customerId: "cust-1", planId: "weekly", amount: 500, currency: "XAF",
      provider: "mesomb", status: "expired", createdAt: past,
      checkoutClosedAt: past, lateCheckUntil: pastCheckUntil,
      creationState: "accepted",
    });
  });

  // Admin initiates support payment verification
  const check1 = await f.call("/api/admin/payments/verify", "POST", { paymentId });
  assert.equal(check1.response.status, 200);
  assert.equal(verifyCalls, 1);
  assert.equal(check1.json.payment.status, "paid");

  // Calling again immediately is throttled (outcome: "busy")
  const check2 = await f.call("/api/admin/payments/verify", "POST", { paymentId });
  // The payment is now confirmed, so preflight rejects confirmed payments
  assert.equal(check2.response.status, 409);

  // Check audit events
  const state = await f.store.snapshot();
  assert.ok(state.auditLogs.some((a) => a.action === "payment.support_verification.requested" && a.meta.paymentId === paymentId));
  assert.ok(state.auditLogs.some((a) => a.action === "payment.support_verification.completed" && a.meta.paymentId === paymentId));
});

test("BILL-SUPPORT: reconciler classifies expired and cancelled payments paid at provider as settlement_missing", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.payments.push(
      { id: "p-exp", provider: "mesomb", providerReference: "ref-exp", amount: 500, currency: "XAF", status: "expired", createdAt: "2030-01-01T00:00:00Z" },
      { id: "p-can", provider: "mesomb", providerReference: "ref-can", amount: 500, currency: "XAF", status: "cancelled", createdAt: "2030-01-01T00:00:00Z" },
    );
  });
  const reconciler = createPaymentReconciler({
    store,
    payments: {
      mesomb: {
        async verifyPayment(p) {
          return { status: "paid", providerReference: p.providerReference, transactionReference: p.id, amount: p.amount, currency: p.currency };
        },
      },
    },
    now: () => new Date("2030-01-01T12:00:00Z"),
  });
  const result = await reconciler();
  assert.equal(result.checked, 2);

  const state = await store.snapshot();
  for (const p of state.payments) {
    assert.ok(p.reconciliation.issues.includes("settlement_missing"), `payment ${p.id} should have settlement_missing`);
    assert.ok(!p.reconciliation.issues.includes("payment_status_mismatch"), `payment ${p.id} should not have payment_status_mismatch`);
  }
});
