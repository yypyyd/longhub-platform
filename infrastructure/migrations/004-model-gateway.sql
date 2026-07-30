-- 004：服务端固定模型网关配置
-- API Key 由 MODEL_CONFIG_KEY 使用 AES-256-GCM 加密后写入 encrypted_api_key。

CREATE TABLE IF NOT EXISTS model_gateway_config (
  config_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  api_type TEXT NOT NULL,
  context_window INTEGER NOT NULL,
  max_tokens INTEGER NOT NULL,
  encrypted_api_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
