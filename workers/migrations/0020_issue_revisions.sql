-- Monotonic lifecycle revision prevents stale updates even after a status changes back.
ALTER TABLE issues ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
-- Identifies the winning mutation so its audit entry is inserted in the same transaction.
ALTER TABLE issues ADD COLUMN change_id TEXT;
