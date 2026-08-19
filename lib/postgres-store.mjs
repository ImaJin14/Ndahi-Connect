import pg from "pg";
const { Pool } = pg;

export function createPostgresStore(
  { connectionString, initialState, ssl = true },
) {
  const pool = new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: true } : false,
    max: 10,
  });
  let initialized;
  const initialize = () =>
    initialized ??= pool.query(`
    CREATE TABLE IF NOT EXISTS ndahi_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).then(() =>
        pool.query(
          "INSERT INTO ndahi_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
          [JSON.stringify(initialState())],
        )
      );
  async function snapshot() {
    await initialize();
    const { rows } = await pool.query(
      "SELECT data FROM ndahi_state WHERE id = 1",
    );
    return structuredClone(rows[0].data);
  }
  return {
    async load() {
      return snapshot();
    },
    async snapshot() {
      return snapshot();
    },
    async transaction(fn) {
      await initialize();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          "SELECT data FROM ndahi_state WHERE id = 1 FOR UPDATE",
        );
        const state = rows[0].data, result = await fn(state);
        await client.query(
          "UPDATE ndahi_state SET data = $1::jsonb, version = version + 1, updated_at = NOW() WHERE id = 1",
          [JSON.stringify(state)],
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
