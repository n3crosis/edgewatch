-- Outgoing HTTP calls (Nightwatch `outgoing-request` records). `url` is PII-scrubbed, query string removed, cut to 2048 characters.
CREATE TABLE outgoing_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id      TEXT NOT NULL,
  timestamp     INTEGER NOT NULL,
  host          TEXT NOT NULL,
  method        TEXT NOT NULL,
  url           TEXT,
  status_code   INTEGER,
  duration_ms   REAL NOT NULL DEFAULT 0,
  request_size  INTEGER,
  response_size INTEGER,
  user          TEXT,
  server        TEXT
);

CREATE INDEX outgoing_requests_project_time ON outgoing_requests (project_id, timestamp DESC);
CREATE INDEX outgoing_requests_project_host ON outgoing_requests (project_id, host, timestamp DESC);
CREATE INDEX outgoing_requests_time ON outgoing_requests (timestamp);
