import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
const { Pool } = pg;

const collections = [
  ["customers", "customers"], ["adminUsers", "admin_users"],
  ["bundles", "bundles"], ["payments", "payments"],
  ["vouchers", "vouchers"], ["sessions", "network_sessions"],
  ["dashboardSessions", "dashboard_sessions"],
  ["adminSessions", "admin_sessions"],
  ["adminPasskeyChallenges", "challenges", "admin_passkey"],
  ["customerPasskeyChallenges", "challenges", "customer_passkey"],
  ["customerMfaChallenges", "challenges", "customer_mfa"],
  ["customerAccessChallenges", "challenges", "customer_access"],
  ["pinResetChallenges", "challenges", "pin_reset"],
  ["adminLoginChallenges", "challenges", "admin_login"],
  ["otpChallenges", "challenges", "otp"],
  ["adminMfaChallenges", "challenges", "admin_mfa"],
  ["securityEvents", "events", "security"],
  ["securityAlerts", "events", "security_alert"],
  ["events", "events", "application"],
  ["providerEvents", "events", "provider"],
  ["routerCommands", "events", "router_command"],
  ["networkSetupJobs", "events", "network_setup_job"],
  ["rateLimitEvents", "events", "rate_limit"],
  ["auditLogs", "audit_logs"],
];
const settings = ["bundleOverrides", "adminProfile", "zone", "networkSetup"];
const entityId = (item, kind, index) => String(item.id ?? `${kind}-${index}`);

// Every store transaction takes this lock: exclusively for ordinary transactions,
// shared for scoped ones. Scoped transactions additionally lock their scope keys
// in a separate two-key namespace, so unrelated scopes run concurrently.
export const storeLockId = 731904001;
const scopeLockNamespace = 7319;
const retryableCodes = new Set(["STORE_CONFLICT", "40001", "40P01", "23505"]);

export class StoreConflictError extends Error {
  constructor(table, ids) {
    super(`Concurrent update detected in ${table}`);
    this.code = "STORE_CONFLICT";
    this.table = table;
    this.ids = ids;
  }
}

export async function readNormalizedState(client, initialState) {
  return (await readTracked(client, initialState)).state;
}

// Reads the requested collections in one round trip and remembers each row's
// database id, ordinal and serialized payload so only changes are written back.
async function readTracked(client, initialState, only) {
  const state = initialState(), tracked = new Map(), selected = collections
    .map((entry, index) => [entry, index])
    .filter(([[key]]) => !only || only.includes(key));
  const parts = [], params = [];
  for (const [[, table, kind], index] of selected) {
    if (kind) params.push(kind);
    parts.push(`SELECT ${index} AS c, id, ordinal, payload FROM ${table}${kind ? ` WHERE kind = $${params.length}` : ""}`);
  }
  const rows = parts.length
    ? (await client.query(`${parts.join(" UNION ALL ")} ORDER BY c, ordinal, id`, params)).rows
    : [];
  for (const [[key]] of selected) {
    state[key] = [];
    tracked.set(key, { rows: new Map(), identities: new WeakMap(), primitives: [] });
  }
  for (const { c, id, ordinal, payload } of rows) {
    const [key] = collections[c], entry = tracked.get(key);
    entry.rows.set(id, { ordinal, json: JSON.stringify(payload) });
    if (payload !== null && typeof payload === "object") entry.identities.set(payload, id);
    else entry.primitives.push({ id, json: JSON.stringify(payload) });
    state[key].push(payload);
  }
  const settingRows = new Map();
  if (!only) {
    const { rows: values } = await client.query("SELECT key, value FROM app_settings");
    for (const { key, value } of values) {
      if (!settings.includes(key)) continue;
      state[key] = value;
      settingRows.set(key, JSON.stringify(value));
    }
  }
  return { state, tracked, settingRows };
}

// Items keep their database id when they carry an id, are the same object that
// was read, or (for primitive payloads) match an unclaimed stored value.
function identify(items, entry, kind) {
  const seen = new Set(), unclaimed = [...entry.primitives];
  return items.map((item) => {
    let id;
    if (item !== null && typeof item === "object") {
      id = item.id != null ? String(item.id) : entry.identities.get(item) ?? `${kind}-${randomUUID()}`;
    } else {
      const json = JSON.stringify(item), index = unclaimed.findIndex((row) => row.json === json);
      id = index >= 0 ? unclaimed.splice(index, 1)[0].id : `${kind}-${randomUUID()}`;
    }
    if (seen.has(id)) throw new Error(`Duplicate ${kind} id ${id}`);
    seen.add(id);
    return { id, json: JSON.stringify(item), previous: entry.rows.get(id) };
  });
}

