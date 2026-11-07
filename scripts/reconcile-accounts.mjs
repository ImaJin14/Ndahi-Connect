import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountReconciliationError, accountReconciliationReport, reconcileAccountState } from "../lib/account-reconciliation.mjs";

export function parseReconciliationArguments(args) {
  const result = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--apply") result.apply = true;
    else if (flag === "--help") result.help = true;
    else if (["--file", "--expected-digest", "--backup-file"].includes(flag) && args[i + 1] && !args[i + 1].startsWith("--")) {
      const key = { "--file": "file", "--expected-digest": "expectedDigest", "--backup-file": "backupFile" }[flag];
      if (result[key]) throw new AccountReconciliationError("INVALID_ARGUMENTS", "An argument was supplied twice.");
      result[key] = args[++i];
    } else throw new AccountReconciliationError("INVALID_ARGUMENTS", "Unknown or incomplete reconciliation argument.");
  }
  if (result.apply && (result.file || !/^[a-f0-9]{64}$/.test(result.expectedDigest || "") || !result.backupFile))
    throw new AccountReconciliationError("INVALID_ARGUMENTS", "Apply requires PostgreSQL, --expected-digest and a new --backup-file path.");
  return result;
}

export async function runAccountReconciliation({ store, pepper, apply = false, expectedDigest, backupFile, now = () => new Date() }) {
  if (!apply) return { mode: "report", ...accountReconciliationReport(await store.snapshot(), { pepper, now: now() }) };
  if (!backupFile) throw new AccountReconciliationError("BACKUP_REQUIRED", "Apply requires a new private backup-file path.");
  return store.transaction(async s => {
    const result = reconcileAccountState(s, { pepper, expectedDigest, now: now() });
    if (result.changedCustomerCount) {
      // Exclusive creation prevents overwriting the original repair evidence.
      // Failure rolls back the database transaction. No callbacks are retried.
      await writeFile(backupFile, JSON.stringify(result.backup), { flag: "wx", mode: 0o600 });
    }
    return { mode: "apply", digest: result.report.digest, changedCustomerCount: result.changedCustomerCount,
      removedCustomerCount: result.removedCustomerCount, remaining: accountReconciliationReport(s, { pepper, now: now() }) };
  });
}

async function main() {
  let store;
  try {
    const args = parseReconciliationArguments(process.argv.slice(2));
    if (args.help) { console.log("Usage: node scripts/reconcile-accounts.mjs [--file OFFLINE_JSON]\nDefault: read-only PostgreSQL inventory. Apply: --apply --expected-digest DIGEST --backup-file NEW_PRIVATE_PATH\nRequires the API's DATABASE_URL, DATABASE_SSL and SECRET_PEPPER. No workers, providers or schema migrations are started."); return; }
    if (args.file) store = { snapshot: async () => JSON.parse(await readFile(args.file, "utf8")) };
    else {
      if (!process.env.DATABASE_URL) throw new AccountReconciliationError("DATABASE_URL_REQUIRED", "Run in the target API's configured environment.");
      const { createPostgresStore } = await import("../lib/postgres-store.mjs");
      const { blank } = await import("../lib/api/state.mjs");
      store = createPostgresStore({ connectionString: process.env.DATABASE_URL, initialState: blank, ssl: process.env.DATABASE_SSL !== "false" });
    }
    console.log(JSON.stringify(await runAccountReconciliation({ store, pepper: process.env.SECRET_PEPPER, ...args }), null, 2));
  } catch (error) {
    console.error(JSON.stringify(error instanceof AccountReconciliationError ? { code: error.code, error: error.message }
      : { code: "RECONCILIATION_FAILED", error: "No reconciliation was confirmed. Check target access and the private backup artifact before retrying." }));
    process.exitCode = 1;
  } finally { await store?.close?.(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
