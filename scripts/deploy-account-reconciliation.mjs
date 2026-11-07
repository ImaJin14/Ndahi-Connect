import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountReconciliationReport, reconcileAccountState } from "../lib/account-reconciliation.mjs";

const purpose = "ndahi-account-reconciliation-backup-v1";
const key = pepper => createHmac("sha256", pepper).update(purpose).digest();
export function sealAccountBackup(value, pepper) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(pepper), iv);
  cipher.setAAD(Buffer.from(purpose));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}
export function openAccountBackup(value, pepper) {
  const cipher = createDecipheriv("aes-256-gcm", key(pepper), Buffer.from(value.iv, "base64"));
  cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, "base64")), cipher.final()]).toString());
}

/** One explicitly authorized versioned repair, in the service's private environment. */
export async function deployAccountReconciliation({ store, pepper, now = () => new Date() }) {
  if (!pepper) throw Error("Target API pepper is required.");
  return store.transaction(s => {
    if (s.zone?.accountReconciliation?.version === 1) return { ...s.zone.accountReconciliation.summary, alreadyApplied: true };
    const at = now(), reviewed = accountReconciliationReport(s, { pepper, now: at });
    // The same strict policy as the reviewed CLI: only unambiguous shells can
    // merge. Competing credentials, access, pending payments and profile edits
    // remain untouched. The exclusive lock binds inventory, repair and backup.
    const result = reconcileAccountState(s, { pepper, now: at, expectedDigest: reviewed.digest, actor: "deployment:account-reconciliation-v1" });
    const after = accountReconciliationReport(s, { pepper, now: at });
    const reviewCount = after.review.length + after.invalidCustomerIds.length + after.orphanedPaymentIds.length + after.mismatchedVoucherIds.length;
    const summary = { version: 1, status: reviewCount ? "needs_review" : "complete", completedAt: at.toISOString(),
      changedCustomerCount: result.changedCustomerCount, mergedCustomerCount: result.removedCustomerCount,
      reviewCount, historicalCheckoutDifferences: after.historicalCheckoutDifferences };
    s.zone ||= {};
    s.zone.accountReconciliation = { version: 1, summary,
      ...(result.changedCustomerCount ? { backup: sealAccountBackup(result.backup, pepper) } : {}) };
    s.auditLogs ||= [];
    s.auditLogs.unshift({ id: "account-reconciliation-deployment-v1", action: "customer.reconciliation_inventory_completed",
      actor: "deployment", at: at.toISOString(), meta: summary });
    return summary;
  });
}

async function main() {
  let store;
  try {
    if (process.env.NODE_ENV !== "production") { console.log("Deployment account reconciliation: local/test startup skipped."); return; }
    if (!process.env.DATABASE_URL || !process.env.SECRET_PEPPER) throw Error("Use the API's existing database and pepper configuration.");
    const { blank } = await import("../lib/api/state.mjs"), { createPostgresStore } = await import("../lib/postgres-store.mjs");
    store = createPostgresStore({ connectionString: process.env.DATABASE_URL, initialState: blank, ssl: process.env.DATABASE_SSL !== "false" });
    console.log(JSON.stringify(await deployAccountReconciliation({ store, pepper: process.env.SECRET_PEPPER })));
  } catch {
    console.error("Account reconciliation was not confirmed; deployment stopped. Check the existing service configuration and retained database inventory.");
    process.exitCode = 1;
  } finally { await store?.close?.(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
