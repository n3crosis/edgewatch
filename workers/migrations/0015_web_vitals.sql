-- Core Web Vitals per page view (EdgeWatch browser extension: `web-vital` records from @edgewatch/browser).
CREATE TABLE IF NOT EXISTS web_vitals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id    TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  path        TEXT NOT NULL,
  lcp_ms      REAL,
  inp_ms      REAL,
  cls         REAL,
  fcp_ms      REAL,
  ttfb_ms     REAL,
  user        TEXT,
  server      TEXT
);

CREATE INDEX IF NOT EXISTS web_vitals_project_time ON web_vitals (project_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS web_vitals_project_path ON web_vitals (project_id, path, timestamp DESC);
CREATE INDEX IF NOT EXISTS web_vitals_project_trace ON web_vitals (project_id, trace_id);
CREATE INDEX IF NOT EXISTS web_vitals_path ON web_vitals (path, timestamp DESC);
CREATE INDEX IF NOT EXISTS web_vitals_time ON web_vitals (timestamp);
