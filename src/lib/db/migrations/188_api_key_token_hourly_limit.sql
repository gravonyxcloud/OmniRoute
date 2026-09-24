-- Per-key token limits: allow the "hourly" reset interval used by plan keys
-- (default 80M tokens/hour). SQLite cannot alter a CHECK constraint, so the
-- limits table is rebuilt with the widened check.
--
-- The rebuild also recreates the two child tables (api_key_token_counters and
-- api_key_token_limit_reset_logs). SQLite's ALTER TABLE RENAME rewrites foreign
-- keys that point at the renamed table, and this build enforces PRAGMA
-- foreign_keys=ON — leaving the children pointing at api_key_token_limits_old_183
-- after the parent drop makes every INSERT/DELETE on them fail at prepare with
-- "no such table: ..._old_183". Children are rebuilt BEFORE the old parent is
-- dropped so their FK resolves to the fresh parent table.
--
-- Column order and constraints are preserved so the round-trip copies work.
ALTER TABLE api_key_token_limits RENAME TO api_key_token_limits_old_183;

CREATE TABLE api_key_token_limits (
  id              TEXT PRIMARY KEY,
  api_key_id      TEXT NOT NULL,
  scope_type      TEXT NOT NULL CHECK (scope_type IN ('model', 'provider', 'global')),
  scope_value     TEXT NOT NULL DEFAULT '',
  token_limit     INTEGER NOT NULL CHECK (token_limit > 0),
  reset_interval  TEXT NOT NULL DEFAULT 'monthly' CHECK (reset_interval IN ('daily', 'weekly', 'monthly', 'hourly')),
  reset_time      TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (api_key_id, scope_type, scope_value)
);

INSERT INTO api_key_token_limits
  (id, api_key_id, scope_type, scope_value, token_limit, reset_interval, reset_time, enabled, created_at, updated_at)
SELECT id, api_key_id, scope_type, scope_value, token_limit, reset_interval, reset_time, enabled, created_at, updated_at
FROM api_key_token_limits_old_183;

ALTER TABLE api_key_token_counters RENAME TO api_key_token_counters_old_183;

CREATE TABLE api_key_token_counters (
  limit_id      TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  tokens_used   INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (limit_id, window_start),
  FOREIGN KEY (limit_id) REFERENCES api_key_token_limits (id) ON DELETE CASCADE
);

INSERT INTO api_key_token_counters (limit_id, window_start, tokens_used, updated_at)
SELECT c.limit_id, c.window_start, c.tokens_used, c.updated_at
FROM api_key_token_counters_old_183 c
WHERE c.limit_id IN (SELECT id FROM api_key_token_limits);

DROP TABLE api_key_token_counters_old_183;

ALTER TABLE api_key_token_limit_reset_logs RENAME TO api_key_token_limit_reset_logs_old_183;

CREATE TABLE api_key_token_limit_reset_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  limit_id      TEXT NOT NULL,
  reset_at      TEXT NOT NULL DEFAULT (datetime('now')),
  prev_tokens   INTEGER NOT NULL DEFAULT 0,
  window_start  TEXT NOT NULL,
  FOREIGN KEY (limit_id) REFERENCES api_key_token_limits (id) ON DELETE CASCADE
);

INSERT INTO api_key_token_limit_reset_logs (id, limit_id, reset_at, prev_tokens, window_start)
SELECT r.id, r.limit_id, r.reset_at, r.prev_tokens, r.window_start
FROM api_key_token_limit_reset_logs_old_183 r
WHERE r.limit_id IN (SELECT id FROM api_key_token_limits);

DROP TABLE api_key_token_limit_reset_logs_old_183;

DROP TABLE api_key_token_limits_old_183;

CREATE INDEX idx_aktl_api_key_id ON api_key_token_limits (api_key_id);

CREATE INDEX idx_aktlrl_limit_id ON api_key_token_limit_reset_logs (limit_id);