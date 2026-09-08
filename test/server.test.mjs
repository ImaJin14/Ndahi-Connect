import test from "node:test";
import assert from "node:assert/strict";
import { authEdgeScopes, createServer, createStore, customerCsrfPaths, ensureState, plans, resolveClientIp } from "../server.mjs";
import { totpCode, totpSecret, totpUri, verifyTotp } from "../lib/security.mjs";
test("public Wi-Fi catalogue is complete", () => {
  assert.deepEqual(plans.map((p) => p.price), [
    100,
    500,
    2000,
    5500,
    10000,
    12500,
    15000,
    30000,
  ]);
  assert.equal(plans.find((p) => p.id === "connect30").quotaGb, 30);
  assert.equal(plans.find((p) => p.id === "connect75").quotaGb, 75);
});
test("daily is one device and other plans have their intended limits", () => {
  assert.equal(plans.find((p) => p.id === "daily").deviceLimit, 1);
  assert.equal(plans.find((p) => p.id === "connect30").deviceLimit, 2);
  assert.equal(plans.find((p) => p.id === "family").deviceLimit, 3);
  assert.equal(plans.find((p) => p.id === "max").deviceLimit, 4);
  assert.equal(plans.find((p) => p.id === "unlimited").deviceLimit, 6);
});
test("all plans use direct hotspot voucher access", () => {
  assert.ok(plans.every((p) => !p.accessMode || p.accessMode === "hotspot"));
});
test("client IP resolution trusts only Render's protected client header", () => {
  const req = {
    headers: {
      "x-forwarded-for": "198.51.100.7, 10.0.0.1",
      "cf-connecting-ip": "203.0.113.9",
    },
    socket: { remoteAddress: "::ffff:127.0.0.1" },
  };
  assert.equal(resolveClientIp(req, {}), "127.0.0.1");
  assert.equal(resolveClientIp(req, { TRUST_PROXY: "render" }), "203.0.113.9");
  req.headers["cf-connecting-ip"] = "not-an-ip";
  assert.equal(resolveClientIp(req, { TRUST_PROXY: "render" }), "127.0.0.1");
});
test("edge limits cover every unauthenticated authentication flow", () => {
  assert.deepEqual(new Set(Object.values(authEdgeScopes)), new Set([
    "customer-auth", "pin-reset", "admin-auth",
  ]));
  for (const path of [
    "/api/vouchers/redeem",
    "/api/account/access/begin",
    "/api/account/access/complete",
    "/api/account/setup/pin",
    "/api/account/login/pin",
    "/api/account/login/request-authenticator",
    "/api/account/login/verify-authenticator",
    "/api/account/passkey/options",
    "/api/account/passkey/verify",
    "/api/account/pin-reset/request",
    "/api/account/pin-reset/confirm",
    "/api/admin/login",
    "/api/admin/login/mfa",
    "/api/admin/passkey/options",
    "/api/admin/passkey/verify",
  ]) assert.ok(authEdgeScopes[path], `${path} must be edge-limited`);
});
test("customer CSRF inventory covers every session-authorized mutation", () => {
  assert.deepEqual(Object.keys(customerCsrfPaths).sort(), [
    "/api/account/devices/disconnect",
    "/api/account/logout",
    "/api/account/passkeys/options",
    "/api/account/passkeys/verify",
    "/api/account/plan/purchase",
    "/api/account/security/mfa/confirm",
    "/api/account/security/mfa/enroll",
  ]);
});
test("legacy persisted state gains passkey challenge collections", () => {
  const state = {};
  ensureState(state);
  assert.deepEqual(state.customerPasskeyChallenges, []);
  assert.deepEqual(state.adminPasskeyChallenges, []);
});
test("TOTP uses RFC-compatible six-digit authenticator codes", () => {
  const knownSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(knownSecret, 59_000), "287082");
  assert.equal(verifyTotp(knownSecret, "287082", 59_000), true);
  assert.equal(verifyTotp(knownSecret, "000000", 59_000), false);
  const generated = totpSecret();
  assert.match(generated, /^[A-Z2-7]{32}$/);
  assert.match(totpUri(generated), /^otpauth:\/\/totp\//);
});

test("bootstrap deployment exposes readiness and plans but blocks operational APIs", async (t) => {
  const server = createServer({
    store: createStore({ persistent: false }),
    validateConfig: false,
    env: { BOOTSTRAP_MODE: "true", CUSTOMER_APP_URL: "http://customer.test" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`,
    health = await fetch(`${base}/api/health`),
    plansResponse = await fetch(`${base}/api/plans`),
    purchaseResponse = await fetch(`${base}/api/purchase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: "670000001", email: "customer@example.com",
        network: "mtn", planId: "daily",
      }),
    }),
    adminLogin = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "2468" }),
    }),
    adminDashboard = await fetch(`${base}/api/admin/dashboard`, {
      headers: { cookie: adminLogin.headers.get("set-cookie").split(";")[0] },
    });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).operational, false);
  assert.equal(plansResponse.status, 200);
  const plansBody = await plansResponse.json();
  assert.equal(plansBody.plans.length, plans.length);
  assert.equal(plansBody.paymentProvider, null);
  assert.equal(purchaseResponse.status, 503);
  assert.equal((await purchaseResponse.json()).operational, false);
  assert.equal(adminLogin.status, 200);
  assert.equal(adminDashboard.status, 200);
  assert.equal((await adminDashboard.json()).deployment.mode, "setup");
});

