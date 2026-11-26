import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import argon2 from "argon2";
import { createHandler, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

// A new email confirmed by a link (PhoneEditProfile, #398; owner 26 Nov). The
// PIN is checked when the change is asked for; the new mailbox gets a link,
// single use and good for 30 minutes, that confirms the address without a
// portal session. Every portal session then ends. Older code requests keep
// working with their code.
const secret = "email-link-test", origin = "http://customer.test";
const pinHash = await argon2.hash("2468");
const operation = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

async function fixture(t) {
  let clock = new Date("2030-01-01T12:00:00Z");
  const store = createStore({ persistent: false }), deliveries = [];
  await store.transaction((s) => {
    s.customers.push({ id: "c1", phone: "670050001", name: "Amina Nfor", email: "old@example.test", pinHash });
    s.dashboardSessions.push({ id: "current", customerId: "c1", tokenHash: hashSecret("current", secret), csrfToken: "csrf", expiresAt: "2030-01-02T12:00:00Z" },
      { id: "other", customerId: "c1", tokenHash: hashSecret("other", secret), csrfToken: "csrf", expiresAt: "2030-01-02T12:00:00Z" });
  });
  const handler = createHandler({ store, now: () => clock, validateConfig: false,
    email: { configured: () => true, sendVerification: async (job) => { deliveries.push(job); return { messageId: "test" }; }, sendSecurityAlert: async () => ({ messageId: "alert" }) },
    env: { NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", SESSION_COOKIE_SECURE: "false", CUSTOMER_SESSION_SECRET: secret, CUSTOMER_APP_URL: origin,
      SECRET_PEPPER: "pepper", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const call = async (path, input, session = "current") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST",
      headers: { "content-type": "application/json", origin, "x-csrf-token": "csrf", ...(session ? { cookie: `customer_session=${session}` } : {}) }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const request = async (email, extra = {}) => {
    const c = (await store.snapshot()).customers[0];
    return call("/api/account/profile", { name: c.name, phone: c.phone, email, pin: "2468", operationId: operation(), confirmBy: "link", ...extra });
  };
  return { store, call, request, deliveries, worker: handler.transactionalEmails, advance: (ms) => { clock = new Date(+clock + ms); } };
}

test("a new email is confirmed by the link the mailbox gets, once", async (t) => {
  const f = await fixture(t);
  const asked = await f.request("new@example.test");
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.expiresAt, "2030-01-01T12:30:00.000Z", "30 minutes for a link");
  await f.worker.run();
  const [sent] = f.deliveries;
  assert.equal(sent.to, "new@example.test");
  assert.equal(sent.code, undefined, "a link, not a code");
  assert.match(sent.token, /^[0-9a-f-]{36}\.[0-9a-f]{40}$/);
  // Opened in any browser: no session is needed.
  const confirmed = await f.call("/api/account/profile/email/confirm-link", { token: sent.token }, null);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.deepEqual([confirmed.body.emailLinked, confirmed.body.email, confirmed.body.signInAgain], [true, "new@example.test", true]);
  const s = await f.store.snapshot();
  assert.equal(s.customers[0].email, "new@example.test");
  assert.ok(s.customers[0].emailVerifiedAt);
  assert.equal(s.customers[0].pendingEmail, undefined);
  assert.equal(s.dashboardSessions.filter((x) => x.customerId === "c1").length, 0, "every portal session ends");
  assert.ok(s.securityAlerts.some((a) => a.kind === "email_replaced" && a.recipient === "old@example.test"), "the old address is told");
  // The same link again (a lost reply) says it is done, and changes nothing more.
  const again = await f.call("/api/account/profile/email/confirm-link", { token: sent.token }, null);
  assert.deepEqual([again.status, again.body.emailLinked, again.body.email], [200, true, "new@example.test"]);
  assert.equal((await f.store.snapshot()).securityAlerts.filter((a) => a.kind === "email_replaced").length, 1, "applied once");
  // A forged token for the used link is still refused, and after 30 minutes the link has expired.
  const [id, signature] = sent.token.split(".");
  assert.equal((await f.call("/api/account/profile/email/confirm-link", { token: `${id}.${signature.replace(/.$/, (x) => (x === "0" ? "1" : "0"))}` }, null)).body.code, "LINK_EXPIRED");
  f.advance(31 * 60000);
  assert.equal((await f.call("/api/account/profile/email/confirm-link", { token: sent.token }, null)).body.code, "LINK_EXPIRED");
});

test("a link that is tampered with, late or for a code request is refused", async (t) => {
  const f = await fixture(t);
  await f.request("new@example.test");
  await f.worker.run();
  const { token } = f.deliveries[0], [id, signature] = token.split(".");
  const wrong = `${id}.${signature.slice(0, -1)}${signature.at(-1) === "0" ? "1" : "0"}`;
  assert.equal((await f.call("/api/account/profile/email/confirm-link", { token: wrong }, null)).status, 400);
  assert.equal((await f.store.snapshot()).customers[0].pendingEmail.attempts, 1, "a wrong link counts as an attempt");
  assert.equal((await f.call("/api/account/profile/email/confirm-link", { token: "nonsense" }, null)).status, 400);
  // After 30 minutes the right link is refused too.
  f.advance(31 * 60000);
  assert.equal((await f.call("/api/account/profile/email/confirm-link", { token }, null)).body.code, "LINK_EXPIRED");
  assert.equal((await f.store.snapshot()).customers[0].email, "old@example.test");
});

test("a code request still confirms with its code, never with a link", async (t) => {
  const f = await fixture(t);
  const asked = await f.request("code@example.test", { confirmBy: undefined });
  assert.equal(asked.body.expiresAt, "2030-01-01T12:10:00.000Z", "10 minutes for a code");
  await f.worker.run();
  const { code, requestId } = f.deliveries[0];
  assert.match(code, /^\d{6}$/);
  const forged = `${requestId}.${"0".repeat(40)}`;
  assert.equal((await f.call("/api/account/profile/email/confirm-link", { token: forged }, null)).status, 400);
  assert.equal((await f.call("/api/account/profile/email/confirm", { code })).status, 200);
  assert.equal((await f.store.snapshot()).customers[0].email, "code@example.test");
});
