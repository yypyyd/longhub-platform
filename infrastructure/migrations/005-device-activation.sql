-- 首次授权码激活：设备注册只颁发待激活凭据，核销成功后才允许使用模型与产品 API。
CREATE TABLE IF NOT EXISTS activation_code (
  activation_code_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  max_uses INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  pack_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_uses > 0),
  CHECK (use_count >= 0 AND use_count <= max_uses)
);

ALTER TABLE device
  ADD COLUMN IF NOT EXISTS activation_code_id TEXT REFERENCES activation_code(activation_code_id);

ALTER TABLE device
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_device_activation_code ON device(activation_code_id);

ALTER TABLE entitlement
  ADD COLUMN IF NOT EXISTS source_activation_code_id TEXT REFERENCES activation_code(activation_code_id);

CREATE INDEX IF NOT EXISTS idx_entitlement_activation_code ON entitlement(source_activation_code_id);
