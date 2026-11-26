-- Key/value table for deployments without Workers KV (KEY_STORE=sql): API key records, audit entries and project
-- blocks, with the same names and JSON values as the API_KEYS namespace. Unused (empty) with the default KV store.
CREATE TABLE IF NOT EXISTS kv_store (
  name        TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  INTEGER
);

CREATE INDEX IF NOT EXISTS kv_store_expires ON kv_store (expires_at);
