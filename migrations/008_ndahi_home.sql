-- Additive Home state is stored in existing normalized JSON payload tables.
-- Global transactions serialize link claims; database indexes defend uniqueness too.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS home_active_mac_unique
ON events ((payload->>'mac'))
WHERE kind = 'home_connection' AND payload->>'status' IN ('linked', 'reserved', 'retiring');
CREATE UNIQUE INDEX IF NOT EXISTS home_linked_customer_unique
ON events ((payload->>'customerId'))
WHERE kind = 'home_connection' AND payload->>'status' = 'linked';
CREATE INDEX IF NOT EXISTS home_operations_due
ON events ((payload->>'nextAttemptAt')) WHERE kind = 'home_operation';
COMMIT;
