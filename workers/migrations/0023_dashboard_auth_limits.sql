CREATE TABLE dashboard_auth_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX dashboard_auth_limits_expiry ON dashboard_auth_limits(expires_at);
