-- laravel/nightwatch job attempts keep the trace_id of the request/command that dispatched them (propagated through the
-- job payload) and identify themselves by attempt_id / execution_id. Each attempt is stored as its own trace row, keyed
-- by its execution id; origin_trace_id keeps the dispatching trace so the two can be linked.
ALTER TABLE traces ADD COLUMN origin_trace_id TEXT;
CREATE INDEX traces_origin ON traces (project_id, origin_trace_id) WHERE origin_trace_id IS NOT NULL;
