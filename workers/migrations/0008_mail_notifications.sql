-- Mail (Nightwatch `mail` records): subject is PII-scrubbed and cut to 255 characters; recipients are counts only.
CREATE TABLE mail (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id    TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  mailer      TEXT,
  class       TEXT NOT NULL,
  subject     TEXT,
  to_count    INTEGER,
  cc_count    INTEGER,
  bcc_count   INTEGER,
  attachments INTEGER,
  duration_ms REAL NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  user        TEXT,
  server      TEXT
);

CREATE INDEX mail_project_time ON mail (project_id, timestamp DESC);
CREATE INDEX mail_project_class ON mail (project_id, class, timestamp DESC);
CREATE INDEX mail_time ON mail (timestamp);

-- Notifications (Nightwatch `notification` records), one row per channel delivery.
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id    TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  channel     TEXT,
  class       TEXT NOT NULL,
  duration_ms REAL NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  user        TEXT,
  server      TEXT
);

CREATE INDEX notifications_project_time ON notifications (project_id, timestamp DESC);
CREATE INDEX notifications_project_class ON notifications (project_id, class, timestamp DESC);
CREATE INDEX notifications_time ON notifications (timestamp);
