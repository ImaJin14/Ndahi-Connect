import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blank, createStore } from "../lib/api/state.mjs";
import { accountReconciliationReport, reconcileAccountState } from "../lib/account-reconciliation.mjs";
import { parseReconciliationArguments, runAccountReconciliation } from "../scripts/reconcile-accounts.mjs";

const pepper = "test-only-reconciliation-key", now = new Date("2030-01-01T12:00:00Z");
function fixture() {
  const s = blank();
  s.customers.push({ id: "original", phone: "670180001", name: "Imajin", email: "first@example.test", pinHash: "original-hash",
    emailVerificationRequired: true, createdAt: "2029-01-01T00:00:00Z" },
  { id: "duplicate", phone: "+237 (670) 180-001", name: "Different name", email: "second@example.test",
    emailVerificationRequired: true, createdAt: "2029-02-01T00:00:00Z" });
  s.payments.push({ id: "p", customerId: "duplicate", planId: "weekly", status: "paid", amount: 1000,
    payerPhone: "690180002", customerName: "Different name", email: "second@example.test",
    guestCheckoutDetails: { name: "Different name", email: "second@example.test", phone: "670180001" },
    receipt: { customerName: "Different name", amount: 1000 } });
  s.vouchers.push({ id: "v", paymentId: "p", customerId: "duplicate", code: "PRIVATE", status: "active",
    expiresAt: "2030-01-02T12:00:00Z", quotaBytes: 5e9, usedBytes: 20, deviceLimit: 1 });
  s.sessions.push({ id: "network", voucherId: "v", status: "active" });
  s.routerCommands.push({ id: "queued", targetId: "v", action: "read_usage" });
  s.dashboardSessions.push({ id: "old-session", customerId: "original" });
  s.customerAccessChallenges.push({ id: "old-challenge", phone: "+237670180001", voucherId: "v" });
  return s;
}
const report = s => accountReconciliationReport(s, { pepper, now });
const apply = s => reconcileAccountState(s, { pepper, now, expectedDigest: report(s).digest });

test("inventory is private and read-only; differences in guest details do not overwrite original identity", () => {
  const s = fixture(), before = structuredClone(s), r = report(s);
  assert.deepEqual(s, before);
  assert.equal(r.repairs.length, 1);
  assert.equal(r.duplicateGroups[0].differentNames, true);
  for (const secret of ["670180001", "first@example.test", "second@example.test", "original-hash", "PRIVATE", "Imajin"])
    assert.equal(JSON.stringify(r).includes(secret), false, secret);
});

test("merge retains original profile and credentials and all financial/router terms; revokes browser authority", () => {
  const s = fixture(), before = structuredClone(s), result = apply(s);
  assert.equal(result.changedCustomerCount, 1); assert.equal(result.removedCustomerCount, 1);
  assert.deepEqual(s.customers, [before.customers[0]]);
  assert.deepEqual(s.payments, [{ ...before.payments[0], customerId: "original" }]);
  assert.deepEqual(s.vouchers, [{ ...before.vouchers[0], customerId: "original" }]);
  assert.deepEqual(s.sessions, before.sessions); assert.deepEqual(s.routerCommands, before.routerCommands);
  assert.deepEqual(s.dashboardSessions, []); assert.deepEqual(s.customerAccessChallenges, []);
  assert.equal(s.auditLogs[0].action, "customer.accounts_reconciled");
  assert.deepEqual(s.auditLogs[0].meta.removedCustomerIds, ["duplicate"]);
  assert.deepEqual(result.backup.collections.customers.before, [before.customers[1]]);
  assert.equal(report(s).repairs.length, 0);
  assert.equal(apply(s).changedCustomerCount, 0, "rerunning cannot duplicate credits or audit entries");
  assert.equal(s.auditLogs.length, 1);
});

