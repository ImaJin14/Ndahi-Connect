import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authenticationReadiness, authenticatorRetired } from "../lib/authentication-migration.mjs";
import { AuthenticatorRetirementError, retireAuthenticatorState } from "../lib/authenticator-retirement.mjs";

export function parseRetirementArguments(args) {
  const result = { apply: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--apply") result.apply = true;
    else if (flag === "--help") result.help = true;
    else if (["--file", "--expected-digest"].includes(flag) && args[index + 1] && !args[index + 1].startsWith("--")) {
      const key = flag === "--file" ? "file" : "expectedDigest";
      if (result[key] !== undefined) throw new AuthenticatorRetirementError("INVALID_ARGUMENTS", "A retirement argument was supplied more than once.");
      result[key] = args[++index];
    } else throw new AuthenticatorRetirementError("INVALID_ARGUMENTS", "Unknown or incomplete retirement argument.");
  }
  if (result.apply && !/^[a-f0-9]{64}$/.test(result.expectedDigest || "")) {
    throw new AuthenticatorRetirementError("EXPECTED_DIGEST_REQUIRED", "--apply requires --expected-digest with the exact reviewed digest.");
  }
  return result;
}

/** Report uses snapshot only; apply rechecks under the store's exclusive lock. */
export async function runAuthenticatorRetirement({ store, pepper, now = () => new Date(), apply = false, expectedDigest }) {
  if (!pepper) throw new AuthenticatorRetirementError("SECRET_PEPPER_REQUIRED", "Use the same configured pepper as the target API.");
  if (apply) {
    if (!/^[a-f0-9]{64}$/.test(expectedDigest || "")) throw new AuthenticatorRetirementError("EXPECTED_DIGEST_REQUIRED", "Apply requires the exact reviewed digest.");
    // No scoped transaction: serialize the inventory check, deletion and marker
    // against every customer/admin credential mutation. Return only after commit.
    const result = await store.transaction((s) => retireAuthenticatorState(s, { pepper, now: now(), expectedDigest }));
    return { mode: "apply", ...result };
  }
  const state = await store.snapshot();
  return { mode: "report", retired: authenticatorRetired(state), readiness: authenticationReadiness(state, { pepper, now: now() }) };
}

async function main() {
  let store;
  try {
    const args = parseRetirementArguments(process.argv.slice(2));
    if (args.help) {
      console.log("Usage: node scripts/authenticator-retirement.mjs [--file JSON_PATH] [--apply --expected-digest DIGEST]\nDefault: read-only readiness report; DATABASE_URL selects PostgreSQL unless --file is explicit.");
      return;
    }
    if (!process.env.SECRET_PEPPER) throw new AuthenticatorRetirementError("SECRET_PEPPER_REQUIRED", "Use the same configured pepper as the target API.");
    const { blank, createStore } = await import("../lib/api/state.mjs");
    if (process.env.DATABASE_URL && !args.file) {
      const { createPostgresStore } = await import("../lib/postgres-store.mjs");
      // snapshot() executes BEGIN ... READ ONLY; construction does not migrate,
      // normalize, seed, start workers or perform any database writes.
      store = createPostgresStore({ connectionString: process.env.DATABASE_URL, initialState: blank, ssl: process.env.DATABASE_SSL !== "false" });
    } else store = createStore({ file: args.file || resolve("data/db.json") });
    console.log(JSON.stringify(await runAuthenticatorRetirement({ store, pepper: process.env.SECRET_PEPPER,
      apply: args.apply, expectedDigest: args.expectedDigest }), null, 2));
  } catch (error) {
    // Database/credential errors can contain secrets; expose only our allowlisted
    // domain error fields or a generic operational failure.
    const result = error instanceof AuthenticatorRetirementError
      ? { code: error.code, error: error.message, ...(error.blockers.length ? { blockers: error.blockers } : {}) }
      : { code: "RETIREMENT_FAILED", error: "Retirement did not complete. Check target access, state and configuration." };
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  } finally {
    try { await store?.close?.(); }
    catch {
      console.error(JSON.stringify({ code: "RETIREMENT_CLOSE_FAILED", error: "Target-store cleanup failed. Recheck the recorded migration status before retrying." }));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
