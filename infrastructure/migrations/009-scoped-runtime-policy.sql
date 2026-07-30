-- LH-050-01：把默认模型配置扩展为严格的 global/tenant/plan/device 运行策略。
ALTER TABLE model_gateway_config
  ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT '-',
  ADD COLUMN IF NOT EXISTS emergency_disabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fallback_config_id TEXT,
  ADD COLUMN IF NOT EXISTS request_timeout_ms INTEGER NOT NULL DEFAULT 300000,
  ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS circuit_breaker_threshold INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS circuit_breaker_cooldown_ms INTEGER NOT NULL DEFAULT 60000,
  ADD COLUMN IF NOT EXISTS min_desktop_version TEXT NOT NULL DEFAULT '0.0.0',
  ADD COLUMN IF NOT EXISTS max_desktop_version TEXT,
  ADD COLUMN IF NOT EXISTS assistant_name TEXT NOT NULL DEFAULT '龙枢助手',
  ADD COLUMN IF NOT EXISTS assistant_avatar_path TEXT NOT NULL DEFAULT '/assets/longhub-avatar.png',
  ADD COLUMN IF NOT EXISTS welcome_message TEXT NOT NULL DEFAULT '你好，我是龙枢助手。',
  ADD COLUMN IF NOT EXISTS quick_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{"agent_catalog":true,"file_upload":true,"tool_execution":true}'::jsonb;
  

ALTER TABLE model_gateway_config
  DROP CONSTRAINT IF EXISTS model_gateway_config_scope_type_check,
  ADD CONSTRAINT model_gateway_config_scope_type_check CHECK (scope_type IN ('global', 'tenant', 'plan', 'device')),
  DROP CONSTRAINT IF EXISTS model_gateway_config_scope_id_check,
  ADD CONSTRAINT model_gateway_config_scope_id_check CHECK (scope_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  DROP CONSTRAINT IF EXISTS model_gateway_config_retry_check,
  ADD CONSTRAINT model_gateway_config_retry_check CHECK (
    request_timeout_ms BETWEEN 1000 AND 300000 AND max_retries BETWEEN 0 AND 2 AND
    circuit_breaker_threshold BETWEEN 1 AND 100 AND circuit_breaker_cooldown_ms BETWEEN 1000 AND 3600000
  );

CREATE INDEX IF NOT EXISTS idx_model_gateway_config_scope
  ON model_gateway_config(scope_type, scope_id, updated_at DESC);
