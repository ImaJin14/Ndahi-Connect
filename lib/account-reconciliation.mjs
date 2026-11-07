import { createHmac, randomUUID } from "node:crypto";
import { normalizeCameroonPhone as phone, validCameroonPhone } from "../shared-app/cameroon-phone.js";
import { normalizeEmail, linkedEmail } from "./email-state.mjs";
import { establishedCustomer } from "./authentication-migration.mjs";
import { activeSubscription } from "./subscription-policy.mjs";

const authCollections = ["dashboardSessions", "customerPasskeyChallenges", "customerMfaChallenges",
  "customerAccessChallenges", "otpChallenges", "pinResetChallenges"];
const protectedCollections = ["wifiPairingRequests", "wifiDeviceGrants", "wifiAppAssociations",
  "homeConnections", "homeChallenges", "homeOperations", "homeUsageObservations", "notificationStates"];
const shellFields = new Set(["id", "phone", "name", "email", "emailVerificationRequired", "createdAt", "status", "phoneVerified", "updatedAt"]);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const rows = (s, key) => s[key] || [];
const hasSecurity = c => establishedCustomer(c) || Boolean(c.phoneVerified === true || linkedEmail(c) || c.pendingEmail || c.wifiMainDevice ||
  c.wifiFirstConnectedAt || c.accountBackupCodes?.length || c.recoveryCodes?.length || c.authMigration ||
  c.pushSubscriptions?.length || c.accessModeIntent === "home");

