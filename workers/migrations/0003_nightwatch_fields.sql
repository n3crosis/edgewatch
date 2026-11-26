-- Nightwatch fields that were only kept in the raw R2 trace until now.
-- request/command/job-attempt/scheduled-task records: peak_memory_usage (bytes), lazy_loads (Eloquent N+1 signal),
-- route_action (controller@method), status (job-attempt: processed|released|failed; scheduled-task: processed|skipped|failed).
ALTER TABLE traces ADD COLUMN peak_memory_usage INTEGER;
ALTER TABLE traces ADD COLUMN lazy_loads INTEGER;
ALTER TABLE traces ADD COLUMN route_action TEXT;
ALTER TABLE traces ADD COLUMN status TEXT;

-- `user` records (id, name, username) carry no trace_id; they describe the user referenced by other records' `user` field.
CREATE TABLE users (
  project_id  TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  id          TEXT    NOT NULL,
  name        TEXT,
  username    TEXT,
  last_seen   INTEGER NOT NULL, -- unix ms
  PRIMARY KEY (project_id, id)
);
