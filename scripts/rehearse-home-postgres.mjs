import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import pg from "pg";
import { blank } from "../lib/api/state.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { applySchemaMigrations } from "./migrate-postgres.mjs";
const execute = promisify(execFile);

export function isolatedHomeRehearsalTarget(env) {
  if (env.HOME_REHEARSAL_CONFIRM !== "isolated-synthetic-home-restore") throw Error("Explicit isolated rehearsal confirmation required");
  const url = new URL(env.HOME_REHEARSAL_DATABASE_URL || "");
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres" ||
      [...url.searchParams.keys()].some(key => key !== "host") ||
      (url.searchParams.has("host") && !url.searchParams.get("host").startsWith("/")))
    throw Error("Use a private local test cluster's postgres database; production and remote targets are refused");
  return url;
}

export async function rehearseHomePostgres(env = process.env) {
  const target = isolatedHomeRehearsalTarget(env);
  const started = Date.now(), token = randomUUID().replaceAll("-", "");
  const sourceName = `ndahi_home_drill_src_${token}`, restoredName = `ndahi_home_drill_dst_${token}`;
  const admin = new pg.Client({ connectionString: target.href, ssl: false });
  const created = []; let source, restored, directory;
  try {
    await admin.connect();
    for (const name of [sourceName, restoredName]) { await admin.query(`CREATE DATABASE ${name}`); created.push(name); }
    const connection = name => { const u = new URL(target); u.pathname = "/" + name; return u.href; };
    source = new pg.Pool({ connectionString: connection(sourceName), ssl: false });
    restored = new pg.Pool({ connectionString: connection(restoredName), ssl: false });
    const client = await source.connect();
    try { await applySchemaMigrations(client); await applySchemaMigrations(client); } finally { client.release(); }
    const store = createPostgresStore({ pool: source, initialState: blank });
    const now = new Date(), expiresAt = new Date(+now + 86400000).toISOString();
    await store.transaction(s => {
      s.customers.push({ id: "home-drill", phone: "670050001" }, { id: "direct-drill", phone: "670050002" });
      s.payments.push({ id: "paid-drill", customerId: "home-drill", status: "paid", confirmedAt: now.toISOString(), amount: 250 });
      s.vouchers.push({ id: "home-voucher", customerId: "home-drill", paymentId: "paid-drill", code: "NC-HOME-0001", accessMode: "home", status: "active", expiresAt,
        quotaBytes: 1000, usedBytes: 130, homeGeneration: "drill-generation", homeAccounting: { epoch: "drill-epoch", base: 42, raw: 88 } },
      { id: "direct-voucher", customerId: "direct-drill", code: "NC-DIR1-0001", status: "active", usedBytes: 57, quotaBytes: 1000, expiresAt });
      s.homeConnections.push({ id: "drill-link", customerId: "home-drill", mac: "02:00:00:00:00:01", status: "linked" });
      s.homeChallenges.push({ id: "drill-challenge", customerId: "home-drill", status: "consumed" });
      s.homeOperations.push({ id: "drill-operation", customerId: "home-drill", kind: "refresh", status: "retry", nextAttemptAt: now.toISOString() });
      s.homeUsageObservations.push({ id: "drill-observation", customerId: "home-drill", type: "usage.high_water", usedBytes: 130 });
    });
    const before = await store.snapshot();
    await assert.rejects(store.transaction(s => { s.payments.length = 0; s.vouchers[0].usedBytes = 0; throw Error("drill rollback"); }));
    assert.deepEqual(await store.snapshot(), before);
    directory = await mkdtemp(join(tmpdir(), "ndahi-home-native-restore-"));
    const archive = join(directory, "synthetic-home.dump"), bin = env.HOME_PG_BIN || "";
    const childEnv = { ...process.env, PGHOST: target.searchParams.get("host") || target.hostname,
      PGPORT: target.port || "5432", PGSSLMODE: "disable", PGPASSFILE: "/dev/null" };
    if (target.username) childEnv.PGUSER = decodeURIComponent(target.username);
    if (target.password) childEnv.PGPASSWORD = decodeURIComponent(target.password);
    else delete childEnv.PGPASSWORD;
    // Keep credentials out of child command-line arguments and error output.
    await execute(bin ? join(bin, "pg_dump") : "pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file=" + archive, "--dbname=" + sourceName], { env: childEnv });
    const fingerprint = createHash("sha256").update(await readFile(archive)).digest("hex");
    await execute(bin ? join(bin, "pg_restore") : "pg_restore", ["--single-transaction", "--exit-on-error", "--no-owner", "--no-acl", "--dbname=" + restoredName, archive], { env: childEnv });
    const restoredStore = createPostgresStore({ pool: restored, initialState: blank });
    assert.deepEqual(await restoredStore.snapshot(), before);
    assert.equal((await restoredStore.homeSchemaReadiness()).status, "ready");
    return { status: "passed", evidenceKind: "synthetic-isolated-postgresql", format: "pg_dump-custom/pg_restore",
      elapsedMs: Date.now() - started, archiveSha256: fingerprint, paidHistoryPreserved: true,
      homeCollectionsPreserved: 4, directUsedBytes: 57, homeUsedBytes: 130,
      productionDatabaseTouched: false, productionEncryptedBackupTested: false };
  } finally {
    await source?.end(); await restored?.end();
    for (const name of created.reverse()) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await rehearseHomePostgres())); }
  catch { console.error(JSON.stringify({ status: "failed", code: "HOME_ISOLATED_RESTORE_REHEARSAL_FAILED" })); process.exitCode = 1; }
}
