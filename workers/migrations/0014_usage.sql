-- Usage metering and per-project settings.
-- usage_daily: records accepted per project per UTC day (counted by the consumer when a message is processed).
-- quota is the daily record quota in force at the last update (projects.daily_record_quota or the consumer's
-- DAILY_RECORD_QUOTA); blocked_at is set when the consumer wrote the over-quota block to KV for that day.
CREATE TABLE IF NOT EXISTS usage_daily (
  project_id TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  records    INTEGER NOT NULL DEFAULT 0,
  quota      INTEGER,
  blocked_at INTEGER,
  PRIMARY KEY (project_id, day)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily (day);

-- NULL = use the global default (DAILY_RECORD_QUOTA / RETENTION_DAYS); 0 = no quota / keep forever.
ALTER TABLE projects ADD COLUMN daily_record_quota INTEGER;
ALTER TABLE projects ADD COLUMN retention_days INTEGER;