// Preserve existing ordinals and place new rows around them. Prepends take
// ordinals below the first retained row and appends above the last one, so the
// common unshift/push/slice patterns never rewrite unrelated rows.
function assignOrdinals(items) {
  const retained = items.flatMap((item, index) => (item.previous ? [index] : []));
  const renumber = () => items.forEach((item, index) => { item.ordinal = index; });
  if (!retained.length) return renumber();
  for (let i = 1; i < retained.length; i++) {
    if (items[retained[i]].previous.ordinal < items[retained[i - 1]].previous.ordinal) return renumber();
  }
  for (const index of retained) items[index].ordinal = items[index].previous.ordinal;
  const first = retained[0], last = retained.at(-1);
  for (let index = 0; index < first; index++) items[index].ordinal = items[first].ordinal - (first - index);
  for (let index = last + 1; index < items.length; index++) items[index].ordinal = items[last].ordinal + (index - last);
  for (let r = 0; r < retained.length - 1; r++) {
    const low = retained[r], high = retained[r + 1];
    if (high - low === 1) continue;
    const start = items[low].ordinal, room = items[high].ordinal - start - 1;
    if (room < high - low - 1) return renumber();
    for (let index = low + 1; index < high; index++) items[index].ordinal = start + (index - low);
  }
}

