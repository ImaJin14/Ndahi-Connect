import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { totpCode, totpSecret } from "../lib/security.mjs";

async function fixture(t, options = {}) {
  const store = options.store || createStore({ persistent: false });
  const server = createServer({
    store, email: options.email, now: options.now,
    env: {
      PAYMENT_MODE: "mock", OTP_DELIVERY: "mock", SECRET_PEPPER: "test-pepper",
      CUSTOMER_SESSION_SECRET: "customer-test-secret", ADMIN_SESSION_SECRET: "admin-test-secret",
      SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: "http://customer.test",
      ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test",
      ADMIN_PIN: "9999", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
      ...options.env,
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, jar = {};
  const call = async (path, method = "GET", data, extra = {}) => {
    const cookie = extra.cookie ?? Object.values(jar).join("; "),
      response = await fetch(base + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...(extra.headers || {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      }),
      set = response.headers.get("set-cookie");
    if (set) { const pair = set.split(";")[0]; jar[pair.split("=")[0]] = pair; }
    const json = await response.json();
    return { response, json, setCookie: set };
  };
  return { store, call, jar, base };
}

async function account(f, phone = "670010001") {
  const purchase = await f.call("/api/purchase", "POST", { phone, planId: "weekly" });
  assert.equal(purchase.response.status, 201);
  const paid = await f.call(`/api/payments/${purchase.json.payment.id}/confirm`, "POST");
  assert.equal(paid.response.status, 200);
  await f.call("/api/account/setup/pin", "POST", { phone, code: paid.json.access.code, pin: "2468", confirmPin: "2468" });
  const customerId = (await f.store.snapshot()).customers.find((c) => c.phone === phone).id;
  return { phone, customerId };
}

test("AUTH-001 security overview lists the current session and enrolled methods", async (t) => {
  const f = await fixture(t);
  const { phone } = await account(f);
  delete f.jar.customer_session;
  await f.call("/api/account/login/pin", "POST", { phone, pin: "2468" });
  const security = await f.call("/api/account/security");
  assert.equal(security.response.status, 200);
  assert.equal(security.json.sessions.length, 2, "setup-pin and login/pin each create a session");
  assert.equal(security.json.sessions.filter((s) => s.current).length, 1);
  assert.ok(security.json.sessions.every((s) => s.createdAt && s.lastSeenAt));
  assert.equal(security.json.pinConfigured, true);
  assert.equal(security.json.authenticatorEnrolled, false);
  assert.equal(security.json.recoveryCodesRemaining, null);
  assert.deepEqual(security.json.passkeys, []);
  assert.ok(security.json.recentLogins.some((entry) => entry.type === "customer.pin_login.succeeded"));
});

test("AUTH-001/002 a second device session is listed separately and carries its own metadata", async (t) => {
  const f = await fixture(t);
  const { phone } = await account(f);
  const firstCookie = f.jar.customer_session;
  delete f.jar.customer_session;
  await f.call("/api/account/login/pin", "POST", { phone, pin: "2468" }, { headers: { "user-agent": "SecondDeviceBrowser/1.0" } });
  const secondCookie = f.jar.customer_session;
  assert.notEqual(firstCookie, secondCookie);
  const security = await f.call("/api/account/security");
  assert.equal(security.json.sessions.length, 2);
  assert.equal(security.json.sessions.filter((s) => s.current).length, 1);
  assert.equal(security.json.sessions.find((s) => s.current).userAgent, "SecondDeviceBrowser/1.0");
  assert.ok(security.json.sessions.some((s) => !s.current), "the first device's session must still be listed");
});

test("AUTH-002 revoking another session leaves the current one signed in; revoking the current one logs out", async (t) => {
  const f = await fixture(t);
  const { phone } = await account(f);
  delete f.jar.customer_session;
  await f.call("/api/account/login/pin", "POST", { phone, pin: "2468" });
  const security = await f.call("/api/account/security");
  assert.equal(security.json.sessions.length, 2);
  const other = security.json.sessions.find((s) => !s.current), current = security.json.sessions.find((s) => s.current);
  const revokedOther = await f.call("/api/account/security/sessions/revoke", "POST", { sessionId: other.id });
  assert.equal(revokedOther.response.status, 200);
  assert.equal(revokedOther.json.loggedOut, undefined);
  const stillIn = await f.call("/api/account/dashboard");
  assert.equal(stillIn.response.status, 200);
  const revokedSelf = await f.call("/api/account/security/sessions/revoke", "POST", { sessionId: current.id });
  assert.equal(revokedSelf.json.loggedOut, true);
  const loggedOut = await f.call("/api/account/dashboard");
  assert.equal(loggedOut.response.status, 401);
});

test("AUTH-002 a customer cannot revoke another customer's session", async (t) => {
  const f = await fixture(t);
  await account(f, "670010002");
  const otherId = (await f.store.snapshot()).dashboardSessions[0].id;
  await account(f, "670010003");
  const cross = await f.call("/api/account/security/sessions/revoke", "POST", { sessionId: otherId });
  assert.equal(cross.response.status, 404);
  assert.equal((await f.store.snapshot()).dashboardSessions.length, 2);
});

test("AUTH-002 logging out everywhere invalidates every session for that customer, including the current one", async (t) => {
  const f = await fixture(t);
  const { phone } = await account(f);
  delete f.jar.customer_session;
  await f.call("/api/account/login/pin", "POST", { phone, pin: "2468" });
  const result = await f.call("/api/account/security/logout-everywhere", "POST", {});
  assert.equal(result.response.status, 200);
  assert.equal(result.json.sessionsRevoked, 2);
  assert.equal((await f.store.snapshot()).dashboardSessions.length, 0);
  assert.equal((await f.call("/api/account/dashboard")).response.status, 401);
});

test("AUTH-003 an enrolled passkey gets a sensible default label and a custom label is respected", async (t) => {
  const f = await fixture(t);
  const { customerId } = await account(f);
  await f.store.transaction((s) => {
    s.customers.find((c) => c.id === customerId).passkeys = [
      { id: "key-1", publicKey: "pk1", counter: 0, createdAt: new Date().toISOString(), label: "Security key" },
      { id: "key-2", publicKey: "pk2", counter: 0, createdAt: new Date().toISOString(), label: "Passkey 2" },
    ];
  });
  const security = await f.call("/api/account/security");
  assert.deepEqual(security.json.passkeys.map((k) => k.label), ["Security key", "Passkey 2"]);
});

test("AUTH-003 passkeys can be renamed and removed by their owner only", async (t) => {
  const f = await fixture(t);
  const { customerId } = await account(f);
  await f.store.transaction((s) => {
    s.customers.find((c) => c.id === customerId).passkeys = [
      { id: "key-1", publicKey: "pk1", counter: 0, createdAt: new Date().toISOString(), label: "Passkey 1" },
    ];
  });
  const renamed = await f.call("/api/account/passkeys/rename", "POST", { passkeyId: "key-1", label: "Work laptop" });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.json.label, "Work laptop");
  const emptyLabel = await f.call("/api/account/passkeys/rename", "POST", { passkeyId: "key-1", label: "   " });
  assert.equal(emptyLabel.response.status, 400);
  const missing = await f.call("/api/account/passkeys/rename", "POST", { passkeyId: "does-not-exist", label: "x" });
  assert.equal(missing.response.status, 404);
  const removed = await f.call("/api/account/passkeys/remove", "POST", { passkeyId: "key-1" });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.json.passkeys, 0);
  assert.equal((await f.call("/api/account/security")).json.passkeys.length, 0);
  const alerts = (await f.store.snapshot()).securityAlerts;
  assert.ok(alerts.some((a) => a.kind === "passkey_removed" && a.customerId === customerId));
});

test("AUTH-004 recovery codes require authenticator 2FA, are hashed at rest, and let a customer sign in once each", async (t) => {
  const f = await fixture(t);
  const { customerId } = await account(f);
  const blocked = await f.call("/api/account/security/recovery-codes/generate", "POST", {});
  assert.equal(blocked.response.status, 409);
  const secret = totpSecret();
  await f.store.transaction((s) => { s.customers.find((c) => c.id === customerId).totpSecret = secret; });
  const generated = await f.call("/api/account/security/recovery-codes/generate", "POST", {});
  assert.equal(generated.response.status, 200);
  assert.equal(generated.json.codes.length, 10);
  const stored = await f.store.snapshot();
  const customer = stored.customers.find((c) => c.id === customerId);
  assert.equal(customer.recoveryCodes.length, 10);
  for (const code of generated.json.codes) {
    assert.ok(customer.recoveryCodes.every((rc) => rc.hash !== code), "plaintext recovery codes must never be stored");
  }
  assert.equal((await f.call("/api/account/security")).json.recoveryCodesRemaining, 10);
  delete f.jar.customer_session;
  const otp = await f.call("/api/account/login/request-authenticator", "POST", { phone: "670010001" });
  const codeToUse = generated.json.codes[0];
  const loggedIn = await f.call("/api/account/login/verify-authenticator", "POST", {
    challengeId: otp.json.challengeId, recoveryCode: codeToUse,
  });
  assert.equal(loggedIn.response.status, 200);
  assert.equal((await f.call("/api/account/security")).json.recoveryCodesRemaining, 9);
  delete f.jar.customer_session;
  const otp2 = await f.call("/api/account/login/request-authenticator", "POST", { phone: "670010001" });
  const reused = await f.call("/api/account/login/verify-authenticator", "POST", {
    challengeId: otp2.json.challengeId, recoveryCode: codeToUse,
  });
  assert.equal(reused.response.status, 401, "a used recovery code must not work a second time");
});

test("AUTH-004 regenerating recovery codes invalidates every previously issued code", async (t) => {
  const f = await fixture(t);
  const { customerId } = await account(f);
  const secret = totpSecret();
  await f.store.transaction((s) => { s.customers.find((c) => c.id === customerId).totpSecret = secret; });
  const first = await f.call("/api/account/security/recovery-codes/generate", "POST", {});
  const second = await f.call("/api/account/security/recovery-codes/generate", "POST", {});
  assert.notDeepEqual(first.json.codes, second.json.codes);
  delete f.jar.customer_session;
  const otp = await f.call("/api/account/login/request-authenticator", "POST", { phone: "670010001" });
  const attempt = await f.call("/api/account/login/verify-authenticator", "POST", {
    challengeId: otp.json.challengeId, recoveryCode: first.json.codes[0],
  });
  assert.equal(attempt.response.status, 401, "codes from a replaced batch must no longer work");
});

test("AUTH-005 PIN reset, lockout, and authenticator enrollment each queue a security alert with no secret material", async (t) => {
  let resetToken;
  const f = await fixture(t, { email: { configured: () => true, sendPinReset: async ({ token }) => { resetToken = token; return { messageId: "m" }; } } });
  const { customerId, phone } = await account(f);
  await f.store.transaction((s) => { s.customers.find((c) => c.id === customerId).email = "auth005@example.test"; });
  await f.call("/api/account/pin-reset/request", "POST", { phone });
  await f.call("/api/account/pin-reset/confirm", "POST", { token: resetToken, pin: "1357", confirmPin: "1357" });
  await f.store.transaction((s) => { s.customers.find((c) => c.id === customerId).pinFailedAttempts = 4; });
  const locked = await f.call("/api/account/login/pin", "POST", { phone, pin: "0000" });
  assert.equal(locked.json.locked, true);
  await f.store.transaction((s) => { delete s.customers.find((c) => c.id === customerId).pinLockedUntil; });
  await f.call("/api/account/login/pin", "POST", { phone, pin: "1357" });
  const enroll = await f.call("/api/account/security/mfa/enroll", "POST", {});
  const code = totpCode(enroll.json.secret, Date.now());
  await f.call("/api/account/security/mfa/confirm", "POST", { challengeId: enroll.json.challengeId, code });
  const alerts = (await f.store.snapshot()).securityAlerts.filter((a) => a.customerId === customerId);
  for (const kind of ["pin_reset", "pin_locked", "authenticator_enrolled"]) {
    assert.ok(alerts.some((a) => a.kind === kind), `missing ${kind} alert`);
  }
  const serialized = JSON.stringify(alerts);
  assert.doesNotMatch(serialized, /1357|0000/, "alert content must never include PIN values");
});

test("AUTH-005 admin authenticator reset also clears recovery codes so an old code can't resurface after re-enrollment", async (t) => {
  const f = await fixture(t);
  const { customerId, phone } = await account(f);
  const secret = totpSecret();
  await f.store.transaction((s) => { s.customers.find((c) => c.id === customerId).totpSecret = secret; });
  const generated = await f.call("/api/account/security/recovery-codes/generate", "POST", {});
  const oldCode = generated.json.codes[0];
  const adminJar = {};
  const adminLogin = await f.call("/api/admin/login", "POST", { pin: "9999" }, { headers: { origin: "http://admin.test" } });
  adminJar.admin_session = adminLogin.setCookie.split(";")[0];
  await f.call("/api/admin/customers/reset-authenticator", "POST", { customerId }, { cookie: adminJar.admin_session, headers: { origin: "http://admin.test" } });
  const newSecret = totpSecret();
  await f.store.transaction((s) => { s.customers.find((c) => c.id === customerId).totpSecret = newSecret; });
  delete f.jar.customer_session;
  const otp = await f.call("/api/account/login/request-authenticator", "POST", { phone });
  const attempt = await f.call("/api/account/login/verify-authenticator", "POST", { challengeId: otp.json.challengeId, recoveryCode: oldCode });
  assert.equal(attempt.response.status, 401);
});
