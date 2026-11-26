-- Indexes for API reads without a project filter (one key reads every project), the Users pages, retention on
-- job_attempts, and the consumer's per-trace child-row rebuild. Checked by scripts/d1-indexes.test.ts.
CREATE INDEX IF NOT EXISTS job_attempts_time ON job_attempts (timestamp);
CREATE INDEX IF NOT EXISTS traces_project_user ON traces (project_id, user, timestamp DESC) WHERE user > '';
CREATE INDEX IF NOT EXISTS traces_user ON traces (user, timestamp DESC) WHERE user > '';
CREATE INDEX IF NOT EXISTS exceptions_group ON exceptions (group_hash, timestamp DESC);
CREATE INDEX IF NOT EXISTS queries_hash ON queries (sql_hash, timestamp DESC);
CREATE INDEX IF NOT EXISTS job_attempts_name ON job_attempts (name, timestamp DESC);
CREATE INDEX IF NOT EXISTS commands_name ON commands (name, timestamp DESC);
CREATE INDEX IF NOT EXISTS cache_events_key ON cache_events (key, timestamp DESC);
CREATE INDEX IF NOT EXISTS outgoing_requests_host ON outgoing_requests (host, timestamp DESC);
CREATE INDEX IF NOT EXISTS mail_class ON mail (class, timestamp DESC);
CREATE INDEX IF NOT EXISTS notifications_class ON notifications (class, timestamp DESC);
CREATE INDEX IF NOT EXISTS scheduled_tasks_name ON scheduled_tasks (name, timestamp DESC);
CREATE INDEX IF NOT EXISTS logs_level ON logs (level, timestamp DESC);
CREATE INDEX IF NOT EXISTS job_attempts_trace ON job_attempts (project_id, trace_id);
CREATE INDEX IF NOT EXISTS commands_trace ON commands (project_id, trace_id);
CREATE INDEX IF NOT EXISTS cache_events_trace ON cache_events (project_id, trace_id);
CREATE INDEX IF NOT EXISTS outgoing_requests_trace ON outgoing_requests (project_id, trace_id);
CREATE INDEX IF NOT EXISTS mail_trace ON mail (project_id, trace_id);
CREATE INDEX IF NOT EXISTS notifications_trace ON notifications (project_id, trace_id);
CREATE INDEX IF NOT EXISTS scheduled_tasks_trace ON scheduled_tasks (project_id, trace_id);
CREATE INDEX IF NOT EXISTS logs_trace ON logs (project_id, trace_id);
CREATE INDEX IF NOT EXISTS traces_trace ON traces (trace_id);
