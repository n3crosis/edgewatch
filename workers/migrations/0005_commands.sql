-- Artisan command runs (Nightwatch `command` records), one row per run. The run is also a trace row.
CREATE TABLE commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id    TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  name        TEXT NOT NULL,
  command     TEXT,
  exit_code   INTEGER,
  duration_ms REAL NOT NULL DEFAULT 0,
  user        TEXT,
  server      TEXT
);

CREATE INDEX commands_project_time ON commands (project_id, timestamp DESC);
CREATE INDEX commands_project_name ON commands (project_id, name, timestamp DESC);
CREATE INDEX commands_time ON commands (timestamp);
