-- Nightwatch job records: `job-attempt` (a worker ran the job: status processed | released | failed, attempt number)
-- and `queued-job` (the job was dispatched). Both carry queue/connection and a duration in microseconds.
CREATE TABLE job_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id    TEXT    NOT NULL,
  timestamp   INTEGER NOT NULL, -- unix ms
  kind        TEXT    NOT NULL, -- attempt | queued
  name        TEXT    NOT NULL,
  job_id      TEXT,
  connection  TEXT,
  queue       TEXT,
  attempt     INTEGER,
  status      TEXT,             -- attempts only
  duration_ms REAL    NOT NULL DEFAULT 0,
  user        TEXT,
  server      TEXT
);
CREATE INDEX job_attempts_project_time ON job_attempts (project_id, timestamp DESC);
CREATE INDEX job_attempts_project_name ON job_attempts (project_id, name, timestamp DESC);
