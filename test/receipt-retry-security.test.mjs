// Security regressions for receipt retries. Releasing waiting receipts must stay
// tied to the signed-in customer's own records: another customer cannot release
// them, the settings route still needs a session and its CSRF token, and a nudge
// never sends a receipt to an address the customer has not confirmed.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createStore, createServer } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { silentLogger } from "../lib/logger.mjs";

const now = new Date("2030-07-01T10:00:00Z"), later = (ms) => new Date(+now + ms).toISOString();
const tokenA = "a".repeat(43), tokenB = "b".repeat(43), secret = "receipt-security-secret";

test("only the signed-in customer's own waiting receipts are released, never to an unconfirmed address", async (t) => {
  const store = createStore({ persistent: false }), sent = [];
  await store.transaction((s) => {
    s.customers.push({ id: "ca", phone: "670000701", name: "A", email: "a@example.test", emailVerifiedAt: now.toISOString() },
      // B typed an address but never confirmed it.
      { id: "cb", phone: "670000702", name: "B", email: "b@example.test", emailVerificationRequired: true });
    for (const [id, customerId, status] of [["pa", "ca", "disabled"], ["pb", "cb", "needs_email"]]) {
      s.payments.push({ id, customerId, status: "paid", confirmedAt: now.toISOString(), createdAt: now.toISOString(), provider: "mesomb",
        amount: 1000, currency: "XAF", planId: "weekly", planSnapshot: { id: "weekly", name: "Weekly", price: 1000 },
        receipt: { number: `NC-${id}`, paymentId: id, plan: { id: "weekly", name: "Weekly" }, amount: 1000, currency: "XAF" },
        receiptEmail: { status, attempts: 0, recheckAt: later(3600000) } });
    }
    s.notificationStates.push({ id: "preferences:customer:ca", actor: "customer:ca", emailTransactions: false });
    for (const [id, token, customerId, csrfToken] of [["sa", tokenA, "ca", "csrf-a"], ["sb", tokenB, "cb", "csrf-b"]]) {
      s.dashboardSessions.push({ id, tokenHash: hashSecret(token, secret), customerId, role: "customer", csrfToken,
        expiresAt: later(1800000), createdAt: now.toISOString(), lastSeenAt: now.toISOString() });
    }
  });
  const server = createServer({ store, now: () => now, validateConfig: false, logger: silentLogger,
    email: { configured: () => true, async sendReceipt({ to }) { sent.push(to); return { messageId: "m" }; } },
    env: { NODE_ENV: "production", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
      CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: "http://customer.test",
      BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const handler = server.listeners("request")[0];
  const settings = (headers) => fetch(`http://127.0.0.1:${server.address().port}/api/account/notifications`, { method: "POST",
    headers: { "content-type": "application/json", origin: "http://customer.test", ...headers },
    body: JSON.stringify({ action: "preferences", emailTransactions: true }) }).then((r) => r.status);
  const waits = async () => Object.fromEntries((await store.snapshot()).payments.map((p) => [p.id, p.receiptEmail.recheckAt]));
  const before = await waits();

  assert.equal(await settings({}), 401, "no session");
  assert.equal(await settings({ cookie: `customer_session=${tokenA}` }), 403, "no CSRF token");
  assert.equal(await settings({ cookie: `customer_session=${tokenA}`, "x-csrf-token": "csrf-b" }), 403, "another session's CSRF token");
  assert.deepEqual(await waits(), before, "refused requests release nothing");

  // B changes B's own settings: A's receipt keeps waiting.
  assert.equal(await settings({ cookie: `customer_session=${tokenB}`, "x-csrf-token": "csrf-b" }), 200);
  let after = await waits();
  assert.equal(after.pa, before.pa, "another customer cannot release A's receipt");
  assert.equal(after.pb, undefined, "B's own receipt is released");
  // A turns transactional email back on: only A's receipt is released.
  assert.equal(await settings({ cookie: `customer_session=${tokenA}`, "x-csrf-token": "csrf-a" }), 200);
  after = await waits();
  assert.equal(after.pa, undefined);

  await handler.billing.run();
  const state = await store.snapshot();
  assert.deepEqual(sent, ["a@example.test"], "only the confirmed address receives a receipt");
  assert.equal(state.payments.find((p) => p.id === "pb").receiptEmail.status, "needs_email", "an unconfirmed address is never used");
});
