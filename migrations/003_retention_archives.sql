BEGIN;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_payload_check;
ALTER TABLE events ADD CONSTRAINT events_payload_check
  CHECK (jsonb_typeof(payload) IN ('object', 'string'));

CREATE TABLE IF NOT EXISTS retention_archives (
  source_table TEXT NOT NULL,
  source_key TEXT NOT NULL,
  record JSONB NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_table, source_key)
);
CREATE INDEX IF NOT EXISTS retention_archives_expiry_idx
  ON retention_archives(expires_at);

CREATE TABLE IF NOT EXISTS retention_reviews (
  review_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  first_flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (review_type, source_id)
);

CREATE TABLE IF NOT EXISTS retention_job_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  counts JSONB NOT NULL
);
COMMIT;
