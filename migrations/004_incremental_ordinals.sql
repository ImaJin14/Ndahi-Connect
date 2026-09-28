BEGIN;
-- PERF-002: the store writes only changed rows. Prepended rows receive an ordinal
-- below the current minimum instead of renumbering the whole table, so ordinals
-- may be negative. Reads still use ORDER BY ordinal, id.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_ordinal_check;
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_ordinal_check;
ALTER TABLE bundles DROP CONSTRAINT IF EXISTS bundles_ordinal_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_ordinal_check;
ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_ordinal_check;
ALTER TABLE network_sessions DROP CONSTRAINT IF EXISTS network_sessions_ordinal_check;
ALTER TABLE dashboard_sessions DROP CONSTRAINT IF EXISTS dashboard_sessions_ordinal_check;
ALTER TABLE admin_sessions DROP CONSTRAINT IF EXISTS admin_sessions_ordinal_check;
ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_ordinal_check;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_ordinal_check;
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_ordinal_check;
CREATE INDEX IF NOT EXISTS events_kind_ordinal_idx ON events(kind, ordinal, id);
COMMIT;
