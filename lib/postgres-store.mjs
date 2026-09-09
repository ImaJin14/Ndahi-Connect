import pg from "pg";
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
  ["events", "events", "application"],
  ["providerEvents", "events", "provider"],
  ["rateLimitEvents", "events", "rate_limit"],
  ["auditLogs", "audit_logs"],
];
const settings = ["bundleOverrides", "adminProfile", "zone"];
const entityId = (item, kind, index) => String(item.id ?? `${kind}-${index}`);

export async function readNormalizedState(client, initialState) {
  const state = initialState();
  for (const [key, table, kind] of collections) {
    const { rows } = await client.query(
      `SELECT payload FROM ${table}${kind ? " WHERE kind = $1" : ""} ORDER BY ordinal, id`,
      kind ? [kind] : [],
    );
    state[key] = rows.map(({ payload }) => payload);
  }
  const { rows } = await client.query("SELECT key, value FROM app_settings");
  for (const { key, value } of rows) if (settings.includes(key)) state[key] = value;
  return state;
}

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
          `INSERT INTO ${table} (id, ordinal, payload) VALUES ($1, $2, $3::jsonb)`,
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

export function createPostgresStore(
  { connectionString, initialState, ssl = true, pool: suppliedPool },
) {
  const pool = suppliedPool || new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: true } : false,
    max: 10,
  });
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
  return {
    load: snapshot,
    snapshot,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [731904001]);
        const state = await readNormalizedState(client, initialState), result = await fn(state);
        await replaceNormalizedState(client, state);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}

export const normalizedCollections = Object.freeze(collections.map(
  ([stateKey, table, kind]) => ({ stateKey, table, kind }),
));
