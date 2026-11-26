-- Atomic usage receipts prevent retry/redelivery from charging a message twice.
CREATE TABLE IF NOT EXISTS usage_receipts (
  project_id TEXT NOT NULL,
  receipt TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (project_id, receipt)
);
CREATE INDEX IF NOT EXISTS idx_usage_receipts_day ON usage_receipts (day);