export class AccountReconciliationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Inventory is deliberately independent of payerPhone: a payer does not own an account. */
export function accountReconciliationReport(s, { pepper, now = new Date() } = {}) {
  if (!pepper) throw new AccountReconciliationError("SECRET_PEPPER_REQUIRED", "Use the target API's configured pepper.");
  const groups = new Map(), invalidCustomerIds = [], operations = [], review = [];
  for (const c of rows(s, "customers")) {
    const number = phone(c.phone);
    if (!validCameroonPhone(number)) { invalidCustomerIds.push(c.id); continue; }
    if (!groups.has(number)) groups.set(number, []);
    groups.get(number).push(c);
  }
  const duplicateGroups = [];
  for (const [number, customers] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    customers.sort((a, b) => (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    const [original, ...duplicates] = customers, ids = customers.map(c => c.id), idSet = new Set(ids);
    const payments = rows(s, "payments").filter(p => idSet.has(p.customerId));
    const vouchers = rows(s, "vouchers").filter(v => idSet.has(v.customerId));
    if (!duplicates.length) {
      if (original.phone !== number) {
        if (original.pendingEmail) review.push({ customerIds: ids, reason: "PENDING_PROFILE_EDIT" });
        else operations.push({ type: "normalize_phone", customerId: original.id, phone: number });
      }
      continue;
    }
    const duplicateIds = new Set(duplicates.map(c => c.id)), reasons = [];
    const times = customers.map(c => Date.parse(c.createdAt));
    if (times.some(t => !Number.isFinite(t)) || times.filter(t => t === times[0]).length !== 1) reasons.push("ORIGINAL_ACCOUNT_UNCERTAIN");
    if (!establishedCustomer(original)) reasons.push("ORIGINAL_CREDENTIAL_REQUIRED");
    if (duplicates.some(hasSecurity)) reasons.push("DUPLICATE_HAS_IDENTITY_OR_ACCESS");
    if (duplicates.some(c => Object.keys(c).some(key => !shellFields.has(key)))) reasons.push("DUPLICATE_HAS_ADDITIONAL_ACCOUNT_STATE");
    if (customers.some(c => c.suspended || c.status === "suspended")) reasons.push("SUSPENDED_ACCOUNT");
    if (original.pendingEmail) reasons.push("PENDING_PROFILE_EDIT");
    if (protectedCollections.some(key => rows(s, key).some(row => duplicateIds.has(row.customerId)))) reasons.push("DUPLICATE_HAS_DEVICE_OR_HOME_STATE");
    if (payments.some(p => !["paid", "refunded", "failed", "cancelled", "expired"].includes(p.status) ||
      ["failed", "cancelled", "expired"].includes(p.status) && p.provider !== "mock" && !p.providerFailedAt ||
      p.fulfillmentStatus === "needs_review" || p.refund && p.refund.status !== "completed" || p.guestSetup && !p.guestSetup.usedAt && Date.parse(p.guestSetup.expiresAt) > +now)) reasons.push("UNSETTLED_PAYMENT_OR_SETUP");
    if (customers.filter(c => activeSubscription(s, c.id, now)).length > 1) reasons.push("OVERLAPPING_ACTIVE_BUNDLES");
    if (vouchers.some(v => v.paymentId && rows(s, "payments").some(p => p.id === v.paymentId && !idSet.has(p.customerId)))) reasons.push("CROSS_ACCOUNT_PAYMENT_LINK");
    if (payments.some(p => rows(s, "vouchers").some(v => v.paymentId === p.id && v.customerId && !idSet.has(v.customerId)))) reasons.push("CROSS_ACCOUNT_VOUCHER_LINK");
    duplicateGroups.push({ customerIds: ids, originalCustomerId: original.id, phoneSuffix: number.slice(-3),
      differentNames: new Set(customers.map(c => c.name || "")).size > 1,
      differentEmails: new Set(customers.map(c => normalizeEmail(c.email))).size > 1,
      paymentCount: payments.length, voucherCount: vouchers.length, reasons });
    if (reasons.length) review.push({ customerIds: ids, reasons });
    else operations.push({ type: "merge_unclaimed_duplicates", customerId: original.id, duplicateIds: [...duplicateIds], phone: number });
  }
  const customersById = new Map(rows(s, "customers").map(c => [c.id, c]));
  let historicalCheckoutDifferences = 0;
  const orphanedPaymentIds = [], mismatchedVoucherIds = [];
  for (const p of rows(s, "payments")) {
    const c = customersById.get(p.customerId);
    if (!c) orphanedPaymentIds.push(p.id);
    else if (p.guestCheckoutDetails && (p.guestCheckoutDetails.name !== (c.name || "") ||
      normalizeEmail(p.guestCheckoutDetails.email) !== normalizeEmail(c.email))) historicalCheckoutDifferences++;
  }
  const paymentsById = new Map(rows(s, "payments").map(p => [p.id, p]));
  for (const v of rows(s, "vouchers")) {
    const p = paymentsById.get(v.paymentId);
    if (v.customerId && (!customersById.has(v.customerId) || p && p.customerId !== v.customerId)) mismatchedVoucherIds.push(v.id);
  }
  // Bind the reviewed plan to account identity, credentials and all affected
  // ownership references. Stable keys survive PostgreSQL JSONB round trips.
  const affected = new Set(operations.flatMap(op => [op.customerId, ...(op.duplicateIds || [])]));
  const evidence = Object.fromEntries(["customers", "payments", "vouchers", ...authCollections, ...protectedCollections].map(key => [key,
    rows(s, key).filter(row => key === "customers" ? affected.has(row.id) : affected.has(row.customerId) ||
      authCollections.includes(key) && [...affected].some(id => phone(customersById.get(id)?.phone) === phone(row.phone)))
      .map(stable).sort((a, b) => String(a.id || a.tokenHash || "").localeCompare(String(b.id || b.tokenHash || "")))]));
  const digest = createHmac("sha256", pepper).update(JSON.stringify(stable({ operations, review, evidence, invalidCustomerIds, orphanedPaymentIds, mismatchedVoucherIds }))).digest("hex");
  return { version: 1, digest, customerCount: rows(s, "customers").length, duplicateGroups,
    repairs: operations.map(({ phone: number, ...op }) => ({ ...op, phoneSuffix: number.slice(-3) })),
    review, invalidCustomerIds, orphanedPaymentIds, mismatchedVoucherIds, historicalCheckoutDifferences,
    note: "Historical checkout differences are retained transaction evidence, not authority to overwrite a profile or reassign a payer's purchases." };
}

/** Called only inside the store's exclusive transaction after exact-digest review. */
export function reconcileAccountState(s, { pepper, expectedDigest, now = new Date(), actor = "operator" } = {}) {
  const report = accountReconciliationReport(s, { pepper, now });
  if (!/^[a-f0-9]{64}$/.test(expectedDigest || "") || expectedDigest !== report.digest)
    throw new AccountReconciliationError("STALE_RECONCILIATION", "The reviewed inventory changed. Generate and review a fresh report.");
  const before = structuredClone(s), changed = new Set(), removed = new Set();
  for (const op of report.repairs) {
    const c = s.customers.find(c => c.id === op.customerId), ids = new Set([c.id, ...(op.duplicateIds || [])]);
    const numbers = new Set(before.customers.filter(c => ids.has(c.id)).map(c => phone(c.phone)));
    const voucherIds = new Set(rows(s, "vouchers").filter(v => ids.has(v.customerId)).map(v => v.id));
    for (const key of authCollections) s[key] = rows(s, key).filter(row =>
      !ids.has(row.customerId) && !numbers.has(phone(row.phone)) && !voucherIds.has(row.voucherId));
    c.phone = phone(c.phone); changed.add(c.id);
    if (op.duplicateIds) {
      const sources = new Set(op.duplicateIds);
      for (const key of ["payments", "vouchers"]) for (const row of rows(s, key))
        if (sources.has(row.customerId)) row.customerId = c.id;
      s.customers = s.customers.filter(row => !sources.has(row.id));
      for (const id of sources) removed.add(id);
    }
  }
  if (changed.size) {
    s.auditLogs ||= [];
    s.auditLogs.unshift({ id: randomUUID(), action: "customer.accounts_reconciled", actor, at: now.toISOString(),
      meta: { version: 1, digest: report.digest, customerIds: [...changed], removedCustomerIds: [...removed], repairs: report.repairs } });
  }
  // Back up only changed rows, including revoked sessions/challenges. The runner
  // writes this private artifact before the database commit; it is never logged.
  const backup = { version: 1, digest: report.digest, at: now.toISOString(), collections: {} };
  for (const key of Object.keys(before)) {
    if (!Array.isArray(before[key]) || same(before[key], s[key])) continue;
    backup.collections[key] = { before: before[key].filter(row => !rows(s, key).some(after => same(row, after))),
      after: rows(s, key).filter(row => !before[key].some(prior => same(row, prior))) };
  }
  return { report, changedCustomerCount: changed.size, removedCustomerCount: removed.size, backup };
}
