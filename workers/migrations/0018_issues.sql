-- Issue state outlives raw telemetry retention. Fingerprint v1 matches exception grouping.
CREATE TABLE issues (
  project_id TEXT NOT NULL,
  group_hash TEXT NOT NULL,
  fingerprint_version INTEGER NOT NULL DEFAULT 1,
  class TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (project_id, group_hash)
);
CREATE INDEX issues_project_status_seen ON issues (project_id, status, last_seen DESC);
CREATE TABLE issue_changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  group_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX issue_changes_project_group ON issue_changes (project_id, group_hash, timestamp);
INSERT INTO issues (project_id, group_hash, class, message, first_seen, last_seen)
SELECT project_id, group_hash, min(class), min(message), min(timestamp), max(timestamp)
FROM exceptions WHERE handled = 0 GROUP BY project_id, group_hash;
