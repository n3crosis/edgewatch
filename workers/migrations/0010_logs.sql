-- Application logs (Nightwatch `log` records). message and context are PII-scrubbed and truncated (4096 / 2048 characters).
CREATE TABLE logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id    TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  level       TEXT NOT NULL,
  message     TEXT NOT NULL,
  context     TEXT,
  user        TEXT,
  server      TEXT
);

CREATE INDEX logs_project_time ON logs (project_id, timestamp DESC);
CREATE INDEX logs_project_level ON logs (project_id, level, timestamp DESC);
CREATE INDEX logs_time ON logs (timestamp);
