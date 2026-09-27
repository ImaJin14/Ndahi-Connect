import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { createSecurityAlertService, queueSecurityAlert } from "../lib/security-alerts.mjs";

test("AUTH-005 queueSecurityAlert records a durable pending alert scoped to the customer", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    queueSecurityAlert(s, {
      customerId: "c1", kind: "pin_reset", subject: "Your PIN was reset", lines: ["line one"],
    }, new Date("2026-09-25T00:00:00Z"));
  });
  const state = await store.snapshot();
  assert.equal(state.securityAlerts.length, 1);
  const [alert] = state.securityAlerts;
  assert.equal(alert.customerId, "c1");
  assert.equal(alert.kind, "pin_reset");
  assert.equal(alert.status, "pending");
  assert.equal(alert.attempts, 0);
  assert.equal(alert.at, "2026-09-25T00:00:00.000Z");
});

test("AUTH-005 worker delivers a pending alert and marks it sent", async () => {
  const store = createStore({ persistent: false });
  const delivered = [];
  await store.transaction((s) => {
    s.customers.push({ id: "c1", email: "customer@example.test" });
    queueSecurityAlert(s, { customerId: "c1", kind: "passkey_added", subject: "New passkey", lines: ["A passkey was added."] });
  });
  const service = createSecurityAlertService({
    store, email: { async sendSecurityAlert(message) { delivered.push(message); return { messageId: "mail-1" }; } },
  });
  await service.run();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].to, "customer@example.test");
  assert.equal(delivered[0].alert.subject, "New passkey");
  const state = await store.snapshot();
  assert.equal(state.securityAlerts[0].status, "sent");
  assert.ok(state.securityAlerts[0].sentAt);
  await service.run();
  assert.equal(delivered.length, 1, "an already-sent alert must not be redelivered");
});

test("AUTH-005 worker skips delivery when the customer has no account email and tracks the reason", async () => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c1" });
    queueSecurityAlert(s, { customerId: "c1", kind: "pin_locked", subject: "PIN locked", lines: ["locked"] });
  });
  const service = createSecurityAlertService({
    store, email: { async sendSecurityAlert() { throw Error("should not be called"); } },
  });
  await service.run();
  const state = await store.snapshot();
  assert.equal(state.securityAlerts[0].status, "skipped");
  assert.match(state.securityAlerts[0].lastError, /no account email/i);
});

test("AUTH-005 worker tracks delivery failures with backoff and no secrets are queued in the message", async () => {
  let clock = new Date("2026-09-25T00:00:00Z");
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c1", email: "customer@example.test" });
    queueSecurityAlert(s, {
      customerId: "c1", kind: "recovery_code_used", subject: "Recovery code used",
      lines: ["A recovery code was used to sign in."],
    }, clock);
  });
  let attempts = 0;
  const service = createSecurityAlertService({
    store, now: () => clock,
    email: { async sendSecurityAlert() { attempts++; throw Error("provider outage"); } },
  });
  await service.run();
  let state = await store.snapshot();
  assert.equal(state.securityAlerts[0].status, "pending");
  assert.equal(state.securityAlerts[0].attempts, 1);
  assert.match(state.securityAlerts[0].lastError, /provider outage/);
  assert.ok(JSON.stringify(state.securityAlerts[0]).length < 2000);
  assert.doesNotMatch(JSON.stringify(state.securityAlerts[0]), /pin|password|secret/i);
  for (let i = 0; i < 10; i++) {
    clock = new Date(clock.getTime() + 24 * 3600_000);
    await service.run();
  }
  state = await store.snapshot();
  assert.equal(state.securityAlerts[0].status, "failed");
  assert.equal(attempts, 8, "delivery must stop retrying once the attempt cap is reached");
});
