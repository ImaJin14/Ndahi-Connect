import assert from "node:assert/strict";
import test from "node:test";
import {
  migrationCounts,
  reconcileMigration,
  validateLegacyState,
} from "../lib/state-migration.mjs";
import { normalizedCollections } from "../lib/postgres-store.mjs";

const fixture = () => ({
  customers: [
    { id: "customer-1", phone: "670000001" },
    { id: "customer-2", phone: "670000002" },
  ],
  adminUsers: [{ id: "admin-1", username: "owner" }],
  bundles: [{ id: "market-plan", name: "Market plan" }],
  payments: [{ id: "payment-1", customerId: "customer-1", providerReference: "provider-1" }],
  vouchers: [{ id: "voucher-1", customerId: "customer-1", paymentId: "payment-1", code: "NC-ABCD-2345" }],
  sessions: [{ id: "network-1", voucherId: "voucher-1" }],
  dashboardSessions: [{ customerId: "customer-1", tokenHash: "customer-token" }],
  adminSessions: [{ userId: "admin-1", tokenHash: "admin-token" }],
  adminPasskeyChallenges: [{ id: "challenge-1" }],
  customerPasskeyChallenges: [{ id: "challenge-2", customerId: "customer-1" }],
  customerMfaChallenges: [], customerAccessChallenges: [], pinResetChallenges: [],
  adminLoginChallenges: [], otpChallenges: [], adminMfaChallenges: [],
  securityEvents: [{ id: "security-1", type: "login.failed" }],
  events: [{ id: "event-1", type: "voucher.issued" }],
  providerEvents: [{ id: "provider-event-1", type: "payment.confirmed" }],
  rateLimitEvents: [{ id: "rate-1", type: "customer-auth" }],
  auditLogs: [{ id: "audit-1", action: "admin.login" }],
  bundleOverrides: { daily: { price: 100 } },
  adminProfile: { mfaEnabled: true },
  zone: { id: "wisp-zone-1", status: "online" },
});

test("production-shaped legacy state validates and reconciles without loss", () => {
  const source = fixture(), destination = structuredClone(source);
  assert.deepEqual(validateLegacyState(source), []);
  const result = reconcileMigration(source, destination);
  assert.equal(result.matched, true);
  assert.deepEqual(result.expected, result.actual);
  assert.equal(Object.values(migrationCounts(source)).reduce((a, b) => a + b, 0), 16);
  assert.deepEqual(
    normalizedCollections.map(({ stateKey }) => stateKey),
    Object.keys(migrationCounts(source)),
    "rehearsal and PostgreSQL adapter must cover the same collections",
  );
});

test("preflight rejects dangling relationships and database uniqueness conflicts", () => {
  const state = fixture();
  state.payments[0].customerId = "missing-customer";
  state.vouchers.push({ id: "voucher-2", code: "NC-ABCD-2345" });
  const errors = validateLegacyState(state);
  assert.ok(errors.some((error) => error.includes("missing customerId")));
  assert.ok(errors.some((error) => error.includes("vouchers.code is duplicated")));
});

test("reconciliation identifies the exact collection with missing rows", () => {
  const source = fixture(), destination = structuredClone(source);
  destination.auditLogs = [];
  assert.deepEqual(reconcileMigration(source, destination).mismatches, [
    "auditLogs: expected 1, found 0",
  ]);
});
