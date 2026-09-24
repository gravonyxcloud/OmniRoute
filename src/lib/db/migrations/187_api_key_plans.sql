-- API key plans: customer email, plan metadata, renewal counters and the
-- combos-only catalog scope. Plan keys are forced to combos-only via
-- catalog_scope to keep listing and dispatch aligned
-- (see apiKeyPolicy.validateModelAccess).
ALTER TABLE api_keys ADD COLUMN catalog_scope TEXT NOT NULL DEFAULT 'all' CHECK (catalog_scope IN ('all', 'combos', 'models'));
ALTER TABLE api_keys ADD COLUMN customer_email TEXT;
ALTER TABLE api_keys ADD COLUMN plan_id TEXT;
ALTER TABLE api_keys ADD COLUMN plan_days INTEGER;
ALTER TABLE api_keys ADD COLUMN plan_started_at TEXT;
ALTER TABLE api_keys ADD COLUMN renewals_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_api_keys_customer_email ON api_keys (customer_email);
CREATE INDEX IF NOT EXISTS idx_api_keys_plan_id ON api_keys (plan_id);