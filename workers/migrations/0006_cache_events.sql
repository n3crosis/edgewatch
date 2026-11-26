-- Cache operations (Nightwatch `cache-event` records). `key` is PII-scrubbed and truncated to 255 characters.
CREATE TABLE cache_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id    TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  store       TEXT,
  key         TEXT NOT NULL,
  type        TEXT NOT NULL,
  duration_ms REAL NOT NULL DEFAULT 0,
  ttl         INTEGER,
  user        TEXT,
  server      TEXT
);

CREATE INDEX cache_events_project_time ON cache_events (project_id, timestamp DESC);
CREATE INDEX cache_events_project_key ON cache_events (project_id, key, timestamp DESC);
CREATE INDEX cache_events_time ON cache_events (timestamp);
