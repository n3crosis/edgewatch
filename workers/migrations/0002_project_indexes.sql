-- Multi-project hardening. Every hot query filters on project_id first (see workers/api); 0001 already has
-- (project_id, timestamp) indexes on traces, exceptions and queries. This adds the remaining per-project lookups:
-- exception rows by trace (trace detail / occurrences join), traces by status for ?status= filters, and
-- per-project retention deletes by timestamp on exceptions/queries without a project prefix.
CREATE INDEX IF NOT EXISTS exceptions_trace ON exceptions (project_id, trace_id);
CREATE INDEX IF NOT EXISTS traces_project_status_time ON traces (project_id, status_code, timestamp DESC);
CREATE INDEX IF NOT EXISTS traces_time ON traces (timestamp);
CREATE INDEX IF NOT EXISTS exceptions_time ON exceptions (timestamp);
CREATE INDEX IF NOT EXISTS queries_time ON queries (timestamp);
