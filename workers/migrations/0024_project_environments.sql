-- Configured environments per project (color, optional URL), merged with telemetry-discovered environments.
CREATE TABLE IF NOT EXISTS project_environments (
  project_id TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT 'blue',
  url        TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
