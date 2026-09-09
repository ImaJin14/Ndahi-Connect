export const retentionPolicy = Object.freeze({
  expiredSessionsDays: 7,
  expiredChallengesDays: 7,
  rateLimitEventsDays: 7,
  inactiveNetworkSessionsDays: 90,
  applicationEventsDays: 365,
  securityEventsDays: 365,
  auditLogsDays: 730,
  providerEventsDays: 730,
  paymentsOnlineDays: 2555,
  dormantCustomerReviewDays: 730,
  operationalArchiveDays: 730,
  auditAndPaymentArchiveDays: 2555,
});

const cutoff = (now, days) => new Date(now.getTime() - days * 86400_000).toISOString();

async function archiveAndDelete(client, {
  table, sourceTable = table, keySql = "id", deleteKeySql = "target.id",
  where, params, archiveDays, now,
}) {
  const expiry = new Date(now.getTime() + archiveDays * 86400_000).toISOString();
  const { rows } = await client.query(`
    WITH eligible AS (
      SELECT *, (${keySql})::text AS archive_key FROM ${table} WHERE ${where}
      FOR UPDATE SKIP LOCKED
    ), archived AS (
      INSERT INTO retention_archives (source_table, source_key, record, expires_at)
      SELECT $1, archive_key, to_jsonb(eligible) - 'archive_key', $2::timestamptz FROM eligible
      ON CONFLICT (source_table, source_key) DO NOTHING
      RETURNING source_key
    ), removed AS (
      DELETE FROM ${table} target USING archived
      WHERE (${deleteKeySql})::text = archived.source_key
      RETURNING 1
    ) SELECT COUNT(*)::int AS count FROM removed
  `, [sourceTable, expiry, ...params]);
  return rows[0].count;
}

export async function runRetention(client, now = new Date()) {
  const p = retentionPolicy, counts = {};
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [731904003]);
    counts.expiredDashboardSessions = (await client.query(
      "DELETE FROM dashboard_sessions WHERE (payload->>'expiresAt')::timestamptz < $1::timestamptz RETURNING 1",
      [cutoff(now, p.expiredSessionsDays)],
    )).rowCount;
    counts.expiredAdminSessions = (await client.query(
      "DELETE FROM admin_sessions WHERE (payload->>'expiresAt')::timestamptz < $1::timestamptz RETURNING 1",
      [cutoff(now, p.expiredSessionsDays)],
    )).rowCount;
    counts.expiredChallenges = (await client.query(
      "DELETE FROM challenges WHERE (payload->>'expiresAt')::timestamptz < $1::timestamptz RETURNING 1",
      [cutoff(now, p.expiredChallengesDays)],
    )).rowCount;
    counts.rateLimitEvents = (await client.query(
      "DELETE FROM events WHERE kind = 'rate_limit' AND (payload->>'at')::timestamptz < $1::timestamptz RETURNING 1",
      [cutoff(now, p.rateLimitEventsDays)],
    )).rowCount;
    counts.networkSessions = await archiveAndDelete(client, {
      table: "network_sessions", where: "payload->>'status' <> 'online' AND COALESCE(payload->>'disconnectedAt', payload->>'lastSeenAt', payload->>'connectedAt')::timestamptz < $3::timestamptz",
      params: [cutoff(now, p.inactiveNetworkSessionsDays)], archiveDays: p.operationalArchiveDays, now,
    });
    for (const [name, kind, days, archiveDays] of [
      ["applicationEvents", "application", p.applicationEventsDays, p.operationalArchiveDays],
      ["securityEvents", "security", p.securityEventsDays, p.operationalArchiveDays],
      ["providerEvents", "provider", p.providerEventsDays, p.auditAndPaymentArchiveDays],
    ]) counts[name] = await archiveAndDelete(client, {
      table: "events", sourceTable: `events:${kind}`, keySql: "kind || ':' || id",
      deleteKeySql: "target.kind || ':' || target.id",
      where: "kind = $3 AND occurred_at IS NOT NULL AND occurred_at::timestamptz < $4::timestamptz",
      params: [kind, cutoff(now, days)], archiveDays, now,
    });
    counts.auditLogs = await archiveAndDelete(client, {
      table: "audit_logs", where: "occurred_at IS NOT NULL AND occurred_at::timestamptz < $3::timestamptz",
      params: [cutoff(now, p.auditLogsDays)], archiveDays: p.auditAndPaymentArchiveDays, now,
    });
    const paymentExpiry = new Date(now.getTime() + p.auditAndPaymentArchiveDays * 86400_000).toISOString();
    counts.paymentsArchived = (await client.query(`
      INSERT INTO retention_archives (source_table, source_key, record, expires_at)
      SELECT 'payments', id, to_jsonb(payments), $1::timestamptz FROM payments
      WHERE (payload->>'createdAt')::timestamptz < $2::timestamptz
      ON CONFLICT (source_table, source_key) DO NOTHING RETURNING 1
    `, [paymentExpiry, cutoff(now, p.paymentsOnlineDays)])).rowCount;
    counts.customersFlagged = (await client.query(`
      INSERT INTO retention_reviews (review_type, source_id, reason)
      SELECT 'dormant_customer', c.id, 'No active voucher or dashboard session after retention threshold'
      FROM customers c WHERE (c.payload->>'createdAt')::timestamptz < $1::timestamptz
      AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.customer_id = c.id AND v.payload->>'status' = 'active')
      AND NOT EXISTS (SELECT 1 FROM dashboard_sessions s WHERE s.customer_id = c.id)
      ON CONFLICT (review_type, source_id) DO UPDATE SET last_flagged_at = NOW()
      RETURNING 1
    `, [cutoff(now, p.dormantCustomerReviewDays)])).rowCount;
    counts.expiredArchives = (await client.query(
      "DELETE FROM retention_archives WHERE expires_at < $1::timestamptz RETURNING 1",
      [now.toISOString()],
    )).rowCount;
    await client.query(
      "INSERT INTO retention_job_runs (started_at, status, counts) VALUES ($1, 'completed', $2::jsonb)",
      [now.toISOString(), JSON.stringify(counts)],
    );
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
