-- Historical traces remain unknown; server and deployment names do not imply an environment.
ALTER TABLE traces ADD COLUMN environment TEXT;
CREATE INDEX traces_project_environment_time ON traces (project_id, environment, timestamp DESC, trace_id DESC);