for (const [reason, change] of [
  ["DUPLICATE_HAS_IDENTITY_OR_ACCESS", s => { s.customers[1].pinHash = "other-credential"; }],
  ["DUPLICATE_HAS_IDENTITY_OR_ACCESS", s => { s.customers[1].emailVerifiedAt = now.toISOString(); }],
  ["DUPLICATE_HAS_IDENTITY_OR_ACCESS", s => { s.customers[1].phoneVerified = true; }],
  ["SUSPENDED_ACCOUNT", s => { s.customers[1].suspended = true; }],
  ["ORIGINAL_ACCOUNT_UNCERTAIN", s => { delete s.customers[0].createdAt; }],
  ["ORIGINAL_CREDENTIAL_REQUIRED", s => { delete s.customers[0].pinHash; }],
  ["PENDING_PROFILE_EDIT", s => { s.customers[0].pendingEmail = { profileChange: {} }; }],
  ["DUPLICATE_HAS_DEVICE_OR_HOME_STATE", s => { s.wifiDeviceGrants.push({ id: "grant", customerId: "duplicate" }); }],
  ["UNSETTLED_PAYMENT_OR_SETUP", s => { s.payments[0].status = "pending"; }],
  ["OVERLAPPING_ACTIVE_BUNDLES", s => { s.vouchers.push({ ...s.vouchers[0], id: "other", customerId: "original" }); }],
  ["CROSS_ACCOUNT_PAYMENT_LINK", s => { s.payments[0].customerId = "someone-else"; }],
]) test(`conflicting identity or access is held for review: ${reason}`, () => {
  const s = fixture(); change(s); const before = structuredClone(s), r = report(s);
  assert.equal(r.repairs.length, 0); assert.ok(r.review[0].reasons.includes(reason));
  apply(s); assert.deepEqual(s, before);
});

test("an alternate payer is never grouped as the owner and historical mismatches stay unchanged", () => {
  const s = fixture(); s.customers.splice(1, 1); s.payments[0].customerId = "original"; s.vouchers[0].customerId = "original";
  s.customers.push({ id: "payer", phone: "690180002", name: "Payer", createdAt: "2028-01-01T00:00:00Z", pinHash: "payer-hash" });
  const before = structuredClone(s), r = report(s);
  assert.equal(r.repairs.length, 0); assert.equal(r.historicalCheckoutDifferences, 1);
  apply(s); assert.deepEqual(s, before);
});

test("single formatted number is normalized without changing PIN, profile, backup codes or bundle", () => {
  const s = fixture(); s.customers.splice(1, 1); s.payments[0].customerId = "original"; s.vouchers[0].customerId = "original";
  s.customers[0].phone = "+237670180001"; s.customers[0].accountBackupCodes = [{ hash: "keep" }];
  const before = structuredClone(s); apply(s);
  assert.deepEqual(s.customers[0], { ...before.customers[0], phone: "670180001" });
  assert.deepEqual(s.payments, before.payments); assert.deepEqual(s.vouchers, before.vouchers);
});

test("review digest rejects changed identity, new grants, new payments and stale ownership without mutation", () => {
  for (const change of [s => { s.customers[1].pinHash = "new"; }, s => { s.customers[0].name = "Owner edited"; },
    s => s.wifiDeviceGrants.push({ id: "new", customerId: "duplicate" }),
    s => s.payments.push({ id: "late", customerId: "duplicate", status: "paid" })]) {
    const s = fixture(), expectedDigest = report(s).digest; change(s); const before = structuredClone(s);
    assert.throws(() => reconcileAccountState(s, { pepper, now, expectedDigest }), { code: "STALE_RECONCILIATION" });
    assert.deepEqual(s, before);
  }
});

test("digest survives JSONB object-key reordering", () => {
  const s = fixture(), reordered = JSON.parse(JSON.stringify(s), (_, v) => v && !Array.isArray(v) && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).reverse()) : v);
  assert.equal(report(s).digest, report(reordered).digest);
});

test("runner backs up affected rows privately, refuses existing backup, rolls back failures and supports no-op retry", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ndahi-reconciliation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createStore({ persistent: false }); await store.transaction(s => Object.assign(s, fixture()));
  const backupFile = join(dir, "before.json"), expectedDigest = report(await store.snapshot()).digest;
  const result = await runAccountReconciliation({ store, pepper, apply: true, expectedDigest, backupFile, now: () => now });
  assert.equal(result.removedCustomerCount, 1);
  const backup = await open(backupFile, "r");
  try {
    assert.equal((await backup.stat()).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await backup.readFile("utf8")).collections.payments.before[0].customerId, "duplicate");
  } finally { await backup.close(); }
  await store.transaction(s => Object.assign(s, fixture()));
  const before = await store.snapshot();
  await assert.rejects(runAccountReconciliation({ store, pepper, apply: true, expectedDigest, backupFile, now: () => now }), { code: "EEXIST" });
  assert.deepEqual(await store.snapshot(), before);
});

test("CLI refuses unguarded apply, ambiguous options and offline-file writes", () => {
  for (const args of [["--apply"], ["--apply", "--expected-digest", "a".repeat(64)], ["--file", "x", "--file", "y"],
    ["--apply", "--file", "x", "--expected-digest", "a".repeat(64), "--backup-file", "backup"]])
    assert.throws(() => parseReconciliationArguments(args), { code: "INVALID_ARGUMENTS" });
});
