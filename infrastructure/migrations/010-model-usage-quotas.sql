ALTER TABLE model_gateway_config
  ADD COLUMN IF NOT EXISTS device_requests_per_minute INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS device_daily_tokens BIGINT NOT NULL DEFAULT 1000000,
  ADD COLUMN IF NOT EXISTS tenant_monthly_tokens BIGINT NOT NULL DEFAULT 100000000,
  ADD COLUMN IF NOT EXISTS max_device_concurrency INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS input_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS model_usage_aggregate (
  period_start DATE NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('day', 'month')),
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  request_count BIGINT NOT NULL CHECK (request_count >= 0),
  success_count BIGINT NOT NULL CHECK (success_count >= 0),
  error_count BIGINT NOT NULL CHECK (error_count >= 0),
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  cache_tokens BIGINT NOT NULL CHECK (cache_tokens >= 0),
  estimated_tokens BIGINT NOT NULL CHECK (estimated_tokens >= 0),
  cost_microunits BIGINT NOT NULL CHECK (cost_microunits >= 0),
  PRIMARY KEY (period_start, period, tenant_id, device_id, config_id)
);
