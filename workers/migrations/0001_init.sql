-- EdgeWatch metadata schema (D1). Raw records live in R2 at traces/{project_id}/{date}/{trace_id}.json.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE traces (
  project_id       TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id         TEXT    NOT NULL,
  timestamp        INTEGER NOT NULL, -- unix ms
  date             TEXT    NOT NULL, -- YYYY-MM-DD (UTC), part of the R2 key
  execution_source TEXT    NOT NULL, -- request | command | job | schedule | <record type>
  name             TEXT    NOT NULL,
  method           TEXT,
  url              TEXT,
  route            TEXT,
  status_code      INTEGER,
  duration_ms      REAL    NOT NULL DEFAULT 0,
  query_count      INTEGER NOT NULL DEFAULT 0,
  exception_count  INTEGER NOT NULL DEFAULT 0,
  server           TEXT,
  deploy           TEXT,
  user             TEXT,
  r2_key           TEXT    NOT NULL,
  PRIMARY KEY (project_id, trace_id)
);
CREATE INDEX traces_project_time ON traces (project_id, timestamp DESC, trace_id DESC);
CREATE INDEX traces_project_source_time ON traces (project_id, execution_source, timestamp DESC);

CREATE TABLE exceptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id    TEXT    NOT NULL,
  group_hash  TEXT    NOT NULL, -- sha256(class,code,file,line)[:32]
  class       TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  code        TEXT,
  file        TEXT    NOT NULL,
  line        INTEGER NOT NULL,
  handled     INTEGER NOT NULL DEFAULT 0,
  stack       TEXT, -- JSON [{file, source, code}]
  timestamp   INTEGER NOT NULL, -- unix ms
  user        TEXT,
  server      TEXT
);
CREATE INDEX exceptions_project_time ON exceptions (project_id, timestamp DESC);
CREATE INDEX exceptions_project_group ON exceptions (project_id, group_hash, timestamp DESC);

CREATE TABLE queries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  trace_id    TEXT    NOT NULL,
  sql_hash    TEXT    NOT NULL, -- sha256(normalized sql)[:32]
  sql         TEXT    NOT NULL, -- normalized, literals stripped
  connection  TEXT,
  duration_ms REAL    NOT NULL,
  file        TEXT,
  line        INTEGER,
  timestamp   INTEGER NOT NULL -- unix ms
);
CREATE INDEX queries_project_time ON queries (project_id, timestamp DESC);
CREATE INDEX queries_project_hash ON queries (project_id, sql_hash, timestamp DESC);
CREATE INDEX queries_trace ON queries (project_id, trace_id);
