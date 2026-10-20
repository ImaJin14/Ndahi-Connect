import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import argon2 from "argon2";
import { createHandler, createStore } from "../server.mjs";
import { hashSecret, totpCode } from "../lib/security.mjs";

const root = "/api/account/security/mfa", secret = "mfa-fixture", pinHash = await argon2.hash("2468");
async function fixture(t) {
  let now = new Date("2030-01-01T12:00:00Z");
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c1", name: "Customer", phone: "670050001", pinHash }, { id: "c2", phone: "670050002", pinHash });
    for (const [id, customerId] of [["main", "c1"], ["secondary", "c1"], ["other", "c2"]]) s.dashboardSessions.push({ id, customerId,
      tokenHash: hashSecret(id, secret), csrfToken: "csrf", expiresAt: "2030-01-02T12:00:00Z" });
  });
  const server = http.createServer(createHandler({ store, now: () => now, validateConfig: false, router: {}, env: {
    NODE_ENV: "production", CUSTOMER_APP_URL: "http://customer.test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "warn",
  } }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const call = async (path, input, { session = "main", csrf = "csrf" } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + path, { method: input === undefined ? "GET" : "POST",
      headers: { origin: "http://customer.test", cookie: session ? `customer_session=${session}` : "", "x-csrf-token": csrf, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { store, call, now: () => now, advance(seconds) { now = new Date(+now + seconds * 1000); },
    start: (options) => call(root + "/enroll", {}, options),
    confirm: (enrollment, code, options) => call(root + "/confirm", { challengeId: enrollment.body.challengeId, code: code ?? totpCode(enrollment.body.secret, +now) }, options) };
}

test("signed-in customers create a scannable, session-bound setup without enabling until confirmed", async (t) => {
  const f = await fixture(t), enrollment = await f.start();
  assert.equal(enrollment.status, 200); assert.match(enrollment.body.secret, /^[A-Z2-7]{32}$/);
  const uri = new URL(enrollment.body.uri);
  assert.equal(uri.protocol, "otpauth:"); assert.equal(uri.hostname, "totp");
  assert.equal(decodeURIComponent(uri.pathname), "/NDAHI Connect:670050001");
  for (const [name, value] of Object.entries({ secret: enrollment.body.secret, issuer: "NDAHI Connect", algorithm: "SHA1", digits: "6", period: "30" })) assert.equal(uri.searchParams.get(name), value);
  assert.match(enrollment.body.qrCode, /^data:image\/png;base64,/);
  assert.equal(enrollment.headers.get("cache-control"), "no-store");
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, undefined);
  assert.equal((await f.confirm(enrollment)).status, 200);
  const s = await f.store.snapshot(); assert.equal(s.customers[0].totpSecret, enrollment.body.secret);
  assert.equal(s.customerMfaChallenges.length, 0);
  assert.equal((await f.call("/api/account/security")).body.authenticatorEnrolled, true);
  assert.equal((await f.call("/api/account/login/pin", { phone: "670050001", pin: "2468" })).status, 200);
  const challenge = await f.call("/api/account/login/request-authenticator", { phone: "670050001" });
  assert.equal(challenge.status, 200);
  assert.equal((await f.call("/api/account/login/verify-authenticator", { challengeId: challenge.body.challengeId, otp: totpCode(enrollment.body.secret, +f.now()) })).status, 200);
  assert.equal((await f.confirm(enrollment)).status, 409);
  assert.equal((await f.start()).status, 409);
  assert.ok(s.securityAlerts.some((a) => a.kind === "authenticator_enrolled"));
  assert.equal(JSON.stringify(s.securityEvents).includes(enrollment.body.secret), false);
  assert.equal(JSON.stringify(s.securityAlerts).includes(enrollment.body.secret), false);
});

test("authenticator enrollment checks CSRF, ownership, the exact browser session and suspended accounts", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.start({ session: "" })).status, 401);
  assert.equal((await f.start({ csrf: "bad" })).status, 403);
  const enrollment = await f.start();
  assert.equal((await f.confirm(enrollment, undefined, { csrf: "bad" })).status, 403);
  assert.equal((await f.confirm(enrollment, undefined, { session: "other" })).status, 400);
  assert.equal((await f.confirm(enrollment, undefined, { session: "secondary" })).status, 400);
  await f.store.transaction((s) => { s.customers[0].status = "suspended"; });
  assert.equal((await f.confirm(enrollment)).status, 403);
  assert.equal((await f.start()).status, 403);
});

test("new setup invalidates old keys, expires in ten minutes and cannot overwrite an enrolled authenticator", async (t) => {
  const f = await fixture(t), old = await f.start(), current = await f.start();
  assert.equal((await f.confirm(old)).status, 400);
  assert.equal((await f.confirm(current)).status, 200);
  assert.equal((await f.confirm(old)).status, 409);
  assert.equal((await f.store.snapshot()).customers[0].totpSecret, current.body.secret);
  const g = await fixture(t), expired = await g.start(); g.advance(600);
  assert.equal((await g.confirm(expired)).body.code, "MFA_SETUP_EXPIRED");
  assert.equal((await g.store.snapshot()).customers[0].totpSecret, undefined);
});

test("wrong codes are bounded, while cancelling and restarting removes unconfirmed keys", async (t) => {
  const f = await fixture(t), enrollment = await f.start();
  const valid = totpCode(enrollment.body.secret, +f.now()), wrong = valid === "000000" ? "111111" : "000000";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await f.confirm(enrollment, wrong);
    assert.equal(result.status, attempt === 5 ? 429 : 400); assert.equal(result.body.attemptsRemaining, 5 - attempt);
  }
  assert.equal((await f.confirm(enrollment)).status, 400);
  const next = await f.start();
  assert.equal((await f.call(root + "/cancel", { challengeId: next.body.challengeId }, { session: "other" })).status, 200);
  assert.equal((await f.store.snapshot()).customerMfaChallenges.length, 1);
  assert.equal((await f.call(root + "/cancel", { challengeId: next.body.challengeId })).status, 200);
  assert.equal((await f.confirm(next)).status, 400);
  assert.equal((await f.store.snapshot()).customerMfaChallenges.length, 0);
});

test("repeated enrollment starts are limited per customer", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.start()).status, 200);
  assert.equal((await f.start()).status, 429);
  assert.equal((await f.start({ session: "other" })).status, 200);
  f.advance(901); assert.equal((await f.start()).status, 200);
});