export function planChanges(tracked, settingRows, state) {
  const plan = [];
  for (const [key, table, kind] of collections) {
    const entry = tracked.get(key);
    if (!entry) continue;
    const items = identify(Array.isArray(state[key]) ? state[key] : [], entry, kind || key);
    assignOrdinals(items);
    const present = new Set(items.map(({ id }) => id));
    const deletes = [...entry.rows].filter(([id]) => !present.has(id))
      .map(([id, row]) => ({ id, prev: JSON.parse(row.json) }));
    const updates = items.filter(({ previous, json, ordinal }) =>
      previous && (previous.json !== json || previous.ordinal !== ordinal))
      .map(({ id, previous, json, ordinal }) => ({ id, ordinal, prev: JSON.parse(previous.json), next: JSON.parse(json) }));
    const inserts = items.filter(({ previous }) => !previous)
      .map(({ id, json, ordinal }) => ({ id, ordinal, next: JSON.parse(json) }));
    if (deletes.length || updates.length || inserts.length) plan.push({ table, kind, deletes, updates, inserts });
  }
  const settingChanges = [];
  if (settingRows) {
    for (const key of settings) {
      const json = JSON.stringify(state[key] ?? null), previous = settingRows.get(key);
      if (previous !== json) settingChanges.push({ key, prev: previous, next: json });
    }
  }
  return { plan, settingChanges };
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Every write is guarded by the payload that was read. A row changed or created
// by another transaction raises StoreConflictError instead of being overwritten.
async function applyChanges(client, { plan, settingChanges }) {
  const scope = (kind, offset) => (kind ? ` AND t.kind = $${offset}` : "");
  const args = (rows, kind) => [JSON.stringify(rows.sort(byId)), ...(kind ? [kind] : [])];
  for (const { table, kind, deletes } of plan) {
    if (!deletes.length) continue;
    const { rows } = await client.query(
      `DELETE FROM ${table} t USING jsonb_to_recordset($1::jsonb) AS d(id text, prev jsonb)
       WHERE t.id = d.id AND t.payload = d.prev${scope(kind, 2)} RETURNING t.id`,
      args(deletes, kind),
    );
    if (rows.length === deletes.length) continue;
    // A row that is already gone is the intended outcome; a changed row is a conflict.
    const removed = new Set(rows.map(({ id }) => id)),
      missing = deletes.filter(({ id }) => !removed.has(id)).map(({ id }) => id),
      { rows: remaining } = await client.query(
        `SELECT id FROM ${table} t WHERE t.id = ANY($1::text[])${scope(kind, 2)}`,
        [missing, ...(kind ? [kind] : [])],
      );
    if (remaining.length) throw new StoreConflictError(table, remaining.map(({ id }) => id));
  }
  for (const { table, kind, updates } of plan) {
    if (!updates.length) continue;
    const { rows } = await client.query(
      `UPDATE ${table} t SET payload = u.next, ordinal = u.ordinal
       FROM jsonb_to_recordset($1::jsonb) AS u(id text, ordinal integer, prev jsonb, next jsonb)
       WHERE t.id = u.id AND t.payload = u.prev${scope(kind, 2)} RETURNING t.id`,
      args(updates, kind),
    );
    if (rows.length !== updates.length) {
      const done = new Set(rows.map(({ id }) => id));
      throw new StoreConflictError(table, updates.filter(({ id }) => !done.has(id)).map(({ id }) => id));
    }
  }
  for (const { table, kind, inserts } of plan) {
    if (!inserts.length) continue;
    const { rows } = await client.query(
      kind
        ? `INSERT INTO ${table} (kind, id, ordinal, payload)
           SELECT $2, i.id, i.ordinal, i.next FROM jsonb_to_recordset($1::jsonb) AS i(id text, ordinal integer, next jsonb)
           ON CONFLICT DO NOTHING RETURNING id`
        : `INSERT INTO ${table} (id, ordinal, payload)
           SELECT i.id, i.ordinal, i.next FROM jsonb_to_recordset($1::jsonb) AS i(id text, ordinal integer, next jsonb)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
      args(inserts, kind),
    );
    if (rows.length !== inserts.length) {
      const done = new Set(rows.map(({ id }) => id));
      throw new StoreConflictError(table, inserts.filter(({ id }) => !done.has(id)).map(({ id }) => id));
    }
  }
  for (const { key, prev, next } of settingChanges) {
    const { rowCount } = prev === undefined
      ? await client.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [key, next],
      )
      : await client.query(
        "UPDATE app_settings SET value = $2::jsonb, updated_at = NOW() WHERE key = $1 AND value = $3::jsonb",
        [key, next, prev],
      );
    if (!rowCount) throw new StoreConflictError("app_settings", [key]);
  }
}

// Full rewrite used by offline migration and rollback tooling only.
export async function replaceNormalizedState(client, state) {
  for (const table of [
    "network_sessions", "dashboard_sessions", "admin_sessions", "challenges",
    "vouchers", "payments", "events", "audit_logs", "bundles", "admin_users",
    "customers",
  ]) await client.query(`DELETE FROM ${table}`);
  for (const [key, table, kind] of collections) {
    const values = Array.isArray(state[key]) ? state[key] : [];
    for (let ordinal = 0; ordinal < values.length; ordinal++) {
      const item = values[ordinal], id = entityId(item, kind || key, ordinal);
      if (kind) {
        await client.query(
          `INSERT INTO ${table} (kind, id, ordinal, payload) VALUES ($1, $2, $3, $4::jsonb)`,
          [kind, id, ordinal, JSON.stringify(item)],
        );
      } else {
        await client.query(
          `INSERT INTO ${table} (id, ordinal, payload) VALUES ($1, $2, $3, $4::jsonb)`,
          [id, ordinal, JSON.stringify(item)],
        );
      }
    }
  }
  for (const key of settings) {
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(state[key] ?? null)],
    );
  }
}

const scopeLockKey = (key) => createHash("sha256").update(key).digest().readInt32BE(0);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPostgresStore(
  { connectionString, initialState, ssl = true, pool: suppliedPool, maxAttempts = 5 },
) {
  const pool = suppliedPool || new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: true } : false,
    max: 10,
  });
  // Keep readiness independent of busy request/worker connections and write locks.
  const healthPool = suppliedPool || new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: true } : false,
    max: 1,
    connectionTimeoutMillis: 1500,
    statement_timeout: 1500,
    query_timeout: 2000,
  });
  const stats = { committed: 0, retried: 0, conflicts: 0 };
  async function snapshot() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = await readNormalizedState(client, initialState);
      await client.query("COMMIT");
      return structuredClone(state);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async function attempt(fn, scope, scopeFrom) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (scope === undefined) {
        await client.query("SELECT pg_advisory_xact_lock($1)", [storeLockId]);
      } else {
        await client.query("SELECT pg_advisory_xact_lock_shared($1)", [storeLockId]);
        const keys = typeof scope === "function"
          ? await scope((await readTracked(client, initialState, scopeFrom)).state)
          : scope;
        // Sorted acquisition prevents deadlocks between overlapping scopes.
        const locks = [...new Set((keys || []).filter(Boolean).map(String))].map(scopeLockKey).sort((a, b) => a - b);
        for (const lock of new Set(locks)) {
          await client.query("SELECT pg_advisory_xact_lock($1, $2)", [scopeLockNamespace, lock]);
        }
      }
      const { state, tracked, settingRows } = await readTracked(client, initialState);
      const result = await fn(state);
      await applyChanges(client, planChanges(tracked, settingRows, state));
      await client.query("COMMIT");
      stats.committed++;
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return {
    load: snapshot,
    snapshot,
    stats,
    async healthCheck() {
      const tables = [...new Set(collections.map(([, table]) => table)), "app_settings"];
      // Resolve every required relation and check SELECT privileges without reading rows.
      await healthPool.query(tables.map((table) => `SELECT 1 FROM ${table} WHERE false`).join(" UNION ALL "));
    },
    // Without a scope the transaction is serialized against all others. With a
    // scope (keys, or a function deriving keys from the collections in
    // scopeFrom) it runs concurrently with transactions on other scopes and is
    // retried on a write conflict, so its callback must be free of external
    // side effects.
    async transaction(fn, { scope, scopeFrom } = {}) {
      for (let tries = 1; ; tries++) {
        try {
          return await attempt(fn, scope, scopeFrom);
        } catch (error) {
          if (error.code === "STORE_CONFLICT") stats.conflicts++;
          if (scope === undefined || tries >= maxAttempts || !retryableCodes.has(error.code)) throw error;
          stats.retried++;
          await pause(Math.random() * 10 * tries);
        }
      }
    },
    async close() {
      await pool.end();
      if (healthPool !== pool) await healthPool.end();
    },
  };
}

export const normalizedCollections = Object.freeze(collections.map(
  ([stateKey, table, kind]) => ({ stateKey, table, kind }),
));