test("admin password login requires a separate one-time MFA challenge", async (t) => {
  const server = createServer({
    store: createStore({ persistent: false }),
    validateConfig: false,
    env: {
      ADMIN_PIN: "9999",
      ADMIN_MFA_ENABLED: "true",
      ADMIN_MFA_CODE: "123456",
      CUSTOMER_APP_URL: "http://customer.test",
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`,
    passwordStep = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "9999" }),
    }),
    challenge = await passwordStep.json();
  assert.equal(passwordStep.status, 202);
  assert.equal(passwordStep.headers.get("set-cookie"), null);
  assert.equal(challenge.mfaRequired, true);
  const badMfa = await fetch(`${base}/api/admin/login/mfa`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, mfaCode: "000000" }),
  });
  assert.equal(badMfa.status, 401);
  const validMfa = await fetch(`${base}/api/admin/login/mfa`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, mfaCode: "123456" }),
  });
  assert.equal(validMfa.status, 200);
  assert.match(validMfa.headers.get("set-cookie"), /admin_session=/);
  const reused = await fetch(`${base}/api/admin/login/mfa`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId, mfaCode: "123456" }),
  });
  assert.equal(reused.status, 401);
});

test("bootstrap mode allows Flutterwave checkout when payment credentials are ready", async (t) => {
  const server = createServer({
    store: createStore({ persistent: false }),
    validateConfig: false,
    payments: {
      flutterwave: {
        configured: () => true,
        createPayment: async () => ({ providerReference: "123456" }),
      },
    },
    env: {
      BOOTSTRAP_MODE: "true",
      PAYMENT_MODE: "live",
      CUSTOMER_APP_URL: "http://customer.test",
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`,
    response = await fetch(`${base}/api/purchase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Customer", phone: "670000001", email: "customer@example.com",
        network: "mtn", planId: "daily",
      }),
    });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).payment.provider, "flutterwave");
});

test("MeSomb checkout and webhook verification issue one voucher", async (t) => {
  const store = createStore({ persistent: false });
  const mesomb = {
    configured: () => true,
    createPayment: async () => ({
      providerReference: "mesomb-pending-1",
      status: "pending",
      authorizationMode: "mobile_money_prompt",
    }),
    handleWebhook: async () => ({
      eventId: "mesomb-event-1",
      paymentId: paymentId,
      transactionId: "mesomb-paid-1",
    }),
    verifyPayment: async (payment) => ({
      status: "paid",
      providerReference: "mesomb-paid-1",
      transactionReference: payment.id,
      amount: payment.amount,
      currency: payment.currency,
    }),
  };
  let paymentId;
  const server = createServer({
    store,
    validateConfig: false,
    payments: { mesomb },
    env: { PAYMENT_MODE: "mesomb", CUSTOMER_APP_URL: "http://customer.test" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`,
    purchase = await fetch(`${base}/api/purchase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Customer", phone: "670000001", email: "customer@example.com",
        network: "mtn", planId: "daily",
      }),
    }),
    created = await purchase.json();
  assert.equal(purchase.status, 201);
  assert.equal(created.payment.provider, "mesomb");
  assert.equal(created.checkout.provider, "mesomb");
  paymentId = created.payment.id;
  const webhook = () => fetch(`${base}/api/webhooks/mesomb`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mesomb-webhook-signature": "verified-by-adapter",
    },
    body: JSON.stringify({ id: "mesomb-event-1" }),
  });
  const confirmed = await webhook(), confirmedBody = await confirmed.json();
  assert.equal(confirmed.status, 200);
  assert.equal(confirmedBody.payment.status, "paid");
  assert.match(confirmedBody.access.code, /^NC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const duplicate = await webhook();
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).idempotent, true);
  assert.equal((await store.snapshot()).vouchers.length, 1);
});

test("pending MeSomb status does not treat a missing voucher as an email record", async (t) => {
  const store = createStore({ persistent: false });
  const server = createServer({
    store,
    validateConfig: false,
    payments: {
      mesomb: {
        configured: () => true,
        createPayment: async () => ({ providerReference: "mesomb-pending-2" }),
        verifyPayment: async (payment) => ({
          status: "pending",
          providerReference: payment.providerReference,
          transactionReference: payment.id,
          amount: payment.amount,
          currency: payment.currency,
        }),
      },
    },
    env: { PAYMENT_MODE: "mesomb", CUSTOMER_APP_URL: "http://customer.test" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`,
    purchase = await fetch(`${base}/api/purchase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Customer", phone: "670000002", email: "pending@example.com",
        network: "orange", planId: "weekly",
      }),
    }),
    created = await purchase.json(),
    status = await fetch(`${base}/api/payments/${created.payment.id}/status`),
    result = await status.json();
  assert.equal(status.status, 200);
  assert.equal(result.payment.status, "pending");
  assert.equal("access" in result, false);
  assert.equal((await store.snapshot()).vouchers.length, 0);
});
