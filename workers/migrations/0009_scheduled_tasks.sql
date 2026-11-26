-- Scheduled task runs (Nightwatch `scheduled-task` records). Each run is also a trace (execution_source = 'schedule').
CREATE TABLE scheduled_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id       TEXT NOT NULL,
  timestamp      INTEGER NOT NULL,
  name           TEXT NOT NULL,
  cron           TEXT,
  timezone       TEXT,
  repeat_seconds INTEGER,
  status         TEXT,
  duration_ms    REAL NOT NULL DEFAULT 0,
  user           TEXT,
  server         TEXT
);

CREATE INDEX scheduled_tasks_project_time ON scheduled_tasks (project_id, timestamp DESC);
CREATE INDEX scheduled_tasks_project_name ON scheduled_tasks (project_id, name, timestamp DESC);
CREATE INDEX scheduled_tasks_time ON scheduled_tasks (timestamp);
