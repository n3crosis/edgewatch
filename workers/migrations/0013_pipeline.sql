-- Pipeline self-observability: messages that exhausted their retries (stored by the consumer's DLQ handler so they can
-- be inspected and replayed) and per-minute consumer stats (throughput, retries, queue lag).
CREATE TABLE IF NOT EXISTS dead_letters (
  id                  TEXT    PRIMARY KEY, -- queue message id
  project_id          TEXT    NOT NULL,
  trace_id            TEXT,
  received_at         INTEGER NOT NULL, -- unix ms, when ingest accepted the batch
  failed_at           INTEGER NOT NULL, -- unix ms, when it reached the DLQ
  record_count        INTEGER NOT NULL DEFAULT 0,
  r2_key              TEXT    NOT NULL, -- dead/<project>/<id>.json: the IngestMessage with its records inlined
  replay_requested_at INTEGER,
  replay_attempts     INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_failed ON dead_letters (failed_at);
CREATE INDEX IF NOT EXISTS idx_dead_letters_project ON dead_letters (project_id, failed_at);
CREATE INDEX IF NOT EXISTS idx_dead_letters_replay ON dead_letters (replay_requested_at) WHERE replay_requested_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS pipeline_minutes (
  minute     INTEGER PRIMARY KEY, -- unix ms, start of the minute
  batches    INTEGER NOT NULL DEFAULT 0,
  messages   INTEGER NOT NULL DEFAULT 0,
  retried    INTEGER NOT NULL DEFAULT 0,
  max_lag_ms INTEGER NOT NULL DEFAULT 0 -- oldest message in a batch: consumer start minus enqueue time
);

-- Last time each alert fired, so the webhook is sent at most once per ALERT_INTERVAL.
CREATE TABLE IF NOT EXISTS alerts_sent (
  event   TEXT    PRIMARY KEY,
  sent_at INTEGER NOT NULL
);
